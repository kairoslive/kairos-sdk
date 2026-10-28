import { test } from "node:test";
import assert from "node:assert/strict";

import { SafetyCheckError, WalletClient, type TradePlan, type TradePlanInput } from "../src/index.ts";
import { CHECKSUMMED, SIG, TOKEN, fakeFetch, fakeWallet, loginRoutes, type Call } from "./helpers.ts";

const W = CHECKSUMMED.toLowerCase();
const MARKET = "polymarket:0x" + "ab".repeat(32);
const HASH = "0x" + "cd".repeat(32);

const INPUT: TradePlanInput = { wallet: CHECKSUMMED, order: { market: MARKET, outcome: "yes", price: "0.05", size: "10" } };

/** The plan a server would prepare for `body`, with `edit` applied to mimic a rewrite. */
function planFor(body: Record<string, any>, edit: (p: TradePlan) => void = () => {}): TradePlan {
  const typed = (message: Record<string, unknown>) => JSON.stringify({ domain: { name: "KairosTradePlan", version: "1", chainId: 137 }, primaryType: "TradePlan", types: {}, message });
  const request = (id: string, purpose: "plan" | "trade" | "funding", chainId: string, message: Record<string, unknown>) => ({
    id,
    purpose,
    kind: "signature" as const,
    signer: W,
    chainId,
    request: { method: "eth_signTypedData_v4", params: [W, typed(message)] },
    requestHash: "0x" + "00".repeat(32),
    collectAfter: [],
    executeAfter: [],
    status: "ready" as const,
    actionable: true,
  });
  const plan: TradePlan = {
    contractVersion: 1,
    id: "p1",
    planHash: HASH,
    revision: "0",
    wallet: body.wallet,
    partnerId: "acme",
    audience: "https://exec.test",
    interactionMode: "single_batch",
    submission: { funding: "kairos", trade: "kairos" },
    status: "needs_signatures",
    venue: body.order.market.split(":")[0],
    tradeExecutionRegion: "r",
    order: { ...body.order, outcome: "Yes" },
    tradingWallet: "0x" + "22".repeat(20),
    tradePayloadDigest: HASH,
    tradeBudget: { collateral: { kind: "evm", chainId: "137", token: "0xc011" }, decimals: 6, notionalRaw: "500000", maxCollateralFeeRaw: "16750", maxPlatformFeeBps: 75, maxDebitRaw: "516750", existingSpendableRaw: "600000" },
    funding: null,
    createdAt: "2026-10-28T12:00:00Z",
    executeBefore: body.tradeSubmitBefore,
    tradeSubmitBefore: body.tradeSubmitBefore,
    requests: [request("plan", "plan", "0x89", { wallet: W, planId: "p1", planHash: HASH, partnerId: "acme" }), request("trade", "trade", "0x89", { order: 1 })],
    execution: { committed: false, phase: "collecting", fundingStatus: "not_required", tradeStatus: "not_started" },
    error: null,
  };
  edit(plan);
  return plan;
}

/** prepare → (execute) → two reads: trade_pending, then completed. */
function planServer(edit?: (p: TradePlan) => void) {
  let prepared: TradePlan | undefined;
  let reads = 0;
  const committed = (status: TradePlan["status"], tradeStatus: string) => ({
    ...prepared!,
    status,
    execution: { ...prepared!.execution, committed: true, phase: status === "completed" ? "finished" : "trade", tradeStatus, ...(status === "completed" ? { orderId: "o1" } : {}) },
  });
  const routes = [
    ...loginRoutes(),
    (c: Call) => (c.method === "POST" && c.path === "/v3/trade-plans" ? ([200, (prepared = planFor(c.body as Record<string, any>, edit))] as [number, unknown]) : undefined),
    (c: Call) => (c.method === "POST" && c.path === "/v3/trade-plans/p1/execute" ? ([200, committed("trade_pending", "not_started")] as [number, unknown]) : undefined),
    (c: Call) => (c.method === "GET" && c.path === "/v3/trade-plans/p1" ? ([200, ++reads < 2 ? committed("trade_pending", "unknown") : committed("completed", "accepted")] as [number, unknown]) : undefined),
  ];
  return fakeFetch(routes);
}

const clientWith = (impl: (url: string, init?: RequestInit) => Promise<Response>, provider = fakeWallet().provider) =>
  new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider, fetch: impl, pollIntervalMs: 1 }).tradePlans;

