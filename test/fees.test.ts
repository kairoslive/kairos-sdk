import { test } from "node:test";
import assert from "node:assert/strict";

import { KairosError, SafetyCheckError, WalletClient, type FeeSettlement } from "../src/index.ts";
import { CHECKSUMMED, SIG, TOKEN, fakeFetch, fakeWallet, loginRoutes, type Call } from "./helpers.ts";

const W = CHECKSUMMED.toLowerCase();
const TX = "0x" + "ab".repeat(32);

const PUSD = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
const USDT = "0x55d398326f99059ff775485246999027b3197955";
const DEPOSIT = "0x1111111111111111111111111111111111111111";
const TREASURY = "0x3333333333333333333333333333333333333333";
const transfer = (to: string, amount: bigint) => "0xa9059cbb" + to.slice(2).padStart(64, "0") + amount.toString(16).padStart(64, "0");

/** The settlement as the server's view builds it, including its wallet request. */
function settlement(venue: "polymarket" | "predictfun", fields: Partial<FeeSettlement> = {}): FeeSettlement {
  const polymarket = venue === "polymarket";
  const token = polymarket ? PUSD : USDT;
  const data = transfer(TREASURY, 12500000n);
  const batch = {
    types: { EIP712Domain: [], Batch: [], Call: [] },
    domain: { name: "DepositWallet", version: "1", chainId: "137", verifyingContract: DEPOSIT },
    primaryType: "Batch",
    message: { wallet: DEPOSIT, nonce: "4", deadline: "1900000000", calls: [{ target: token, value: "0", data }] },
  };
  return {
    id: `s-${venue}`,
    venue,
    status: "awaiting_signature",
    holdingWallet: polymarket ? DEPOSIT : W,
    assetKey: `evm:${polymarket ? 137 : 56}:${token}`,
    chainId: polymarket ? "137" : "56",
    token,
    treasury: TREASURY,
    decimals: polymarket ? 6 : 18,
    amountRaw: "12500000",
    transactionHash: null,
    expiresAt: polymarket ? "2030-03-17T17:46:40Z" : null,
    failure: null,
    walletRequest: polymarket
      ? { kind: "signature", chainId: "0x89", request: { method: "eth_signTypedData_v4", params: [W, JSON.stringify(batch)] } }
      : { kind: "transaction", chainId: "0x38", request: { method: "eth_sendTransaction", params: [{ from: W, to: token, value: "0x0", data, chainId: "0x38" }] } },
    ...fields,
  };
}

/** A settlement server: create, answer, then `submitted` reads until the third, which is `confirmed`. */
function settlementRoutes(venue: "polymarket" | "predictfun", edit: (s: FeeSettlement) => void = () => {}) {
  let reads = 0;
  const created = () => {
    const s = settlement(venue);
    edit(s);
    return s;
  };
  return [
    (c: Call) => (c.method === "POST" && c.path === "/v3/fees/settlements" && (c.body as { venue: string }).venue === venue ? ([200, created()] as [number, unknown]) : undefined),
    (c: Call) => (c.method === "POST" && c.path === `/v3/fees/settlements/s-${venue}/answer` ? ([200, settlement(venue, { status: "submitted", walletRequest: null })] as [number, unknown]) : undefined),
    (c: Call) =>
      c.method === "GET" && c.path === `/v3/fees/settlements/s-${venue}`
        ? ([200, settlement(venue, { status: ++reads < 2 ? "submitted" : "confirmed", walletRequest: null, transactionHash: TX })] as [number, unknown])
        : undefined,
  ];
}

const client = (impl: typeof fetch | ((url: string, init?: RequestInit) => Promise<Response>), provider = fakeWallet().provider) =>
  new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider, fetch: impl, pollIntervalMs: 1 });

test("fees.summary: lowercase wallet in the query, signed in with the wallet's token", async () => {
  const summary = { venues: [{ venue: "polymarket", holdingWallet: "0x1", assetKey: "evm:137:0xc011", decimals: 6, owedRaw: "-250000", thresholdRaw: "10000000", settlement: null }] };
  const { impl, calls } = fakeFetch([...loginRoutes(), (c) => (c.path === "/v3/fees" ? [200, summary] : undefined)]);
  const wallet = fakeWallet();
  const fees = client(impl, wallet.provider).fees;
  assert.deepEqual(await fees.summary(CHECKSUMMED), summary);
  const read = calls.find((c) => c.path === "/v3/fees")!;
  assert.equal(read.url, `https://exec.test/v3/fees?wallet=${W}`);
  assert.equal(read.headers.authorization, `SIWE ${TOKEN.token}`);
  assert.equal(read.headers["x-kairos-partner-id"], "acme");
  assert.deepEqual(wallet.methods(), ["personal_sign"]);
});

