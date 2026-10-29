import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import { SafetyCheckError, WalletClient, type TradePlan, type TradePlanInput } from "../src/index.ts";
import { CHECKSUMMED, SIG, TOKEN, fakeFetch, fakeWallet, loginRoutes, type Call } from "./helpers.ts";
import { tradePlanAuthorization, tradePlanHash } from "../src/trade-plans.ts";
import { requestHash, typedDataRequest } from "../src/common.ts";

const W = CHECKSUMMED.toLowerCase();
const MARKET = "polymarket:0x" + "ab".repeat(32);
const HASH = "0x" + "cd".repeat(32);

const INPUT: TradePlanInput = { wallet: CHECKSUMMED, order: { market: MARKET, outcome: "yes", price: "0.05", size: "10" } };

const TRADING = "0x" + "22".repeat(20);
const EXCHANGE = "0xe111180000d2663c0091e4f400237545b87b996b";
const PROXY = "0x5567954cd026cebfe486062cb75848e0f1c12e58";
const ARB_USDC = "0xaf88d065e77c8cc2239327c5edb3a432268e5831";
const FUNDING = { sourceChainId: "42161", sourceToken: ARB_USDC, maxAmountRaw: "600000", slippageBps: 50 };
const unix = (at: string) => String(Date.parse(at) / 1000);
const units = (v: string, d: number) => BigInt(Math.round(Number(v) * 1e6)) * 10n ** BigInt(d - 6);

/** The venue order the server asks the wallet to sign for the plan's buy. */
function tradeDoc(p: TradePlan): Record<string, unknown> {
  const o = p.order;
  if (p.venue === "hyperliquid") {
    return {
      types: {},
      primaryType: "PlaceOrder",
      domain: { name: "Kairos", version: "1", chainId: 42161 },
      message: { wallet: CHECKSUMMED, market: o.market, outcome: o.outcome, side: "buy", price: o.price, size: o.size, timeInForce: o.timeInForce, postOnly: o.postOnly, action: p.id, expiresAt: Number(unix(p.tradeSubmitBefore)) },
    };
  }
  if (p.venue === "polymarket") {
    return {
      types: {},
      primaryType: "TypedDataSign",
      domain: { name: "Polymarket CTF Exchange", version: "2", chainId: 137, verifyingContract: EXCHANGE },
      message: {
        contents: { salt: "7", maker: TRADING, signer: TRADING, tokenId: "123", makerAmount: p.tradeBudget.notionalRaw, takerAmount: units(o.size, 6).toString(), side: 0, signatureType: 3, timestamp: "1", metadata: HASH, builder: HASH },
        name: "DepositWallet",
        version: "1",
        chainId: 137,
        verifyingContract: TRADING,
        salt: HASH,
      },
    };
  }
  return {
    types: {},
    primaryType: "Order",
    domain: { name: "predict.fun CTF Exchange", version: "1", chainId: 56, verifyingContract: "0x" + "8b".repeat(20) },
    message: { salt: "7", maker: W, signer: W, taker: "0x" + "00".repeat(20), tokenId: "123", makerAmount: p.tradeBudget.notionalRaw, takerAmount: units(o.size, 18).toString(), expiration: o.expiresAt ? unix(o.expiresAt) : "0", nonce: "0", feeRateBps: "0", side: 0, signatureType: 0 },
  };
}

function walletRequest(id: string, purpose: "trade" | "funding", chainId: string, doc: unknown) {
  return { id, purpose, kind: "signature" as const, signer: W, chainId, request: typedDataRequest(W, doc), requestHash: "", collectAfter: [], executeAfter: [] as string[], status: "ready" as const, actionable: true };
}

/** The two Relay permits a funded plan asks for, moving exactly `amount` of the source token into Relay's proxy. */
function fundingDocs(p: TradePlan, amount: string) {
  const until = unix(p.tradeSubmitBefore);
  return [
    { types: {}, primaryType: "MulticallAuthorization", domain: { name: "RelayApprovalProxy", version: "3.1", chainId: 42161, verifyingContract: PROXY }, message: { from: W, refundTo: W, nftRecipient: W, msgValue: "0", fundingIndex: "0", relayer: "0x" + "5e".repeat(20), metadata: "0x", calls: [], funding: [{ token: ARB_USDC, from: W, value: amount, validAfter: "0", validBefore: until }] } },
    { types: {}, primaryType: "ReceiveWithAuthorization", domain: { name: "USD Coin", version: "2", chainId: 42161, verifyingContract: ARB_USDC }, message: { from: W, to: PROXY, value: amount, validAfter: "0", validBefore: until, nonce: HASH } },
  ];
}

