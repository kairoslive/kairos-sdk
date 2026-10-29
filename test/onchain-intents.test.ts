import { test } from "node:test";
import assert from "node:assert/strict";

import { SafetyCheckError, WalletClient, type OnchainCall, type OnchainIntentTerms, type OnchainIntentView } from "../src/index.ts";
import { intentConsentRequest, intentNativeRequest } from "../src/onchain-intents.ts";
import { valueHash } from "../src/common.ts";
import { keccak256, toHex, utf8 } from "../src/signing/keccak.ts";
import { CHECKSUMMED, TOKEN, fakeFetch, fakeWallet, loginRoutes, type Call } from "./helpers.ts";

const W = CHECKSUMMED.toLowerCase();
const DEPOSIT = "0xDdDd000000000000000000000000000000000002";
const D = DEPOSIT.toLowerCase();
const CONDITION = "0x" + "01".repeat(32);
const HASH = "0x" + "9a".repeat(32);
const ID = "00000000-0000-0000-0000-0000000000a1";
const CONSENT_SIG = "0x" + "c1".repeat(65);
const NATIVE_SIG = "0x" + "d2".repeat(65);

const PUSD = "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb";
const CTF = "0x4d97dcd97ec945f40cf65f87097ace5ea0476045";
const ADAPTER = "0xada100db00ca00073811820692005400218fce1f";
const ROUTER = "0x12121212006e4cd160d18e3f00711da5c3372600";
const POSITIONS = "0x006f54f7f9a22e0000cc2ab60031000000ae9fef";
const sel = (sig: string) => toHex(keccak256(utf8(sig))).slice(0, 10);
const w = (v: bigint | string) => (typeof v === "string" ? v.replace(/^0x/, "") : v.toString(16)).padStart(64, "0");

/** The two calls the server builds: approve the operator, then run the operation for `amount`. */
export function callsFor(operation: string, amount: bigint, outcome = 0): OnchainCall[] {
  const call = (target: string, data: string) => ({ target, value: "0", data });
  if (operation === "split") return [call(PUSD, sel("approve(address,uint256)") + w(ADAPTER) + w(amount)), call(ADAPTER, sel("splitPosition(address,bytes32,bytes32,uint256[],uint256)") + w(PUSD) + w(0n) + w(CONDITION) + w(160n) + w(amount) + w(2n) + w(1n) + w(2n))];
  if (operation === "merge") return [call(CTF, sel("setApprovalForAll(address,bool)") + w(ADAPTER) + w(1n)), call(ADAPTER, sel("mergePositions(address,bytes32,bytes32,uint256[],uint256)") + w(PUSD) + w(0n) + w(CONDITION) + w(160n) + w(amount) + w(2n) + w(1n) + w(2n))];
  return [call(POSITIONS, sel("setApprovalForAll(address,bool)") + w(ROUTER) + w(1n)), call(ROUTER, sel("redeem(bytes31,uint256,uint256)") + w(CONDITION.slice(2, 64) + "00") + w(BigInt(outcome)) + w(amount))];
}

/** The view the server returns: hash and both requests derived from the terms, with `edit` applied to the terms first. */
function viewFor(body: Record<string, any>, status: OnchainIntentView["intent"]["status"] = "needs_signatures", edit: (v: OnchainIntentView) => void = () => {}): OnchainIntentView {
  const terms: OnchainIntentTerms = {
    contractVersion: 1,
    id: "00000000-0000-0000-0000-0000000000a1",
    partnerId: "acme",
    audience: "https://exec.test",
    executionRegion: "us-east-1",
    signer: body.wallet,
    account: body.account,
    chainId: "137",
    market: `polymarket:${CONDITION}`,
    operation: body.operation,
    submissionOwner: body.submissionOwner,
    submissionEndpoint: "https://submit.test/submit",
    batch: { factory: "0x00000000000fb5c9adea0298d729a0cb3823cc07", nonce: "3", deadline: body.executeBefore, calls: callsFor(body.operation, BigInt(body.amountRaw), body.outcome) },
    effects: [
      { token: { kind: "erc20", contract: PUSD }, direction: "debit", amountRaw: body.amountRaw },
      { token: { kind: "erc1155", contract: CTF, tokenId: "1" }, direction: "credit", amountRaw: body.amountRaw },
      { token: { kind: "erc1155", contract: CTF, tokenId: "2" }, direction: "credit", amountRaw: body.amountRaw },
    ],
    dependencies: [],
    maxWalletGasCostRaw: "0",
    createdAt: "2026-10-28T12:00:00Z",
    executeBefore: body.executeBefore,
  };
  const view = { intent: { terms }, submission: { endpoint: "https://submit.test/submit", method: "POST", kind: "deposit_wallet_batch", body: {} } } as OnchainIntentView;
  view.intent = { terms, intentHash: "", status, committed: status !== "needs_signatures", dispatchClaimed: status === "reconciling" || status === "confirmed", transactionHash: null, proof: null };
  const seal = () => {
    view.intent.intentHash = valueHash(view.intent.terms);
    view.consentRequest = intentConsentRequest(view.intent.terms, view.intent.intentHash);
    view.nativeRequest = intentNativeRequest(view.intent.terms);
  };
  seal();
  const before = JSON.stringify(view.intent.terms);
  edit(view);
  // A server that rewrites the terms seals them again, so only the client-side rules can catch it.
  if (JSON.stringify(view.intent.terms) !== before) seal();
  return view;
}

