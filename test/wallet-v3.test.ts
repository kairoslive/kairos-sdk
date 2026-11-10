import { test } from "node:test";
import assert from "node:assert/strict";

import { ActionFailedError, FeeSettlementRequiredError, KairosError, WalletClient } from "../src/index.ts";
import { SIG, TOKEN, WALLET, fakeFetch, fakeWallet, loginRoutes, step, type Call } from "./helpers.ts";

const KEY = { clientId: "cid", apiKey: "key", apiSecret: "secret" };
const signRequest = { method: "eth_signTypedData_v4", params: [WALLET, "{}"] };

test("api key: sends the key triple instead of a partner id, keeps the version header", async () => {
  const { impl, calls } = fakeFetch([() => [200, { wallet: WALLET, ready: true, next: null }]]);
  const client = new WalletClient({ baseUrl: "https://exec.test", apiKey: KEY, provider: fakeWallet().provider, fetch: impl });
  await client.status(WALLET);
  const h = calls[0].headers;
  assert.equal(h["x-client-id"], "cid");
  assert.equal(h["x-api-key"], "key");
  assert.equal(h["x-api-secret"], "secret");
  assert.equal(h["x-kairos-wallet-api"], "2");
  assert.equal(h["x-kairos-partner-id"], undefined);
});

test("auth: exactly one of partnerId or apiKey, and a complete key", () => {
  const provider = fakeWallet().provider;
  assert.throws(() => new WalletClient({ baseUrl: "x", provider }), /partnerId or apiKey/);
  assert.throws(() => new WalletClient({ baseUrl: "x", provider, partnerId: "acme", apiKey: KEY }), /not both/);
  assert.throws(() => new WalletClient({ baseUrl: "x", provider, apiKey: { ...KEY, apiSecret: "" } }), /apiSecret/);
});

test("polling: a held order is read again at holdUntilMs, not after pollIntervalMs", async () => {
  let held = 0;
  const { impl, calls } = fakeFetch([
    (c) => (c.method === "POST" ? [200, step({ holdUntilMs: (held = Date.now() + 300), result: { orderId: "o1", final: false } })] : undefined),
    (c) => (c.method === "GET" ? [200, step({ status: "done", result: { orderId: "o1", final: true, success: true } })] : undefined),
  ]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl, pollIntervalMs: 60_000 });
  const started = Date.now();
  const result = await client.order(WALLET, { market: "m", outcome: "Yes", side: "buy", price: "0.5", size: "1", timeInForce: "FAK" });
  const elapsed = Date.now() - started;
  assert.deepEqual(result, { orderId: "o1", final: true, success: true });
  assert.ok(elapsed >= 250 && elapsed < 5000, `waited ${elapsed} ms`);
  assert.ok(held > 0);
  assert.equal(calls.length, 2);
});

test("polling: a hold that is about to end still waits at least 250 ms", async () => {
  const { impl } = fakeFetch([
    (c) => (c.method === "POST" ? [200, step({ holdUntilMs: Date.now() + 5 })] : undefined),
    () => [200, step({ status: "done", result: { orderId: "o1" } })],
  ]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl, pollIntervalMs: 60_000 });
  const started = Date.now();
  await client.order(WALLET, { market: "m", outcome: "Yes", side: "buy", price: "0.5", size: "1" });
  assert.ok(Date.now() - started >= 240);
});

test("abort: a signal stops a wait and is passed to fetch; an aborted call sends nothing", async () => {
  const { impl, calls } = fakeFetch([() => [200, step({})]]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl, pollIntervalMs: 60_000 });
  const controller = new AbortController();
  const started = Date.now();
  const pending = client.order(WALLET, { market: "m", outcome: "Yes", side: "buy", price: "0.5", size: "1" }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(pending, (e: unknown) => (e as Error).name === "AbortError");
  assert.ok(Date.now() - started < 5000);
  assert.equal(calls[0].signal, controller.signal);

  const before = calls.length;
  await assert.rejects(client.status(WALLET, { signal: AbortSignal.abort() }), (e: unknown) => (e as Error).name === "AbortError");
  assert.equal(calls.length, before);
});

test("abort: a client-wide signal applies to every call", async () => {
  const { impl, calls } = fakeFetch([() => [200, {}]]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl, signal: AbortSignal.abort() });
  await assert.rejects(client.status(WALLET), (e: unknown) => (e as Error).name === "AbortError");
  assert.equal(calls.length, 0);
});

