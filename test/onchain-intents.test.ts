import { test } from "node:test";
import assert from "node:assert/strict";

import { SafetyCheckError, WalletClient, type OnchainIntentView } from "../src/index.ts";
import { CHECKSUMMED, TOKEN, fakeFetch, fakeWallet, loginRoutes, type Call } from "./helpers.ts";

const W = CHECKSUMMED.toLowerCase();
const DEPOSIT = "0xDdDd000000000000000000000000000000000002";
const D = DEPOSIT.toLowerCase();
const CONDITION = "0x" + "01".repeat(32);
const HASH = "0x" + "9a".repeat(32);
const CONSENT_SIG = "0x" + "c1".repeat(65);
const NATIVE_SIG = "0x" + "d2".repeat(65);

function viewFor(body: Record<string, any>, status: OnchainIntentView["intent"]["status"] = "needs_signatures", edit: (v: OnchainIntentView) => void = () => {}): OnchainIntentView {
  const doc = (domain: Record<string, unknown>, message: Record<string, unknown>) => JSON.stringify({ domain, message, primaryType: "x", types: {} });
  const view: OnchainIntentView = {
    intent: {
      terms: {
        contractVersion: 1,
        id: "i1",
        partnerId: "acme",
        audience: "https://exec.test",
        executionRegion: "r",
        signer: body.wallet,
        account: body.account,
        chainId: "137",
        market: `polymarket:${CONDITION}`,
        operation: body.operation,
        submissionOwner: body.submissionOwner,
        submissionEndpoint: "https://submit.test/submit",
        batch: { factory: "0x00000000000fb5c9adea0298d729a0cb3823cc07", nonce: "3", deadline: body.executeBefore, calls: [] },
        effects: [
          { token: { kind: "erc20", contract: "0xc011" }, direction: "debit", amountRaw: body.amountRaw },
          { token: { kind: "erc1155", contract: "0x006f", tokenId: "1" }, direction: "credit", amountRaw: body.amountRaw },
          { token: { kind: "erc1155", contract: "0x006f", tokenId: "2" }, direction: "credit", amountRaw: body.amountRaw },
        ],
        dependencies: [],
        maxWalletGasCostRaw: "0",
        createdAt: "2026-10-28T12:00:00Z",
        executeBefore: body.executeBefore,
      },
      intentHash: HASH,
      status,
      committed: status !== "needs_signatures",
      dispatchClaimed: status === "reconciling" || status === "confirmed",
      transactionHash: null,
      proof: null,
    },
    consentRequest: { method: "eth_signTypedData_v4", params: [W, doc({ name: "KairosOnchainIntent", chainId: "137" }, { signer: W, intentId: "i1", intentHash: HASH })] },
    nativeRequest: { method: "eth_signTypedData_v4", params: [W, doc({ name: "DepositWallet", chainId: "137", verifyingContract: D }, { wallet: D, nonce: "3" })] },
    submission: { endpoint: "https://submit.test/submit", method: "POST", kind: "deposit_wallet_batch", body: {} },
  };
  edit(view);
  return view;
}

function intentServer(edit?: (v: OnchainIntentView) => void) {
  let body: Record<string, any> = {};
  let reads = 0;
  return fakeFetch([
    ...loginRoutes(),
    (c: Call) => (c.method === "GET" && c.path === `/v3/wallets/${W}` ? [200, { wallet: W, ready: true, next: null, tradingWallet: DEPOSIT, venues: { polymarket: { ready: true, next: null, balance: "5", tradingWallet: DEPOSIT } } }] : undefined),
    (c: Call) => (c.method === "POST" && c.path === "/v3/onchain-intents" ? [200, viewFor((body = c.body as Record<string, any>), "needs_signatures", edit)] : undefined),
    (c: Call) => (c.method === "POST" && c.path === "/v3/onchain-intents/i1/execute" ? [200, viewFor(body, "ready")] : undefined),
    (c: Call) => (c.method === "GET" && c.path === "/v3/onchain-intents/i1" ? [200, viewFor(body, ++reads < 2 ? "reconciling" : "confirmed")] : undefined),
  ]);
}

const signer = () => {
  let n = 0;
  return fakeWallet({ eth_signTypedData_v4: () => (++n === 1 ? CONSENT_SIG : NATIVE_SIG) });
};

const onchainWith = (impl: (url: string, init?: RequestInit) => Promise<Response>, provider = fakeWallet().provider) =>
  new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider, fetch: impl, pollIntervalMs: 1 }).onchain;