/** Seal like the server: hash each request, hash the plan, then put the plan authorization first. */
function seal(p: TradePlan): void {
  p.requests = p.requests.filter((r) => r.purpose !== "plan");
  for (const r of p.requests) r.requestHash = requestHash(r.request);
  p.planHash = tradePlanHash(p);
  const chain = p.requests.find((r) => r.purpose === "trade")!.chainId!;
  const request = tradePlanAuthorization(p, BigInt(chain));
  p.requests.unshift({ id: "plan", purpose: "plan", kind: "signature", signer: W, chainId: chain, request, requestHash: requestHash(request), collectAfter: [], executeAfter: [], status: "ready", actionable: true });
}

/**
 * The plan a server would prepare for `body`. `edit` mimics a server that rewrites the plan and seals it consistently;
 * `tamper` changes it after sealing.
 */
function planFor(body: Record<string, any>, edit: (p: TradePlan) => void = () => {}, tamper: (p: TradePlan) => void = () => {}, docs: (d: any, id: string) => void = () => {}): TradePlan {
  const venue = body.order.market.split(":")[0];
  const decimals = venue === "predictfun" ? 18 : 6;
  const notional = (units(body.order.price, decimals) * units(body.order.size, 6)) / 10n ** 6n;
  const plan: TradePlan = {
    contractVersion: 1,
    id: "00000000-0000-0000-0000-000000000001",
    planHash: "",
    revision: "0",
    wallet: body.wallet,
    partnerId: "acme",
    audience: "https://exec.test",
    interactionMode: "single_batch",
    submission: { funding: "kairos", trade: "kairos" },
    status: "needs_signatures",
    venue,
    tradeExecutionRegion: "us-east-1",
    order: { ...body.order, outcome: venue === "hyperliquid" ? "#110" : body.order.outcome === "yes" ? "Yes" : body.order.outcome },
    tradingWallet: venue === "polymarket" ? TRADING : W,
    tradePayloadDigest: HASH,
    tradeBudget: { collateral: { kind: "evm", chainId: venue === "predictfun" ? "56" : "137", token: "0xc011" }, decimals, notionalRaw: notional.toString(), maxCollateralFeeRaw: "16750", maxPlatformFeeBps: 75, maxDebitRaw: (notional + 16750n).toString(), existingSpendableRaw: "0" },
    funding: null,
    createdAt: "2026-10-28T12:00:00Z",
    executeBefore: body.tradeSubmitBefore,
    tradeSubmitBefore: body.tradeSubmitBefore,
    requests: [],
    execution: { committed: false, phase: "collecting", fundingStatus: "not_required", tradeStatus: "not_started" },
    error: null,
  };
  if (body.funding) {
    plan.funding = {
      sourceChainId: body.funding.sourceChainId, sourceToken: body.funding.sourceToken, sourceDecimals: 6, quoteId: "q1", providerRequestId: HASH, amountInRaw: "520000", maxGasCostRaw: "0",
      destination: plan.tradeBudget.collateral, destinationDecimals: 6, recipient: plan.tradingWallet, refundRecipient: W, requiredArrivalRaw: "516750", minimumArrivalRaw: "516750", expectedArrivalRaw: "518000",
      quoteExpiresAt: body.tradeSubmitBefore, fundingSubmitBefore: body.tradeSubmitBefore, maxAmountRaw: body.funding.maxAmountRaw, slippageBps: body.funding.slippageBps,
    };
  }
  edit(plan);
  const chain = { polymarket: "0x89", predictfun: "0x38", hyperliquid: "0xa4b1" }[plan.venue];
  const doc = (d: any, id: string) => (docs(d, id), d);
  const funding = plan.funding ? fundingDocs(plan, plan.funding.amountInRaw).map((d, i) => walletRequest(`funding-${i + 1}`, "funding", "0xa4b1", doc(d, `funding-${i + 1}`))) : [];
  plan.requests = [...funding, { ...walletRequest("trade", "trade", chain, doc(tradeDoc(plan), "trade")), executeAfter: funding.map((f) => f.id) }];
  seal(plan);
  tamper(plan);
  return plan;
}

const PLAN = "/v3/trade-plans/00000000-0000-0000-0000-000000000001";