test("busy: a 409 'action is busy' reads the action and re-sends the same answer without signing again", async () => {
  let answers = 0;
  const { impl, calls } = fakeFetch([
    (c) => (c.method === "POST" && c.path === "/v3/actions" ? [200, step({ status: "needs_signature", request: signRequest })] : undefined),
    (c) => {
      if (!(c.method === "POST" && c.path === "/v3/actions/a1")) return undefined;
      return ++answers === 1 ? [409, { error: "this action is busy; GET it and retry" }] : [200, step({ status: "done", result: { orderId: "o1" } })];
    },
    (c) => (c.method === "GET" ? [200, step({ status: "needs_signature", request: signRequest })] : undefined),
  ]);
  const wallet = fakeWallet();
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: wallet.provider, fetch: impl, pollIntervalMs: 1 });
  assert.deepEqual(await client.order(WALLET, { market: "m", outcome: "Yes", side: "buy", price: "0.5", size: "1" }), { orderId: "o1" });
  assert.deepEqual(wallet.methods(), ["eth_signTypedData_v4"]);
  const posts = calls.filter((c) => c.path === "/v3/actions/a1" && c.method === "POST");
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].body, { signature: SIG });
  assert.deepEqual(posts[1].body, { signature: SIG });
});

test("busy: gives up after a bounded number of retries", async () => {
  const { impl } = fakeFetch([
    (c) => (c.method === "POST" && c.path === "/v3/actions" ? [200, step({ status: "needs_signature", request: signRequest })] : undefined),
    (c) => (c.method === "POST" ? [409, { error: "this action is busy; GET it and retry" }] : undefined),
    () => [200, step({ status: "needs_signature", request: signRequest })],
  ]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl, pollIntervalMs: 1 });
  await assert.rejects(client.cancel(WALLET, ["o1"]), (e: unknown) => e instanceof KairosError && e.status === 409);
});

test("ActionFailedError: errorCode, and outcomeUnknown only for the unknown-outcome codes", async () => {
  for (const [code, unknown] of [["ORDER_OUTCOME_UNKNOWN", true], ["CANCEL_OUTCOME_UNKNOWN", true], ["NO_MATCH", false], [undefined, false]] as const) {
    const { impl } = fakeFetch([() => [200, step({ status: "failed", error: "nope", ...(code ? { errorCode: code } : {}) })]]);
    const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl });
    await assert.rejects(client.order(WALLET, { market: "m", outcome: "Yes", side: "buy", price: "0.5", size: "1" }), (e: unknown) => {
      assert.ok(e instanceof ActionFailedError);
      assert.equal(e.errorCode, code);
      assert.equal(e.outcomeUnknown, unknown);
      return true;
    });
  }
});

test("KairosError: code from the body, plain-text bodies, and which statuses mean the outcome is unknown", async () => {
  const replies: Record<string, [number, unknown] | [number, string, "text"]> = {
    conflict: [409, { error: "client_order_id already names a different order", code: "CLIENT_ORDER_ID_CONFLICT", errorCode: "CLIENT_ORDER_ID_CONFLICT" }],
    expired: [410, { error: "signature expired", code: "SIGNATURE_EXPIRED" }],
    text: [422, "Failed to deserialize the JSON body into the target type: missing field `price`", "text"],
    refused: [503, { error: "hyperliquid is not available right now" }],
    timeout: [504, { error: "the venue node did not answer in time" }],
    internal: [500, { error: "internal error" }],
    unknown: [409, { error: "outcome unknown", code: "ORDER_OUTCOME_UNKNOWN" }],
  };
  const { impl } = fakeFetch([(c) => replies[c.path.split("/").pop()!]]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl });
  const fail = (id: string) => client.getAction(id).then(() => assert.fail("expected an error"), (e: unknown) => e as KairosError);

  const conflict = await fail("conflict");
  assert.equal(conflict.code, "CLIENT_ORDER_ID_CONFLICT");
  assert.equal(conflict.outcomeUnknown, false);
  assert.equal((await fail("expired")).code, "SIGNATURE_EXPIRED");
  const text = await fail("text");
  assert.equal(text.status, 422);
  assert.match(text.message, /missing field `price`/);
  assert.equal(text.code, undefined);
  assert.equal((await fail("refused")).outcomeUnknown, false, "503 is a refusal before any venue");
  assert.equal((await fail("timeout")).outcomeUnknown, true);
  assert.equal((await fail("internal")).outcomeUnknown, true);
  assert.equal((await fail("unknown")).outcomeUnknown, true);
});

