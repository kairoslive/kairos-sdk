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
