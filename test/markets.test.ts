import { test } from "node:test";
import assert from "node:assert/strict";

import { MarketDataClient } from "../src/index.ts";

function recorder(pages: Record<string, unknown>) {
  const urls: string[] = [];
  const impl = async (url: string) => {
    urls.push(url);
    const key = Object.keys(pages).find((k) => url.includes(k));
    return new Response(JSON.stringify(key ? pages[key] : {}), { status: key ? 200 : 404 });
  };
  return { impl, urls };
}

test("list and all() follow next_cursor", async () => {
  const { impl, urls } = recorder({
    "cursor=c1": { markets: [{ market_id: "2" }], next_cursor: null, count: 1, has_more: false, exchange_id: "polymarket" },
    "/v1/markets?provider=polymarket&limit=250": { markets: [{ market_id: "1" }], next_cursor: "c1", count: 1, has_more: true, exchange_id: "polymarket" },
  });
  const md = new MarketDataClient({ baseUrl: "https://md.test", fetch: impl });
  const ids: string[] = [];
  for await (const m of md.all("polymarket")) ids.push(m.market_id);
  assert.deepEqual(ids, ["1", "2"]);
  assert.equal(urls[0], "https://md.test/v1/markets?provider=polymarket&limit=250");
});

test("candles and trades map camelCase to the API's query names", async () => {
  const { impl, urls } = recorder({ "/v1/candles": { candles: [] }, "/v1/trades": { trades: [] } });
  const md = new MarketDataClient({ baseUrl: "https://md.test", fetch: impl });
  await md.candles({ provider: "polymarket", contractId: "0xabc", timeframeSeconds: 3600, start: new Date("2026-10-01T00:00:00Z"), end: "2026-10-02T00:00:00Z", outcome: 1 });
  await md.trades({ provider: "kalshi", contractId: "KX-1", limit: 5 });
  assert.equal(urls[0], "https://md.test/v1/candles?provider=polymarket&contract_id=0xabc&timeframe_seconds=3600&start=2026-10-01T00%3A00%3A00.000Z&end=2026-10-02T00%3A00%3A00Z&outcome=1");
  assert.equal(urls[1], "https://md.test/v1/trades?provider=kalshi&contract_id=KX-1&limit=5");
});

test("resolves market identifiers and reads tick grids, marks and lifecycle", async () => {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const md = new MarketDataClient({
    baseUrl: "https://md.test",
    fetch: async (input, init) => {
      const url = new URL(input);
      requests.push({ url, init });
      if (url.pathname === "/v1/market-identifiers/resolve") {
        return Response.json({ results: [{ provider: "new-provider", scope: "outcome", identifier: "token", found: true, market_id: "m" }] });
      }
      if (url.pathname === "/v1/markets/tick-size") {
        return Response.json({ contract_id: "m", provider: "predictfun", supported: false, reason: "static_grid" });
      }
      if (url.pathname === "/v1/markets/tick-size/batch") return Response.json({ provider: "polymarket", results: [] });
      if (url.pathname === "/v1/marks") return Response.json({ marks: [{ contract_id: "m", token_id: "token", price: 60 }] });
      if (url.pathname.endsWith("/resolution/events")) return Response.json({ provider: "new-provider", market_id: "m", market_key: "new-provider:m", events: [] });
      if (url.pathname.endsWith("/resolution")) return Response.json({ market_id: "m", status: "disputed" });
      return Response.json({ statuses: { m: { status: "disputed" } } });
    },
  });
  const provider = "new-provider" as string;
  const identifiers = [{ provider, identifier: "token", scope: "outcome" }] as const;
  const resolved = await md.resolveIdentifiers(identifiers);
  assert.equal(resolved.results[0].market_id, "m");
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { requests: identifiers });

  const unsupported = await md.tickSize("predictfun", { contractId: "m" });
  assert.equal("supported" in unsupported && unsupported.supported, false);
  assert.equal(requests[1].url.searchParams.get("contract_id"), "m");

  await md.tickSizes("polymarket", [{ contractId: "m", assetId: "token" }, { contractId: "m2" }]);
  assert.deepEqual(JSON.parse(String(requests[2].init?.body)), {
    provider: "polymarket", items: [{ contract_id: "m", asset_id: "token" }, { contract_id: "m2" }],
  });

  const marks = await md.marks(provider, [{ contractId: "m", tokenId: "token" }, { contractId: "m2", tokenId: "token2" }]);
  assert.equal(marks.marks[0].price, 60);
  assert.equal(requests[3].url.searchParams.get("pairs"), "m:token,m2:token2");

  assert.equal((await md.resolutionStatus(provider, "m/x")).status, "disputed");
  assert.equal(requests[4].url.pathname, "/v1/markets/new-provider/m%2Fx/resolution");
  assert.equal((await md.resolutionStatuses(provider, ["m", "m2"])).statuses.m.status, "disputed");
  assert.equal(requests[5].url.searchParams.get("market_ids"), "m,m2");
  assert.deepEqual((await md.resolutionEvents(provider, "m")).events, []);
  assert.equal(requests[6].url.pathname, "/v1/markets/new-provider/m/resolution/events");
});