test("FEE_SETTLEMENT_REQUIRED bodies become FeeSettlementRequiredError", async () => {
  const body = { error: "unpaid trading fees must be settled before the next trade", code: "FEE_SETTLEMENT_REQUIRED", assetKey: "evm:137:0xc011", owedRaw: "12000000", thresholdRaw: "10000000" };
  const { impl } = fakeFetch([() => [409, body]]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl });
  await assert.rejects(client.getAction("x"), (e: unknown) => {
    assert.ok(e instanceof FeeSettlementRequiredError);
    assert.ok(e instanceof KairosError);
    assert.equal(e.status, 409);
    assert.equal(e.code, "FEE_SETTLEMENT_REQUIRED");
    assert.equal(e.assetKey, "evm:137:0xc011");
    assert.equal(e.owedRaw, "12000000");
    assert.equal(e.thresholdRaw, "10000000");
    return true;
  });
});

test("chains: a Hyperliquid step on Arbitrum adds the chain when the wallet does not know it", async () => {
  const added: unknown[] = [];
  const { impl } = fakeFetch([
    (c) => (c.path === "/v3/actions" ? [200, step({ status: "needs_signature", request: signRequest, chainId: "0xa4b1", venue: "hyperliquid" })] : undefined),
    () => [200, step({ status: "done", result: { orderId: "o1" } })],
  ]);
  const wallet = fakeWallet({
    wallet_switchEthereumChain: () => {
      if (!added.length) throw Object.assign(new Error("unknown chain"), { code: 4902 });
      return null;
    },
    wallet_addEthereumChain: (params) => added.push(params[0]),
  });
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: wallet.provider, fetch: impl });
  await client.order(WALLET, { market: "hyperliquid:11422", outcome: "Yes", side: "buy", price: "0.5", size: "20" });
  assert.deepEqual(wallet.methods(), ["eth_chainId", "wallet_switchEthereumChain", "wallet_addEthereumChain", "eth_signTypedData_v4"]);
  assert.equal((added[0] as { chainId: string; chainName: string }).chainId, "0xa4b1");
  assert.equal((added[0] as { chainName: string }).chainName, "Arbitrum One");
});

test("reads: ordersPage and positionsPage keep venueDetail; orders and positions keep their shapes", async () => {
  const venueDetail = { hyperliquid: { error: "Hyperliquid is unavailable; retry shortly" } };
  const positions = { positions: [], resolved: [], closed: [], asOf: "2026-10-28T00:00:00Z" };
  const { impl } = fakeFetch([
    ...loginRoutes(),
    (c) => (c.path.endsWith("/orders") ? [200, { orders: [{ orderId: "o1", status: "partial" }], venueDetail }] : undefined),
    (c) => (c.path.endsWith("/positions") ? [200, { positions, venueDetail }] : undefined),
  ]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl });
  const page = await client.ordersPage(WALLET, { open: true });
  assert.deepEqual(page.venueDetail, venueDetail);
  assert.equal(page.orders[0].status, "partial");
  assert.deepEqual(await client.orders(WALLET), [{ orderId: "o1", status: "partial" }]);
  assert.deepEqual((await client.positionsPage(WALLET)).venueDetail, venueDetail);
  assert.deepEqual(await client.positions(WALLET), positions);
});

test("api key: wallet reads still sign in; preview routes send only the key", async () => {
  const { impl, calls } = fakeFetch([
    ...loginRoutes(),
    (c) => (c.path.endsWith("/orders") ? [200, { orders: [] }] : undefined),
    (c) => (c.path === "/v3/fees" ? [200, { venues: [] }] : undefined),
  ]);
  const wallet = fakeWallet();
  const client = new WalletClient({ baseUrl: "https://exec.test", apiKey: KEY, provider: wallet.provider, fetch: impl });
  await client.fees.summary(WALLET);
  const fees = calls.find((c) => c.path === "/v3/fees")!;
  assert.equal(fees.headers.authorization, undefined);
  assert.equal(fees.headers["x-api-key"], "key");
  assert.equal(wallet.requests.length, 0, "no login prompt for a key-authenticated fee read");

  await client.orders(WALLET);
  assert.equal(calls.find((c) => c.path.endsWith("/orders"))!.headers.authorization, `SIWE ${TOKEN.token}`);
  await client.fees.summary(WALLET);
  assert.equal(calls.filter((c) => c.path === "/v3/fees")[1].headers.authorization, `SIWE ${TOKEN.token}`, "a token already held rides along");
});