test("onchain.split: lowercase addresses, deposit wallet from status, Idempotency-Key, both signatures, Kairos submits, waits for confirmed", async () => {
  const { impl, calls } = intentServer();
  const wallet = signer();
  const before = Math.floor(Date.now() / 1000);
  const view = await onchainWith(impl, wallet.provider).split(CHECKSUMMED, CONDITION.toUpperCase().replace("0X", "0x"), 1_000_000n);

  assert.equal(view.intent.status, "confirmed");
  const prepare = calls.find((c) => c.path === "/v3/onchain-intents")!;
  const body = prepare.body as Record<string, any>;
  assert.match(prepare.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  assert.equal(prepare.headers.authorization, `SIWE ${TOKEN.token}`);
  assert.equal(body.wallet, W);
  assert.equal(body.account, D);
  assert.equal(body.operation, "split");
  assert.equal(body.amountRaw, "1000000");
  assert.equal(body.submissionOwner, "kairos");
  assert.equal(body.outcome, undefined);
  assert.deepEqual(body.dependencies, []);
  const deadline = Date.parse(body.executeBefore) / 1000;
  assert.ok(Number.isInteger(deadline) && deadline >= before + 239 && deadline <= before + 242);

  assert.deepEqual(wallet.methods(), ["personal_sign", "eth_chainId", "wallet_switchEthereumChain", "eth_signTypedData_v4", "eth_signTypedData_v4"]);
  assert.deepEqual(wallet.requests[2].params, [{ chainId: "0x89" }]);
  const execute = calls.filter((c) => c.path === "/v3/onchain-intents/i1/execute");
  assert.equal(execute.length, 1);
  assert.deepEqual(execute[0].body, { intentHash: HASH, consentSignature: CONSENT_SIG, nativeSignature: NATIVE_SIG });
  assert.equal(calls.filter((c) => c.method === "GET" && c.path === "/v3/onchain-intents/i1").length, 2);
});

test("onchain: refuses to sign an intent that debits a different amount or another account", async () => {
  for (const [what, edit] of [
    ["amount", (v: OnchainIntentView) => (v.intent.terms.effects[0].amountRaw = "2000000")],
    ["account", (v: OnchainIntentView) => (v.nativeRequest.params[1] = JSON.stringify({ domain: { verifyingContract: "0x" + "77".repeat(20) }, message: { wallet: D } }))],
    ["gas", (v: OnchainIntentView) => ((v.intent.terms as { maxWalletGasCostRaw: string }).maxWalletGasCostRaw = "1")],
  ] as const) {
    const { impl, calls } = intentServer(edit);
    const wallet = signer();
    await assert.rejects(onchainWith(impl, wallet.provider).merge(CHECKSUMMED, `polymarket:${CONDITION}`, "1000000", { account: DEPOSIT }), (e: unknown) => e instanceof SafetyCheckError, what);
    assert.ok(!wallet.methods().includes("eth_signTypedData_v4"), `${what}: nothing signed`);
    assert.ok(!calls.some((c) => c.path.endsWith("/execute")));
  }
});

test("onchain.prepare: redeem needs an outcome; amounts and markets are checked first", async () => {
  const { impl, calls } = intentServer();
  const onchain = onchainWith(impl);
  const base = { wallet: CHECKSUMMED, account: DEPOSIT, market: CONDITION, amountRaw: "5" };
  await assert.rejects(onchain.prepare({ ...base, operation: "redeem" }), /outcome is required/);
  await assert.rejects(onchain.prepare({ ...base, operation: "split", outcome: 1 }), /only for redeem/);
  await assert.rejects(onchain.prepare({ ...base, operation: "split", amountRaw: "1.5" }), /amountRaw/);
  await assert.rejects(onchain.prepare({ ...base, operation: "split", market: "predictfun:1" }), /Polymarket/);
  assert.equal(calls.length, 0);

  await onchain.prepare({ ...base, operation: "redeem", outcome: 0, submissionOwner: "client" }, { idempotencyKey: "k-9" });
  const sent = calls.find((c) => c.path === "/v3/onchain-intents")!;
  assert.equal(sent.headers["idempotency-key"], "k-9");
  assert.equal((sent.body as { outcome: number }).outcome, 0);
  assert.equal((sent.body as { submissionOwner: string }).submissionOwner, "client");
});

test("onchain.redeem: sends the outcome from options with Kairos submission", async () => {
  const { impl, calls } = intentServer((v) => {
    v.intent.terms.effects = [
      { token: { kind: "erc20", contract: "0xc011" }, direction: "credit", amountRaw: "1000000" },
      { token: { kind: "erc1155", contract: "0x006f", tokenId: "1" }, direction: "debit", amountRaw: "1000000" },
    ];
  });
  const view = await onchainWith(impl, signer().provider).redeem(CHECKSUMMED, CONDITION, "1000000", { outcome: 1, account: DEPOSIT });
  assert.equal(view.intent.status, "confirmed");
  const body = calls.find((c) => c.path === "/v3/onchain-intents")!.body as Record<string, unknown>;
  assert.equal(body.operation, "redeem");
  assert.equal(body.outcome, 1);
  assert.equal(body.submissionOwner, "kairos");
  assert.ok(!calls.some((c) => c.path.startsWith("/v3/wallets/")), "account given, no status read");
});

test("onchain.report lowercases the hash; execute and get carry the token", async () => {
  const { impl, calls } = fakeFetch([...loginRoutes(), () => [200, {}]]);
  const onchain = onchainWith(impl);
  await onchain.report("i1", CHECKSUMMED, { intentHash: HASH, transactionHash: "0x" + "AB".repeat(32) });
  await onchain.execute("i1", CHECKSUMMED, { intentHash: HASH, consentSignature: CONSENT_SIG });
  const report = calls.find((c) => c.path === "/v3/onchain-intents/i1/reports")!;
  assert.deepEqual(report.body, { intentHash: HASH, transactionHash: "0x" + "ab".repeat(32) });
  assert.deepEqual(calls.find((c) => c.path.endsWith("/execute"))!.body, { intentHash: HASH, consentSignature: CONSENT_SIG });
  for (const c of calls.filter((c) => c.path.startsWith("/v3/onchain"))) assert.equal(c.headers.authorization, `SIWE ${TOKEN.token}`);
});
