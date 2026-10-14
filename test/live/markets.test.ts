// Hits the public Market Data API. Run with `npm run test:live`.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createKairos } from "../../src/index.ts";

const md = createKairos({ marketDataUrl: process.env.KAIROS_MARKET_DATA_URL }).markets;

test("lists Polymarket markets with condition ids and outcomes, and pages", async () => {
  const page = await md.list("polymarket", { limit: 2 });
  assert.equal(page.markets.length, 2);
  const m = page.markets[0];
  assert.match(String(m.condition_id), /^0x[0-9a-f]{64}$/);
  assert.ok(m.outcomes.length >= 2 && m.outcomes[0].token_id);
  const next = await md.list("polymarket", { limit: 2, cursor: page.next_cursor ?? undefined });
  assert.notEqual(next.markets[0].market_id, m.market_id);
  const one = await md.get("polymarket", m.market_id);
  assert.equal(one.market_id ?? (one as Record<string, unknown>).id, m.market_id);
});

test("trades and candles answer for a live market", async () => {
  const { markets } = await md.list("polymarket", { limit: 1 });
  const id = markets[0].condition_id!;
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 3600 * 1000);
  const candles = await md.candles({ provider: "polymarket", contractId: id, timeframeSeconds: 3600, start, end });
  assert.ok(candles && typeof candles === "object");
  const trades = await md.trades({ provider: "polymarket", contractId: markets[0].market_id, limit: 5 });
  assert.ok(trades && typeof trades === "object");
});