/** A wallet whose chain is real state, so an interleaved switch shows up as a signature on the wrong chain. */
function chainWallet() {
  let chain = "0x1";
  const signedOn: string[] = [];
  const provider = {
    async request(args: { method: string; params?: unknown[] }) {
      if (args.method === "eth_chainId") return chain;
      if (args.method === "wallet_switchEthereumChain") {
        await new Promise((r) => setTimeout(r, 5));
        chain = (args.params![0] as { chainId: string }).chainId;
        return null;
      }
      await new Promise((r) => setTimeout(r, 5));
      signedOn.push(`${JSON.parse(String(args.params![1])).want}@${chain}`);
      return SIG;
    },
  };
  return { provider, signedOn };
}

test("concurrency: two actions on one provider never sign between another's chain switch and signature", async () => {
  const actionOn = (id: string, chainId: string) => [
    (c: Call) => (c.method === "POST" && c.path === "/v3/actions" && (c.body as { action: { orderIds?: string[] } }).action.orderIds?.[0] === id ? [200, step({ id, type: "cancel", status: "needs_signature", chainId, request: { method: "eth_signTypedData_v4", params: [WALLET, JSON.stringify({ want: chainId })] } })] : undefined),
    (c: Call) => (c.method === "POST" && c.path === `/v3/actions/${id}` ? [200, step({ id, status: "done", result: { cancelled: [id], failed: [] } })] : undefined),
  ];
  const { impl } = fakeFetch([...actionOn("a", "0x89"), ...actionOn("b", "0x38")] as never);
  const { provider, signedOn } = chainWallet();
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider, fetch: impl });
  await Promise.all([client.cancel(WALLET, ["a"]), client.cancel(WALLET, ["b"])]);
  assert.deepEqual(signedOn.sort(), ["0x38@0x38", "0x89@0x89"]);
});

test("answer: a reply lost in transit is read back and the same signature re-sent, never a second prompt", async () => {
  let answers = 0;
  const { impl, calls } = fakeFetch([
    (c) => (c.method === "POST" && c.path === "/v3/actions" ? [200, step({ status: "needs_signature", request: signRequest })] : undefined),
    (c) => (c.method === "GET" ? [200, step({ status: "needs_signature", request: signRequest })] : undefined),
    (c) => (c.method === "POST" && c.path === "/v3/actions/a1" ? (++answers === 1 ? [502, { error: "bad gateway" }] : [200, step({ status: "done", result: { orderId: "o1" } })]) : undefined),
  ]);
  const wallet = fakeWallet();
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: wallet.provider, fetch: impl, pollIntervalMs: 1 });
  assert.deepEqual(await client.order(WALLET, { market: "m", outcome: "Yes", side: "buy", price: "0.5", size: "1" }), { orderId: "o1" });
  assert.equal(wallet.methods().filter((m) => m === "eth_signTypedData_v4").length, 1);
  const sent = calls.filter((c) => c.path === "/v3/actions/a1" && c.method === "POST");
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0].body, sent[1].body);
});

test("timeout: an order still working when the client gives up is outcome-unknown, not a plain failure", async () => {
  const { impl } = fakeFetch([() => [200, step({})]]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl, pollIntervalMs: 1, timeoutMs: 20 });
  await assert.rejects(client.order(WALLET, { market: "m", outcome: "Yes", side: "buy", price: "0.5", size: "1" }), (e: unknown) => e instanceof ActionFailedError && e.outcomeUnknown && e.errorCode === "ORDER_OUTCOME_UNKNOWN");
});