function intentServer(edit?: (v: OnchainIntentView) => void) {
  let body: Record<string, any> = {};
  let reads = 0;
  return fakeFetch([
    ...loginRoutes(),
    (c: Call) => (c.method === "GET" && c.path === `/v3/wallets/${W}` ? [200, { wallet: W, ready: true, next: null, tradingWallet: DEPOSIT, venues: { polymarket: { ready: true, next: null, balance: "5", tradingWallet: DEPOSIT } } }] : undefined),
    (c: Call) => (c.method === "POST" && c.path === "/v3/onchain-intents" ? [200, viewFor((body = c.body as Record<string, any>), "needs_signatures", edit)] : undefined),
    (c: Call) => (c.method === "POST" && c.path === `/v3/onchain-intents/${ID}/execute` ? [200, viewFor(body, "ready")] : undefined),
    (c: Call) => (c.method === "GET" && c.path === `/v3/onchain-intents/${ID}` ? [200, viewFor(body, ++reads < 2 ? "reconciling" : "confirmed")] : undefined),
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
  const execute = calls.filter((c) => c.path === `/v3/onchain-intents/${ID}/execute`);
  assert.equal(execute.length, 1);
  assert.deepEqual(execute[0].body, { intentHash: view.intent.intentHash, consentSignature: CONSENT_SIG, nativeSignature: NATIVE_SIG });
  assert.equal(calls.filter((c) => c.method === "GET" && c.path === `/v3/onchain-intents/${ID}`).length, 2);
});

test("onchain: refuses to sign an intent that debits a different amount or another account", async () => {
  for (const [what, edit] of [
    ["amount", (v: OnchainIntentView) => (v.intent.terms.effects[0].amountRaw = "2000000")],
    ["account", (v: OnchainIntentView) => (v.nativeRequest.params[1] = JSON.stringify({ domain: { verifyingContract: "0x" + "77".repeat(20) }, message: { wallet: D } }))],
    ["gas", (v: OnchainIntentView) => ((v.intent.terms as { maxWalletGasCostRaw: string }).maxWalletGasCostRaw = "1")],
    ["hash", (v: OnchainIntentView) => (v.intent.intentHash = HASH)],
    ["consent", (v: OnchainIntentView) => (v.consentRequest = intentConsentRequest({ ...v.intent.terms, partnerId: "other" }, v.intent.intentHash))],
    ["native nonce", (v: OnchainIntentView) => (v.nativeRequest = intentNativeRequest({ ...v.intent.terms, batch: { ...v.intent.terms.batch, nonce: "9" } }))],
    ["later", (v: OnchainIntentView) => (v.intent.terms.executeBefore = "2999-01-01T00:00:00Z")],
    ["operator", (v: OnchainIntentView) => (v.intent.terms.batch.calls[0].data = v.intent.terms.batch.calls[0].data.slice(0, 10) + "77".repeat(32) + v.intent.terms.batch.calls[0].data.slice(74))],
    ["approval token", (v: OnchainIntentView) => (v.intent.terms.batch.calls[0].target = "0x" + "44".repeat(20))],
    ["op amount", (v: OnchainIntentView) => (v.intent.terms.batch.calls[1].data = v.intent.terms.batch.calls[1].data.slice(0, 266) + "f".repeat(64) + v.intent.terms.batch.calls[1].data.slice(330))],
    ["extra transfer", (v: OnchainIntentView) => v.intent.terms.batch.calls.push({ target: "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb", value: "0", data: "0xa9059cbb" + "77".repeat(32) + "00".repeat(32) })],
    ["split for merge", (v: OnchainIntentView) => (v.intent.terms.batch.calls = callsFor("split", 1000000n))],
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

test("onchain: redeem checks the outcome the batch redeems", async () => {
  const { impl, calls } = intentServer((v) => (v.intent.terms.batch.calls = callsFor("redeem", 1000000n, 0)));
  await assert.rejects(onchainWith(impl, signer().provider).redeem(CHECKSUMMED, CONDITION, "1000000", { outcome: 1, account: DEPOSIT }), /another outcome/);
  assert.ok(!calls.some((c) => c.path.endsWith("/execute")));
});

test("onchain: a lost execute reply is retried (execute is idempotent) and a dropped read does not fail the wait", async () => {
  const { impl, calls } = intentServer();
  let failures = 0;
  const flaky = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if ((path.endsWith("/execute") && failures === 0) || (init?.method === "GET" && path.startsWith("/v3/onchain-intents/") && failures === 1)) {
      failures++;
      if (failures === 1) return new Response(JSON.stringify({ error: "gateway" }), { status: 502 });
      throw new TypeError("fetch failed");
    }
    return impl(url, init);
  };
  const view = await onchainWith(flaky, signer().provider).split(CHECKSUMMED, CONDITION, 1_000_000n, { account: DEPOSIT });
  assert.equal(view.intent.status, "confirmed");
  assert.equal(failures, 2);
  assert.equal(calls.filter((c) => c.path.endsWith("/execute")).length, 1, "the retry reached the server once");
});

// Generated by the server's onchain::Terms (order_execution_trade_plans), so drift in its encoding fails here.
test("intent hash and both signing requests match the server's own output", async () => {
  const { readFileSync } = await import("node:fs");
  const v = JSON.parse(readFileSync(new URL("./fixtures/onchain-intent-protocol.json", import.meta.url), "utf8"));
  const terms = v.intent.terms as OnchainIntentTerms;
  assert.equal(valueHash(terms), v.intent.intentHash);
  assert.deepEqual(intentConsentRequest(terms, v.intent.intentHash), v.consentRequest);
  assert.deepEqual(intentNativeRequest(terms), v.nativeRequest);
});