test("reads batch candles, binary candles, a trade tape and a perpetual snapshot", async () => {
  const requests: { url: URL; init?: RequestInit }[] = [];
  const md = new MarketDataClient({
    baseUrl: "https://md.test",
    auth: { apiKey: { clientId: "test-client", apiKey: "test-key", apiSecret: "test-secret" } },
    fetch: async (input, init) => {
      const url = new URL(input);
      requests.push({ url, init });
      if (url.pathname === "/v1/candles/batch") return Response.json({ results: [{ index: 0, candles: [] }, { index: 1, candles: [], error: "bad window" }] });
      if (url.pathname === "/v1/candles") return new Response(new Uint8Array([0xca, 1, 1, 0]));
      if (url.pathname === "/v1/trades/tape") return Response.json({ trades: [], next_cursor: "next", has_more: true });
      if (url.pathname === "/v1/trades/metrics") return Response.json({ metrics: { trade_count: 19 } });
      return Response.json({ venue: "hyperliquid", venue_instrument_id: "dex:BTC/USD" });
    },
  });
  const first = { provider: "polymarket", contractId: "m", timeframeSeconds: 60, start: new Date("2026-10-01T00:00:00Z"), end: "2026-10-02T00:00:00Z" } as const;
  const signal = new AbortController().signal;
  const batch = await md.candlesBatch([first, { ...first, provider: "predictfun", outcome: 0 }], { signal });
  assert.equal(batch.results[1].error, "bad window");
  assert.ok(requests[0].init?.signal === signal);
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { requests: [
    { provider: "polymarket", contract_id: "m", timeframe_seconds: 60, start: "2026-10-01T00:00:00.000Z", end: first.end },
    { provider: "predictfun", contract_id: "m", timeframe_seconds: 60, start: "2026-10-01T00:00:00.000Z", end: first.end, outcome: 0 },
  ] });
  assert.deepEqual([...new Uint8Array(await md.candlesBinary(first))], [0xca, 1, 1, 0]);
  assert.equal(new Headers(requests[1].init?.headers).get("accept"), "application/x-kairos-candles");
  assert.equal(new Headers(requests[1].init?.headers).get("x-client-id"), "test-client");
  assert.equal(requests[1].init?.redirect, "error");

  assert.equal((await md.tradeTape({ provider: "kalshi", contractId: "KX-M", cursor: "opaque+/", limit: 5 })).next_cursor, "next");
  assert.equal(requests[2].url.searchParams.get("cursor"), "opaque+/");
  assert.equal((await md.tradeMetrics({ provider: "polymarket", contractId: "m", windowSeconds: 3600 })).metrics.trade_count, 19);
  assert.equal(requests[3].url.searchParams.get("window_seconds"), "3600");
  assert.equal((await md.perpetualSnapshot("hyperliquid", "dex:BTC/USD", { depth: 5 })).venue_instrument_id, "dex:BTC/USD");
  assert.equal(requests[4].url.pathname, "/v1/perpetuals/hyperliquid/dex%3ABTC%2FUSD/snapshot");
  assert.equal(requests[4].url.searchParams.get("depth"), "5");
});