test("fees.settle on Polymarket: signs the batch on Polygon, answers with the signature, reads until confirmed", async () => {
  const { impl, calls } = fakeFetch([...loginRoutes(), ...settlementRoutes("polymarket")]);
  const wallet = fakeWallet();
  const done = await client(impl, wallet.provider).fees.settle(CHECKSUMMED, "polymarket");

  assert.equal(done.status, "confirmed");
  assert.equal(done.transactionHash, TX);
  assert.deepEqual(wallet.methods(), ["personal_sign", "eth_chainId", "wallet_switchEthereumChain", "eth_signTypedData_v4"]);
  assert.deepEqual(wallet.requests[2].params, [{ chainId: "0x89" }]);
  assert.deepEqual(wallet.requests[3], settlement("polymarket").walletRequest!.request);
  assert.deepEqual(calls.find((c) => c.path === "/v3/fees/settlements")!.body, { wallet: W, venue: "polymarket" });
  assert.deepEqual(calls.find((c) => c.path.endsWith("/answer"))!.body, { wallet: W, signature: SIG });
  const reads = calls.filter((c) => c.method === "GET" && c.path === "/v3/fees/settlements/s-polymarket");
  assert.equal(reads.length, 2);
  assert.ok(reads[0].url.endsWith(`?wallet=${W}`));
  for (const c of calls.filter((c) => c.path.startsWith("/v3/fees"))) assert.equal(c.headers.authorization, `SIWE ${TOKEN.token}`);
});

test("fees.settle on Predict.fun: sends the transfer on BNB Chain and answers with its hash", async () => {
  const { impl, calls } = fakeFetch([...loginRoutes(), ...settlementRoutes("predictfun")]);
  const wallet = fakeWallet({ eth_sendTransaction: () => TX });
  const done = await client(impl, wallet.provider).fees.settle(CHECKSUMMED, "predictfun");

  assert.equal(done.status, "confirmed");
  assert.deepEqual(wallet.methods(), ["personal_sign", "eth_chainId", "wallet_switchEthereumChain", "eth_sendTransaction"]);
  assert.deepEqual(wallet.requests[2].params, [{ chainId: "0x38" }]);
  assert.deepEqual(calls.find((c) => c.path.endsWith("/answer"))!.body, { wallet: W, transactionHash: TX });
});

test("fees.settle: an open settlement already submitted is only read until final", async () => {
  const { impl, calls } = fakeFetch([
    ...loginRoutes(),
    (c) => (c.method === "POST" && c.path === "/v3/fees/settlements" ? [200, settlement("polymarket", { status: "submitted", walletRequest: null })] : undefined),
    (c) => (c.method === "GET" ? [200, settlement("polymarket", { status: "failed", walletRequest: null, failure: "the relayer refused the batch" })] : undefined),
  ]);
  const wallet = fakeWallet();
  const done = await client(impl, wallet.provider).fees.settle(CHECKSUMMED, "polymarket");
  assert.equal(done.status, "failed");
  assert.equal(done.failure, "the relayer refused the batch");
  assert.ok(!calls.some((c) => c.path.endsWith("/answer")));
  assert.deepEqual(wallet.methods(), ["personal_sign"]);
});

test("fees.settleAll: settles each venue that owes something, skips credits and zero", async () => {
  const venue = (v: string, owedRaw: string) => ({ venue: v, holdingWallet: W, assetKey: "k", decimals: 6, owedRaw, thresholdRaw: "10000000", settlement: null });
  const { impl, calls } = fakeFetch([
    ...loginRoutes(),
    (c) => (c.path === "/v3/fees" ? [200, { venues: [venue("polymarket", "-250000"), venue("predictfun", "3")] }] : undefined),
    ...settlementRoutes("predictfun"),
  ]);
  const done = await client(impl, fakeWallet({ eth_sendTransaction: () => TX }).provider).fees.settleAll(CHECKSUMMED);
  assert.deepEqual(done.map((s) => [s.venue, s.status]), [["predictfun", "confirmed"]]);
  assert.deepEqual(calls.filter((c) => c.path === "/v3/fees/settlements").map((c) => (c.body as { venue: string }).venue), ["predictfun"]);
});