test("tradePlans.run: prepares with defaults, signs every request on its chain, executes once and waits for completion", async () => {
  const { impl, calls } = planServer();
  const wallet = fakeWallet();
  const signed: string[] = [];
  const before = Math.floor(Date.now() / 1000);
  const plan = await clientWith(impl, wallet.provider).run(INPUT, { onSign: (r) => signed.push(r.id) });

  assert.equal(plan.status, "completed");
  assert.equal(plan.execution.orderId, "o1");
  assert.deepEqual(signed, ["plan", "trade"]);

  const prepare = calls.find((c) => c.path === "/v3/trade-plans")!;
  const body = prepare.body as Record<string, any>;
  assert.match(prepare.headers["idempotency-key"], /^[0-9a-f-]{36}$/);
  assert.equal(prepare.headers.authorization, `SIWE ${TOKEN.token}`);
  assert.equal(body.wallet, W);
  assert.equal(body.interactionMode, "single_batch");
  assert.deepEqual(body.submission, { funding: "kairos", trade: "kairos" });
  assert.equal(body.funding, null);
  assert.match(body.order.clientOrderId, /^0x[0-9a-f]{32}$/);
  assert.deepEqual({ ...body.order, clientOrderId: "x" }, { market: MARKET, outcome: "yes", side: "buy", price: "0.05", size: "10", timeInForce: "GTC", postOnly: false, clientOrderId: "x" });
  assert.match(body.tradeSubmitBefore, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const submitBy = Date.parse(body.tradeSubmitBefore) / 1000;
  assert.ok(submitBy >= before + 239 && submitBy <= before + 242, `tradeSubmitBefore ${body.tradeSubmitBefore}`);

  assert.deepEqual(wallet.methods(), ["personal_sign", "eth_chainId", "wallet_switchEthereumChain", "eth_signTypedData_v4", "eth_chainId", "wallet_switchEthereumChain", "eth_signTypedData_v4"]);
  const execute = calls.filter((c) => c.path === "/v3/trade-plans/p1/execute");
  assert.equal(execute.length, 1);
  assert.deepEqual(execute[0].body, {
    planHash: HASH,
    answers: [
      { kind: "signature", requestId: "plan", signature: SIG },
      { kind: "signature", requestId: "trade", signature: SIG },
    ],
  });
  assert.ok(!calls.some((c) => c.path.endsWith("/answers")));
});

test("tradePlans.run: refuses, before signing, a plan whose order was rewritten", async () => {
  const rewrites: [string, (p: TradePlan) => void][] = [
    ["price", (p) => (p.order.price = "0.06")],
    ["size", (p) => (p.order.size = "100")],
    ["side", (p) => ((p.order as { side: string }).side = "sell")],
    ["market", (p) => (p.order.market = "polymarket:0x" + "ef".repeat(32))],
    ["outcome", (p) => (p.order.outcome = "No")],
    ["wallet", (p) => (p.wallet = "0x" + "99".repeat(20))],
    ["timeInForce", (p) => (p.order.timeInForce = "FOK")],
    ["funding", (p) => (p.funding = { amountInRaw: "1" } as TradePlan["funding"])],
    ["authorization", (p) => (p.requests[0].request.params[1] = JSON.stringify({ message: { wallet: W, planId: "other", planHash: HASH } }))],
  ];
  for (const [what, edit] of rewrites) {
    const { impl, calls } = planServer(edit);
    const wallet = fakeWallet();
    await assert.rejects(clientWith(impl, wallet.provider).run(INPUT), (e: unknown) => e instanceof SafetyCheckError && /refusing to sign/.test(e.message), what);
    assert.deepEqual(wallet.methods(), ["personal_sign"], `${what}: only the login was signed`);
    assert.ok(!calls.some((c) => c.path.endsWith("/execute")), `${what}: never executed`);
  }
});

test("tradePlans.run: accepts the documented rewrites (canonical outcome, Predict.fun GTC becoming session-bound GTD)", async () => {
  const { impl } = planServer((p) => {
    p.order.timeInForce = "GTD";
    p.order.expiresAt = "2026-10-29T11:50:00Z";
  });
  const plan = await clientWith(impl).run({ wallet: CHECKSUMMED, order: { market: "predictfun:1027194", outcome: "YES", price: 0.5, size: 2 } });
  assert.equal(plan.status, "completed");
});

test("tradePlans.run: maxDebitRaw caps what the plan may debit", async () => {
  const { impl, calls } = planServer();
  await assert.rejects(clientWith(impl).run(INPUT, { maxDebitRaw: 500000n }), (e: unknown) => e instanceof SafetyCheckError && /over maxDebitRaw/.test(e.message));
  assert.ok(!calls.some((c) => c.path.endsWith("/execute")));
  const ok = planServer();
  assert.equal((await clientWith(ok.impl).run(INPUT, { maxDebitRaw: "516750" })).status, "completed");
});

test("tradePlans.run: refuses client-owned funding, asked for or returned", async () => {
  const { impl, calls } = planServer();
  await assert.rejects(clientWith(impl).run({ ...INPUT, submission: { funding: "client" } }), /Kairos-submitted funding only/);
  assert.equal(calls.length, 0, "refused before any request");

  const returned = planServer((p) => {
    p.submission = { funding: "client", trade: "kairos" };
  });
  await assert.rejects(clientWith(returned.impl).run(INPUT), (e: unknown) => e instanceof SafetyCheckError && /client-owned/.test(e.message));
});

test("tradePlans.prepare: checks canonical numbers and order rules before sending", async () => {
  const { impl, calls } = planServer();
  const plans = clientWith(impl);
  const order = INPUT.order;
  await assert.rejects(plans.prepare({ ...INPUT, order: { ...order, price: "0.50" } }), /canonical/);
  await assert.rejects(plans.prepare({ ...INPUT, order: { ...order, price: "1.5" } }), /between 0 and 1/);
  await assert.rejects(plans.prepare({ ...INPUT, order: { ...order, size: "1e3" } }), /canonical/);
  await assert.rejects(plans.prepare({ ...INPUT, order: { ...order, timeInForce: "GTD" } }), /expiresAt/);
  await assert.rejects(plans.prepare({ ...INPUT, order: { ...order, side: "sell" as "buy" } }), /buys only/);
  await assert.rejects(plans.prepare({ ...INPUT, tradeSubmitBefore: "2026-10-28T12:00:00.500Z" }), /whole seconds/);
  await assert.rejects(plans.prepare({ ...INPUT, funding: { sourceChainId: "42161", sourceToken: "0x" + "af".repeat(20), maxAmountRaw: "007", slippageBps: 50 } }), /maxAmountRaw/);
  assert.equal(calls.length, 0);

  await plans.prepare({ ...INPUT, tradeSubmitBefore: new Date(Date.UTC(2026, 9, 28, 12, 4)) }, { idempotencyKey: "k-1" });
  const sent = calls.find((c) => c.path === "/v3/trade-plans")!;
  assert.equal(sent.headers["idempotency-key"], "k-1");
  assert.equal((sent.body as { tradeSubmitBefore: string }).tradeSubmitBefore, "2026-10-28T12:04:00Z");
});

test("tradePlans: answer, execute, report and get address the plan and carry the wallet's token", async () => {
  const { impl, calls } = fakeFetch([...loginRoutes(), () => [200, { status: "needs_signatures" }]]);
  const plans = clientWith(impl);
  const answers = [{ kind: "signature" as const, requestId: "plan", signature: SIG }];
  await plans.answer("p1", CHECKSUMMED, HASH, answers);
  await plans.execute("p1", CHECKSUMMED, HASH);
  await plans.report("p1", CHECKSUMMED, HASH, [{ requestId: "funding-1", requestHash: HASH, providerRequestId: "0x01" }]);
  await plans.get("p1", CHECKSUMMED);
  const sent = calls.filter((c) => c.path.startsWith("/v3/trade-plans"));
  assert.deepEqual(sent.map((c) => `${c.method} ${c.path}`), ["POST /v3/trade-plans/p1/answers", "POST /v3/trade-plans/p1/execute", "POST /v3/trade-plans/p1/reports", "GET /v3/trade-plans/p1"]);
  assert.deepEqual(sent[0].body, { planHash: HASH, answers });
  assert.deepEqual(sent[1].body, { planHash: HASH, answers: [] });
  for (const c of sent) assert.equal(c.headers.authorization, `SIWE ${TOKEN.token}`);
});
