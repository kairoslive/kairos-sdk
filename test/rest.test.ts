import assert from "node:assert/strict";
import { test } from "node:test";

import { createKairos, KairosError } from "../src/index.ts";
import { fakeFetch } from "./helpers.ts";

test("matched catalog maps venue filters, date windows, cursors, and canonical side lookup", async () => {
  const { impl, calls } = fakeFetch([
    call => call.path === "/v1/events" ? [200, new URL(call.url).searchParams.has("cursor")
      ? { events: [{ id: "two" }], next_cursor: null, has_more: false }
      : { events: [{ id: "one" }], next_cursor: "+next", has_more: true }] : undefined,
    call => call.path === "/v1/matched-markets" ? [200, { markets: { "kalshi:KX": { ref_side: "no" } } }] : undefined,
    () => [200, { event: { id: "slash/id" } }],
  ]);
  const { markets } = createKairos({ fetch: impl });
  const ids = [];
  for await (const event of markets.events.all({
    venue: ["polymarket", "kalshi"], executableVenue: ["polymarket"], startsAfter: new Date("2026-01-02Z"),
    includeMarkets: false, sort: "start_time", limit: 1,
  })) ids.push(event.id);
  assert.deepEqual(ids, ["one", "two"]);
  const query = new URL(calls[1].url).searchParams;
  assert.equal(query.get("cursor"), "+next");
  assert.equal(query.get("venue"), "polymarket,kalshi");
  assert.equal(query.get("executable_venue"), "polymarket");
  assert.equal(query.get("starts_after"), "2026-01-02T00:00:00.000Z");
  assert.equal(query.get("include_markets"), "false");
  assert.equal((await markets.events.lookup(["kalshi:KX"])).markets["kalshi:KX"].ref_side, "no");
  await markets.events.get("slash/id");
  assert.equal(calls.at(-1)?.path, "/v1/events/slash%2Fid");
});

test("REST operations keep credentials on their own API and preserve typed transport errors", async () => {
  const { impl, calls } = fakeFetch([
    call => call.path === "/orders/route-quote" ? [200, { link_id: "route" }] : undefined,
    call => call.path.startsWith("/orders/") ? [403, { code: "FORBIDDEN", error: "Unavailable" }] : undefined,
    () => [200, { markets: [] }],
  ]);
  const kairos = createKairos({
    fetch: impl, data: { baseUrl: "https://data.test", auth: { bearer: "data-token" } },
    execution: { baseUrl: "https://exec.test", auth: { apiKey: { clientId: "client", apiKey: "key", apiSecret: "secret" } } },
  });
  await kairos.data.discover({ provider: "all", limit: 20 });
  await kairos.execution.routeQuote({ provider: "polymarket", market_id: "m", side: "yes", quantity: "10" });
  await assert.rejects(kairos.execution.request("GET", "/orders/{order_id}", { path: { order_id: "a/b?" } }), (err: unknown) =>
    err instanceof KairosError && err.status === 403 && err.code === "FORBIDDEN");
  assert.equal(calls[0].url, "https://data.test/api/markets/discover/v2?provider=all&limit=20");
  assert.equal(calls[0].headers.authorization, "Bearer data-token");
  assert.equal(calls[0].headers["x-api-secret"], undefined);
  assert.equal(calls[1].headers.authorization, undefined);
  assert.equal(calls[1].headers["x-api-secret"], "secret");
  assert.equal(calls[2].path, "/orders/a%2Fb%3F");
});

test("REST response preserves binary bodies and headers", async () => {
  const kairos = createKairos({
    fetch: async (_url, init) => {
      assert.equal(new Headers(init?.headers).get("accept"), "application/octet-stream");
      return new Response(Uint8Array.of(1, 2, 3), { headers: { "x-frame": "test" } });
    },
  });
  const response = await kairos.markets.response("GET", "/v1/candles", {
    query: { provider: "kalshi", contract_id: "m", timeframe_seconds: 60, start: "2026-10-01T00:00:00Z", end: "2026-10-02T00:00:00Z" },
    accept: "application/octet-stream",
  });
  assert.equal(response.headers.get("x-frame"), "test");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), Uint8Array.of(1, 2, 3));
});
