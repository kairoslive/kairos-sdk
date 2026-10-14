import { test } from "node:test";
import assert from "node:assert/strict";

import { ActionFailedError, KairosError, WalletClient, createKairos, type Eip1193Provider } from "../src/index.ts";

type Call = { method: string; url: string; headers: Record<string, string>; body: unknown };

/** A fake server: each handler gets the call and returns [status, body]. */
function fakeFetch(routes: Array<(c: Call) => [number, unknown] | undefined>) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    for (const route of routes) {
      const hit = route(call);
      if (hit) return new Response(JSON.stringify(hit[1]), { status: hit[0] });
    }
    return new Response(JSON.stringify({ error: `no route for ${call.method} ${url}` }), { status: 404 });
  };
  return { impl, calls };
}

function fakeWallet(signature = "0x" + "11".repeat(65)) {
  const requests: unknown[] = [];
  const provider: Eip1193Provider = {
    async request(args) {
      requests.push(args);
      return signature;
    },
  };
  return { provider, requests };
}

const WALLET = "0x00000000000000000000000000000000000000aa";
const signRequest = { method: "eth_signTypedData_v4", params: [WALLET, "{}"] };

test("order: signs the step, posts the signature back, returns the result", async () => {
  const { impl, calls } = fakeFetch([
    (c) => (c.method === "POST" && c.url.endsWith("/v3/actions") ? [200, { id: "a1", type: "order", status: "needs_signature", request: signRequest, description: "Confirm this order", result: null, error: null }] : undefined),
    (c) => (c.method === "POST" && c.url.endsWith("/v3/actions/a1") ? [200, { id: "a1", type: "order", status: "done", request: null, description: null, result: { orderId: "o1", status: "open", venueOrderId: "v1" }, error: null }] : undefined),
  ]);
  const { provider, requests } = fakeWallet();
  const seen: string[] = [];
  const client = new WalletClient({ baseUrl: "https://exec.test/", partnerId: "acme", provider, fetch: impl, onStep: (s) => seen.push(s.description ?? "") });

  const result = await client.order(WALLET, { market: "0xabc", outcome: "Yes", side: "buy", price: 0.42, size: 10, postOnly: true });

  assert.deepEqual(result, { orderId: "o1", status: "open", venueOrderId: "v1" });
  assert.equal(calls[0].url, "https://exec.test/v3/actions");
  assert.equal(calls[0].headers["x-kairos-partner-id"], "acme");
  assert.deepEqual(calls[0].body, { wallet: WALLET, action: { type: "order", market: "0xabc", outcome: "Yes", side: "buy", price: "0.42", size: "10", postOnly: true } });
  assert.deepEqual(requests, [signRequest]);
  assert.deepEqual(calls[1].body, { signature: "0x" + "11".repeat(65) });
  assert.deepEqual(seen, ["Confirm this order"]);
});

test("setup: polls while working and signs every step", async () => {
  let polls = 0;
  const { impl, calls } = fakeFetch([
    (c) => (c.method === "POST" && c.url.endsWith("/v3/actions") ? [200, { id: "s1", type: "setup", status: "needs_signature", request: signRequest, description: "Sign in", result: null, error: null }] : undefined),
    (c) => {
      if (!(c.method === "POST" && c.url.endsWith("/v3/actions/s1"))) return undefined;
      const n = calls.filter((x) => x.method === "POST" && x.url.endsWith("/v3/actions/s1")).length;
      return n === 1
        ? [200, { id: "s1", type: "setup", status: "working", request: null, description: null, result: null, error: null }]
        : [200, { id: "s1", type: "setup", status: "done", request: null, description: null, result: { ready: true, tradingWallet: "0xdw" }, error: null }];
    },
    (c) => {
      if (!(c.method === "GET" && c.url.endsWith("/v3/actions/s1"))) return undefined;
      polls += 1;
      return polls < 2
        ? [200, { id: "s1", type: "setup", status: "working", request: null, description: null, result: null, error: null }]
        : [200, { id: "s1", type: "setup", status: "needs_signature", request: signRequest, description: "Approve trading", result: null, error: null }];
    },
  ]);
  const { provider, requests } = fakeWallet();
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider, fetch: impl, pollIntervalMs: 1 });

  assert.deepEqual(await client.setup(WALLET), { ready: true, tradingWallet: "0xdw" });
  assert.equal(requests.length, 2);
  assert.equal(polls, 2);
});

test("a failed action throws ActionFailedError with the server's reason", async () => {
  const { impl } = fakeFetch([
    () => [200, { id: "c1", type: "cancel", status: "failed", request: null, description: null, result: null, error: "order not found" }],
  ]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl });
  await assert.rejects(client.cancel(WALLET, ["o1"]), (e: unknown) => e instanceof ActionFailedError && e.message === "order not found");
});

test("HTTP errors surface as KairosError; 5xx flags an unknown outcome", async () => {
  const { impl } = fakeFetch([
    (c) => (c.url.includes("/orders") ? [409, { error: "the wallet isn't set up" }] : undefined),
    () => [502, { error: "venue unavailable" }],
  ]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl });
  await assert.rejects(client.orders(WALLET), (e: unknown) => e instanceof KairosError && e.status === 409 && !e.outcomeUnknown && e.message === "the wallet isn't set up");
  await assert.rejects(client.order(WALLET, { market: "m", outcome: "Yes", side: "buy", price: "0.1", size: "5" }), (e: unknown) => e instanceof KairosError && e.outcomeUnknown);
});

test("reads: status, open orders with query, positions, cancelAll payload", async () => {
  const { impl, calls } = fakeFetch([
    (c) => (c.url.endsWith(`/v3/wallets/${WALLET}`) ? [200, { wallet: WALLET, tradingWallet: "0xdw", ready: true, balance: "25", next: null }] : undefined),
    (c) => (c.url.includes("/orders") ? [200, { orders: [{ id: "o1", status: "open" }] }] : undefined),
    (c) => (c.url.includes("/positions") ? [200, { positions: [] }] : undefined),
    (c) => (c.method === "POST" ? [200, { id: "x", type: "cancel", status: "done", request: null, description: null, result: { cancelled: ["o1"], failed: 0 }, error: null }] : undefined),
  ]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl });
  assert.equal((await client.status(WALLET)).next, null);
  assert.deepEqual(await client.orders(WALLET, { open: true, limit: 10 }), [{ id: "o1", status: "open" }]);
  assert.ok(calls[1].url.endsWith(`/orders?open=true&limit=10`));
  assert.deepEqual(await client.positions(WALLET), []);
  assert.deepEqual(await client.cancelAll(WALLET), { cancelled: ["o1"], failed: 0 });
  assert.deepEqual(calls[3].body, { wallet: WALLET, action: { type: "cancel", all: true } });
});

test("createKairos: markets works without wallet options; wallet explains what it needs", () => {
  const kairos = createKairos();
  assert.ok(kairos.markets);
  assert.throws(() => kairos.wallet, /baseUrl, partnerId, provider/);
  assert.throws(() => new WalletClient({ baseUrl: "x", partnerId: "", provider: fakeWallet().provider }), /partnerId/);
});