test("fees: nothing owed surfaces as a 409 KairosError", async () => {
  const { impl } = fakeFetch([...loginRoutes(), (c) => (c.path === "/v3/fees/settlements" ? [409, { error: "this wallet has no unpaid fees" }] : undefined)]);
  await assert.rejects(client(impl).fees.settle(CHECKSUMMED, "polymarket"), (e: unknown) => e instanceof KairosError && e.status === 409 && !e.outcomeUnknown);
});

test("fees.settle: refuses, before the wallet is asked, a request that is not one transfer of the owed amount to the treasury", async () => {
  const doc = (s: FeeSettlement) => JSON.parse(s.walletRequest!.request.params[1] as string);
  const setDoc = (s: FeeSettlement, d: unknown) => (s.walletRequest!.request.params[1] = JSON.stringify(d));
  const tx = (s: FeeSettlement) => s.walletRequest!.request.params[0] as Record<string, unknown>;
  const cases: ["polymarket" | "predictfun", string, (s: FeeSettlement) => void][] = [
    ["polymarket", "extra call", (s) => { const d = doc(s); d.message.calls.push({ target: PUSD, value: "0", data: transfer("0x" + "66".repeat(20), 1n) }); setDoc(s, d); }],
    ["polymarket", "amount", (s) => { const d = doc(s); d.message.calls[0].data = transfer(TREASURY, 99999999n); setDoc(s, d); }],
    ["polymarket", "payee", (s) => { const d = doc(s); d.message.calls[0].data = transfer("0x" + "66".repeat(20), 12500000n); setDoc(s, d); }],
    ["polymarket", "other wallet's batch", (s) => { const d = doc(s); d.domain.verifyingContract = "0x" + "77".repeat(20); setDoc(s, d); }],
    ["polymarket", "token", (s) => (s.token = "0x" + "44".repeat(20))],
    ["polymarket", "chain", (s) => (s.walletRequest!.chainId = "0x1")],
    ["predictfun", "to", (s) => (tx(s).to = "0x" + "44".repeat(20))],
    ["predictfun", "value", (s) => (tx(s).value = "0x1")],
    ["predictfun", "data", (s) => (tx(s).data = transfer("0x" + "66".repeat(20), 12500000n))],
    ["predictfun", "from", (s) => (tx(s).from = "0x" + "88".repeat(20))],
  ];
  for (const [venue, what, edit] of cases) {
    const { impl, calls } = fakeFetch([...loginRoutes(), ...settlementRoutes(venue, edit)]);
    const wallet = fakeWallet({ eth_sendTransaction: () => TX });
    await assert.rejects(client(impl, wallet.provider).fees.settle(CHECKSUMMED, venue), (e: unknown) => e instanceof SafetyCheckError, what);
    assert.deepEqual(wallet.methods(), ["personal_sign"], `${what}: the wallet was not asked`);
    assert.ok(!calls.some((c) => c.path.endsWith("/answer")), what);
  }
});

test("fees.wait: a dropped read while confirming is retried, not thrown", async () => {
  let reads = 0;
  const { impl } = fakeFetch([
    ...loginRoutes(),
    ...settlementRoutes("polymarket").slice(0, 2),
    (c) => (c.method === "GET" && c.path === "/v3/fees/settlements/s-polymarket" ? (++reads === 1 ? [503, { error: "unavailable" }] : [200, settlement("polymarket", { status: "confirmed", walletRequest: null })]) : undefined),
  ]);
  const flaky: typeof impl = async (url, init) => {
    if (init?.method === "GET" && url.includes("/settlements/") && reads === 0 && !(flaky as { dropped?: boolean }).dropped) {
      (flaky as { dropped?: boolean }).dropped = true;
      throw new TypeError("fetch failed");
    }
    return impl(url, init);
  };
  const done = await client(flaky).fees.settle(CHECKSUMMED, "polymarket");
  assert.equal(done.status, "confirmed");
  assert.equal(reads, 2, "one 503, then confirmed");
});