test("abort: a call queued behind another wallet prompt never prompts once aborted", async () => {
  let release!: () => void;
  const prompts: string[] = [];
  const provider = {
    async request(args: { method: string; params?: unknown[] }) {
      if (args.method !== "eth_signTypedData_v4") return null;
      prompts.push(String(args.params![1]));
      if (prompts.length === 1) await new Promise<void>((r) => (release = r));
      return SIG;
    },
  };
  const { impl } = fakeFetch([
    (c) => (c.method === "POST" && c.path === "/v3/actions" ? [200, step({ id: (c.body as { action: { orderIds: string[] } }).action.orderIds[0], status: "needs_signature", request: { method: "eth_signTypedData_v4", params: [WALLET, (c.body as { action: { orderIds: string[] } }).action.orderIds[0]] } })] : undefined),
    (c) => (c.method === "POST" ? [200, step({ status: "done", result: { cancelled: [], failed: [] } })] : undefined),
  ]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider, fetch: impl });
  const first = client.cancel(WALLET, ["first"]);
  await new Promise((r) => setTimeout(r, 20));
  const controller = new AbortController();
  const second = client.cancel(WALLET, ["second"], { signal: controller.signal });
  await new Promise((r) => setTimeout(r, 20));
  controller.abort(new Error("user left"));
  await assert.rejects(second, /user left/);
  release();
  await first;
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(prompts, ["first"]);
});

test("routedOrder: sends one routedOrder action, signs each leg on its venue's chain under one action id, returns every leg", async () => {
  const planLeg = (venue: string, market: string) => ({ venue, market, outcome: "Yes", price: "0.3", size: "25", timeInForce: "FAK", clientOrderId: null });
  const route = { linkId: "l1", linkTitle: "T", requested: "50", planned: "50", unfilled: "0", blendedEffective: "0.31", stop: "filled", legs: [planLeg("predictfun", "predictfun:1"), planLeg("polymarket", "polymarket:0xabc")], notes: [] };
  const request = (n: number) => ({ method: "eth_signTypedData_v4", params: [WALLET, `{"leg":${n}}`] });
  const leg = (index: number, venue: string, chainId: string) =>
    step({ id: "r1", type: "routed_order", status: "needs_signature", request: request(index), venue, chainId, route, leg: { index, of: 2 } });
  const result = { ...route, routed: true, placed: 2, unknown: 0, failed: 0, legs: [{ ...route.legs[0], status: "placed", orderId: "o1" }, { ...route.legs[1], status: "placed", orderId: "o2" }] };
  let answers = 0;
  const { impl, calls } = fakeFetch([
    (c) => (c.method === "POST" && c.path === "/v3/actions" ? [200, leg(1, "predictfun", "0x38")] : undefined),
    (c) => (c.method === "POST" && c.path === "/v3/actions/r1" ? [200, ++answers === 1 ? step({ id: "r1", type: "routed_order", route, leg: { index: 1, of: 2 } }) : step({ id: "r1", type: "routed_order", status: "done", result })] : undefined),
    (c) => (c.method === "GET" && c.path === "/v3/actions/r1" ? [200, leg(2, "polymarket", "0x89")] : undefined),
  ]);
  const wallet = fakeWallet();
  const seen: unknown[] = [];
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: wallet.provider, fetch: impl, pollIntervalMs: 1, onStep: (s) => seen.push(s.leg) });
  const out = await client.routedOrder(WALLET, { market: "polymarket:0xabc", outcome: "Yes", size: 50, maxPrice: 0.35, clientOrderId: "acme-route-41" });
  assert.deepEqual(calls[0].body, { wallet: WALLET, action: { type: "routedOrder", market: "polymarket:0xabc", outcome: "Yes", size: "50", maxPrice: "0.35", clientOrderId: "acme-route-41" } });
  assert.equal(calls[0].headers["x-kairos-wallet-api"], "2");
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /v3/actions", "POST /v3/actions/r1", "GET /v3/actions/r1", "POST /v3/actions/r1"]);
  assert.deepEqual(seen, [{ index: 1, of: 2 }, { index: 2, of: 2 }]);
  assert.deepEqual(out.legs.map((l) => l.status), ["placed", "placed"]);
  const switches = wallet.requests.filter((r) => r.method === "wallet_switchEthereumChain").map((r) => (r.params?.[0] as { chainId: string }).chainId);
  assert.deepEqual(switches, ["0x38", "0x89"]);
  assert.equal(wallet.methods().filter((m) => m === "eth_signTypedData_v4").length, 2);
});