/** prepare → (execute) → two reads: trade_pending, then completed. */
function planServer(edit?: (p: TradePlan) => void, tamper?: (p: TradePlan) => void, docs?: (d: any, id: string) => void) {
  let prepared: TradePlan | undefined;
  let reads = 0;
  const committed = (status: TradePlan["status"], tradeStatus: string) => ({
    ...prepared!,
    status,
    execution: { ...prepared!.execution, committed: true, phase: status === "completed" ? "finished" : "trade", tradeStatus, ...(status === "completed" ? { orderId: "o1" } : {}) },
  });
  const routes = [
    ...loginRoutes(),
    (c: Call) => (c.method === "POST" && c.path === "/v3/trade-plans" ? ([200, (prepared = planFor(c.body as Record<string, any>, edit, tamper, docs))] as [number, unknown]) : undefined),
    (c: Call) => (c.method === "POST" && c.path === `${PLAN}/execute` ? ([200, committed("trade_pending", "not_started")] as [number, unknown]) : undefined),
    (c: Call) => (c.method === "GET" && c.path === PLAN ? ([200, ++reads < 2 ? committed("trade_pending", "unknown") : committed("completed", "accepted")] as [number, unknown]) : undefined),
  ];
  return { ...fakeFetch(routes), prepared: () => prepared! };
}

const clientWith = (impl: (url: string, init?: RequestInit) => Promise<Response>, provider = fakeWallet().provider) =>
  new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider, fetch: impl, pollIntervalMs: 1 }).tradePlans;