test("routedOrder: busy on a leg's answer, then the next leg is open: the wallet signs the new leg, the old answer is not re-sent", async () => {
  const request = (n: number) => ({ method: "eth_signTypedData_v4", params: [WALLET, `{"leg":${n}}`] });
  const leg = (index: number) => step({ id: "r1", type: "routed_order", status: "needs_signature", request: request(index), leg: { index, of: 2 } });
  let answers = 0;
  const { impl, calls } = fakeFetch([
    (c) => (c.method === "POST" && c.path === "/v3/actions" ? [200, leg(1)] : undefined),
    (c) => (c.method === "POST" ? (++answers === 1 ? [409, { error: "this action is busy; GET it and retry" }] : [200, step({ id: "r1", type: "routed_order", status: "done", result: { routed: true, legs: [] } })]) : undefined),
    (c) => (c.method === "GET" ? [200, leg(2)] : undefined),
  ]);
  const wallet = fakeWallet({ eth_signTypedData_v4: (p) => (String(p[1]).includes('"leg":1') ? "0x" + "01".repeat(65) : "0x" + "02".repeat(65)) });
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: wallet.provider, fetch: impl, pollIntervalMs: 1 });
  await client.routedOrder(WALLET, { market: "m", outcome: "Yes", size: "1" });
  const sent = calls.filter((c) => c.method === "POST" && c.path === "/v3/actions/r1").map((c) => (c.body as { signature: string }).signature);
  assert.deepEqual(sent, ["0x" + "01".repeat(65), "0x" + "02".repeat(65)]);
});

test("routedOrder: no leg placed is an ActionFailedError that keeps every leg; a maybe-live leg makes it outcome-unknown", async () => {
  const result = { routed: true, placed: 0, unknown: 1, failed: 1, legs: [{ venue: "predictfun", status: "unknown", errorCode: "ORDER_OUTCOME_UNKNOWN" }, { venue: "polymarket", status: "failed", errorCode: "NO_MATCH" }] };
  const { impl } = fakeFetch([() => [200, step({ type: "routed_order", status: "failed", error: "predictfun: unknown; polymarket: no match", errorCode: "ORDER_OUTCOME_UNKNOWN", result })]]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl });
  await assert.rejects(client.routedOrder(WALLET, { market: "m", outcome: "Yes", size: "1" }), (e: unknown) =>
    e instanceof ActionFailedError && e.outcomeUnknown && (e.step.result as typeof result).legs.length === 2);
});

test("routedOrder: a reused clientOrderId whose action expired is a 409, not retried as busy", async () => {
  const { impl, calls } = fakeFetch([() => [409, { error: "this clientOrderId already ran a routed order; read the wallet's orders, or use a new id" }]]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl, pollIntervalMs: 1 });
  await assert.rejects(client.routedOrder(WALLET, { market: "m", outcome: "Yes", size: "1", clientOrderId: "x" }), (e: unknown) => e instanceof KairosError && e.status === 409);
  assert.equal(calls.length, 1);
});

test("routedOrder: maxPrice is left out when not given", async () => {
  const { impl, calls } = fakeFetch([() => [200, step({ type: "routed_order", status: "done", result: { routed: true, legs: [] } })]]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl });
  await client.routedOrder(WALLET, { market: "predictfun:1", outcome: "No", size: "5", timeInForce: "IOC" });
  assert.deepEqual(calls[0].body, { wallet: WALLET, action: { type: "routedOrder", market: "predictfun:1", outcome: "No", size: "5", timeInForce: "IOC" } });
});

test("routedOrder: a refusal before signing is a KairosError with its code; a timeout is outcome-unknown", async () => {
  const refused = fakeFetch([() => [422, { error: "nothing on this market can be routed for this wallet right now", errorCode: "ROUTE_UNAVAILABLE", route: { notes: [] } }]]);
  const a = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: refused.impl });
  await assert.rejects(a.routedOrder(WALLET, { market: "m", outcome: "Yes", size: "1" }), (e: unknown) => e instanceof KairosError && e.status === 422 && e.code === "ROUTE_UNAVAILABLE");
  const working = fakeFetch([() => [200, step({ type: "routed_order" })]]);
  const b = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: working.impl, pollIntervalMs: 1, timeoutMs: 20 });
  await assert.rejects(b.routedOrder(WALLET, { market: "m", outcome: "Yes", size: "1" }), (e: unknown) => e instanceof ActionFailedError && e.outcomeUnknown && e.errorCode === "ORDER_OUTCOME_UNKNOWN");
});