test("tradePlans.run: prepares with defaults, signs every request on its chain, executes once and waits for completion", async () => {
  const { impl, calls, prepared } = planServer();
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
  const execute = calls.filter((c) => c.path === `${PLAN}/execute`);
  assert.equal(execute.length, 1);
  assert.deepEqual(execute[0].body, {
    planHash: prepared().planHash,
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
  ];
  // A hostile server keeps every hash consistent; only the client's own rules can catch these.
  const rehash = (r: TradePlan["requests"][number]) => (r.requestHash = requestHash(r.request));
  const tampered: [string, (p: TradePlan) => void][] = [
    ["authorization names another plan", (p) => rehash(Object.assign(p.requests[0], { request: tradePlanAuthorization({ ...p, id: "other" }, 137n) }))],
    ["authorization on another chain", (p) => rehash(Object.assign(p.requests[0], { request: tradePlanAuthorization(p, 1n) }))],
    ["planHash", (p) => (p.planHash = HASH)],
    ["requestHash", (p) => (p.requests[1].requestHash = HASH)],
    ["trade swapped after sealing", (p) => rehash(Object.assign(p.requests[1], { request: typedDataRequest(W, { ...tradeDoc(p), primaryType: "Other" }) }))],
  ];
  const docEdits: [string, (d: any, id: string) => void][] = [
    ["trade maker amount", (d) => (d.message.contents.makerAmount = "900000")],
    ["trade taker amount", (d) => (d.message.contents.takerAmount = "1")],
    ["trade side", (d) => (d.message.contents.side = 1)],
    ["trade maker", (d) => (d.message.contents.maker = "0x" + "66".repeat(20))],
    ["trade exchange", (d) => (d.domain.verifyingContract = "0x" + "66".repeat(20))],
    ["trade chain", (d) => (d.domain.chainId = 1)],
  ];
  const cases = [
    ...rewrites.map(([w, e]) => [w, e, undefined, undefined] as const),
    ...tampered.map(([w, t]) => [w, undefined, t, undefined] as const),
    ...docEdits.map(([w, d]) => [w, undefined, undefined, d] as const),
  ];
  for (const [what, edit, tamper, docs] of cases) {
    const { impl, calls } = planServer(edit, tamper, docs);
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

test("tradePlans: planHash, requestHash and the plan authorization match the server's own sealed plans", async () => {
  const cases = JSON.parse(readFileSync(new URL("./fixtures/trade-plan-protocol.json", import.meta.url), "utf8")) as { plan: TradePlan }[];
  assert.equal(cases.length, 3);
  for (const { plan } of cases) {
    assert.equal(tradePlanHash(plan), plan.planHash);
    for (const r of plan.requests) assert.equal(requestHash(r.request), r.requestHash, r.id);
    const consent = plan.requests.find((r) => r.purpose === "plan")!;
    assert.deepEqual(tradePlanAuthorization(plan, 137n), consent.request);
  }
  const changed = structuredClone(cases[1].plan);
  changed.funding!.amountInRaw = "1100000000000000001";
  assert.notEqual(tradePlanHash(changed), changed.planHash);
  const live = structuredClone(cases[1].plan);
  live.status = "completed";
  live.revision = "7";
  live.requests[1].status = "accepted";
  assert.equal(tradePlanHash(live), live.planHash, "live fields are outside the hash");
});

test("tradePlans.run: a funded plan signs the Relay permits on the source chain, then executes", async () => {
  const { impl, calls } = planServer();
  const wallet = fakeWallet();
  const signed: string[] = [];
  const plan = await clientWith(impl, wallet.provider).run({ ...INPUT, funding: FUNDING }, { onSign: (r) => signed.push(`${r.id}@${r.chainId}`) });
  assert.equal(plan.status, "completed");
  assert.deepEqual(signed, ["plan@0x89", "funding-1@0xa4b1", "funding-2@0xa4b1", "trade@0x89"]);
  assert.deepEqual((calls.find((c) => c.path.endsWith("/execute"))!.body as { answers: { requestId: string }[] }).answers.map((a) => a.requestId), ["plan", "funding-1", "funding-2", "trade"]);
});

test("tradePlans.run: refuses funding permits that move more, from or to anyone else, or on another chain", async () => {
  const edits: [string, (d: any, id: string) => void][] = [
    ["permit value", (d, id) => id === "funding-2" && (d.message.value = "600000")],
    ["permit payee", (d, id) => id === "funding-2" && (d.message.to = "0x" + "66".repeat(20))],
    ["permit token", (d, id) => id === "funding-2" && (d.domain.verifyingContract = "0x" + "66".repeat(20))],
    ["permit lifetime", (d, id) => id === "funding-2" && (d.message.validBefore = "4102444800")],
    ["multicall amount", (d, id) => id === "funding-1" && (d.message.funding[0].value = "600000")],
    ["multicall refund", (d, id) => id === "funding-1" && (d.message.refundTo = "0x" + "66".repeat(20))],
    ["multicall proxy", (d, id) => id === "funding-1" && (d.domain.verifyingContract = "0x" + "66".repeat(20))],
    ["unknown permit", (d, id) => id === "funding-2" && (d.primaryType = "Permit")],
    ["permit chain", (d, id) => id.startsWith("funding") && (d.domain.chainId = 137)],
  ];
  for (const [what, docs] of edits) {
    const { impl, calls } = planServer(undefined, undefined, docs);
    const wallet = fakeWallet();
    await assert.rejects(clientWith(impl, wallet.provider).run({ ...INPUT, funding: FUNDING }), (e: unknown) => e instanceof SafetyCheckError, what);
    assert.deepEqual(wallet.methods(), ["personal_sign"], `${what}: nothing signed`);
    assert.ok(!calls.some((c) => c.path.endsWith("/execute")), what);
  }
});

test("tradePlans.run: a Hyperliquid plan signs the Kairos order authorization for exactly this order", async () => {
  const input: TradePlanInput = { wallet: CHECKSUMMED, order: { market: "hyperliquid:11422", outcome: "Yes", price: "0.5", size: "20" } };
  assert.equal((await clientWith(planServer().impl).run(input)).status, "completed");
  for (const [what, docs] of [
    ["action", (d: any) => (d.message.action = "other")],
    ["size", (d: any) => (d.message.size = "200")],
    ["expiry", (d: any) => (d.message.expiresAt = 4102444800)],
  ] as const) {
    const { impl } = planServer(undefined, undefined, docs);
    await assert.rejects(clientWith(impl).run(input), /signs a different order/, what);
  }
});

test("tradePlans.run: a lost execute reply is retried, and a dropped read does not fail the wait", async () => {
  const { impl, calls } = planServer();
  let failures = 0;
  const flaky = async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if ((path.endsWith("/execute") && failures === 0) || (init?.method === "GET" && path === PLAN && failures === 1)) {
      failures++;
      if (failures === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ error: "busy gateway" }), { status: 504 });
    }
    return impl(url, init);
  };
  const plan = await clientWith(flaky).run(INPUT);
  assert.equal(plan.status, "completed");
  assert.equal(failures, 2);
  assert.equal(calls.filter((c) => c.path.endsWith("/execute")).length, 1);
});
