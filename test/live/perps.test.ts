// Live perps smoke test. Skipped unless KAIROS_SDK_LIVE=1.
//
//   KAIROS_SDK_LIVE=1 pnpm test:live:perps
//
// Read-only by default: discovery, books, funding and history, plus your margin, positions, orders and fills when a
// key is given (KAIROS_CLIENT_ID / KAIROS_API_KEY / KAIROS_API_SECRET, or KAIROS_SDK_CREDENTIALS_FILE pointing at a
// JSON file {client_id, api_key, api_secret}). The key needs `trade:read`.
//
// The order path is a second opt-in, KAIROS_SDK_LIVE_ORDERS=1, staging only and never on by default. It posts one
// post-only Hyperliquid BTC buy at half the best bid, sized at the venue's minimum notional, so it cannot fill. It then
// reads it back, cancels it by client_order_id and checks it is cancelled. The staging executor trades on live
// venues: the key needs `trade:execute` on an account you control. A 403 (no `trade:execute`) or 503 (perps execution
// switched off) skips the check once and is never retried.

import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

import { KairosError, newClientOrderId, PerpsClient, type PerpVenue, type PerpsEnvironment } from "../../src/index.ts";

const live = process.env.KAIROS_SDK_LIVE === "1";
const environment = (process.env.KAIROS_ENV ?? "staging") as PerpsEnvironment;
assert.ok(environment === "staging" || environment === "production", "KAIROS_ENV must be staging or production");
const orders = process.env.KAIROS_SDK_LIVE_ORDERS === "1";
if (orders) {
  assert.equal(environment, "staging", "the live order path runs on staging only");
  for (const name of ["KAIROS_EXECUTION_URL", "KAIROS_MARKET_DATA_URL"]) {
    const url = process.env[name];
    if (url) {
      const { protocol, hostname } = new URL(url);
      assert.ok(protocol === "https:" && /^staging-[a-z]+\.kairos\.trade$/.test(hostname), `${name} must be an https staging host for the order path`);
    }
  }
}

function credentials() {
  const file = process.env.KAIROS_SDK_CREDENTIALS_FILE;
  if (file) {
    const k = JSON.parse(readFileSync(file, "utf8")) as { client_id: string; api_key: string; api_secret: string };
    return { clientId: k.client_id, apiKey: k.api_key, apiSecret: k.api_secret };
  }
  const { KAIROS_CLIENT_ID: clientId, KAIROS_API_KEY: apiKey, KAIROS_API_SECRET: apiSecret } = process.env;
  return clientId && apiKey && apiSecret ? { clientId, apiKey, apiSecret } : undefined;
}

const key = live ? credentials() : undefined;
const perps = new PerpsClient({
  environment,
  executionUrl: process.env.KAIROS_EXECUTION_URL,
  marketDataUrl: process.env.KAIROS_MARKET_DATA_URL,
  dataUrl: process.env.KAIROS_DATA_URL,
  auth: key ? { apiKey: key } : undefined,
  fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(20_000) }),
});
const venues: PerpVenue[] = ["hyperliquid_perps", "polymarket_perps", "kalshi_margin"];
// One liquid instrument per venue: market-data id and execution id.
const probe = { hyperliquid_perps: "BTC", polymarket_perps: "1", kalshi_margin: "KXBTCPERP" } as const;
const skip = !live && "set KAIROS_SDK_LIVE=1";
const skipKey = skip || (!key && "no API key");

test(`[${environment}] discovery: venues and instruments map to execution ids`, { skip }, async () => {
  const listed = await perps.markets.venues();
  assert.deepEqual(listed.map((v) => v.venue).sort(), ["hyperliquid", "kalshi_margin", "polymarket_perps"]);
  for (const venue of venues) {
    const instruments = await perps.markets.instruments({ venue });
    assert.ok(instruments.length > 0, `${venue} lists instruments`);
    assert.ok(instruments.every((i) => i.execution_venue === venue), `${venue} rows carry their execution venue`);
    assert.ok(instruments.some((i) => i.execution_instrument_id === probe[venue]), `${venue} lists ${probe[venue]}`);
  }
});

test(`[${environment}] books and current funding on every venue`, { skip }, async () => {
  for (const venue of venues) {
    const snap = await perps.markets.snapshot(venue, probe[venue], { depth: 3 });
    assert.equal(snap.venue_instrument_id, probe[venue]);
    assert.ok(snap.book.bids.length > 0 && snap.book.asks.length > 0, `${venue} book has both sides`);
    assert.ok(Number(snap.book.bids[0].price) < Number(snap.book.asks[0].price), `${venue} book is not crossed`);
    const funding = await perps.markets.currentFunding(venue, probe[venue]);
    assert.match(String(funding.funding_rate), /^-?\d+(\.\d+)?$/, `${venue} states a funding rate`);
  }
});

test(`[${environment}] stored history pages and follows cursors`, { skip }, async () => {
  const to = Date.now();
  const from = to - 60 * 60 * 1000;
  const trades = await perps.markets.trades("polymarket_perps", "1", { from, to, limit: 5 });
  assert.ok(trades.nextCursor, "a 5-row page of an hour of trades has more behind it");
  let rows = 0;
  let last = 0n;
  for await (const trade of perps.markets.allTrades("polymarket_perps", "1", { from, to, limit: 5 })) {
    const at = BigInt(trade.eventTimeNs);
    assert.ok(at >= last, "rows ascend by event time across pages");
    last = at;
    if (++rows >= 12) break; // three pages
  }
  assert.equal(rows, 12);
  for (const venue of venues) {
    const candles = await perps.markets.candles(venue, probe[venue], { interval: "1h", limit: 2, from: to - 6 * 3600_000, to });
    assert.ok(candles.data.length > 0, `${venue} has hourly candles`);
    const state = await perps.markets.state(venue, probe[venue], { limit: 1, from: to - 3600_000, to });
    assert.ok(state.data.length > 0, `${venue} has market state in the last hour`);
  }
  const funding = await perps.markets.funding("hyperliquid", "BTC", { limit: 2, from: to - 24 * 3600_000, to });
  assert.ok(funding.data.length > 0, "a day of BTC funding is stored");
  await perps.markets.liquidations("hyperliquid", "BTC", { limit: 1 });
});

test(`[${environment}] every venue has trades stored in the last hour`, { skip }, async () => {
  const to = Date.now();
  const stale = [];
  for (const venue of venues) {
    const recent = await perps.markets.trades(venue, probe[venue], { from: to - 3600_000, to, limit: 1 });
    if (recent.data.length === 0) stale.push(`${venue}/${probe[venue]}`);
  }
  assert.deepEqual(stale, []);
});

test(`[${environment}] account: margin, positions, orders, fills and history`, { skip: skipKey }, async () => {
  for (const venue of venues) {
    const account = await perps.account(venue);
    if (account) assert.equal(account.venue, venue);
    assert.ok(Array.isArray(await perps.orders(venue)));
    assert.equal(await perps.order(venue, newClientOrderId()), null, "an unknown client order id reads as null");
    assert.ok(Array.isArray(await perps.fills(venue, { limit: 5 })));
    const fills = await perps.fillHistory(venue, { limit: 5 });
    assert.equal(typeof fills.complete, "boolean");
    const history = await perps.orderHistory(venue, { limit: 5 });
    assert.ok(Array.isArray(history.items));
    let n = 0;
    for await (const _ of perps.allOrders(venue, { limit: 2 })) if (++n >= 4) break;
  }
  const positions = await perps.positions();
  for (const p of positions) assert.ok(venues.includes(p.venue as PerpVenue) && p.quantity !== "0");
  assert.deepEqual(await perps.positions({ venue: "kalshi_margin" }), positions.filter((p) => p.venue === "kalshi_margin"));
  const funding = await perps.fundingPayments({ limit: 5 });
  assert.ok(Array.isArray(funding.items));
  assert.ok((await perps.kalshiAccounts()).includes("0"));
  const [rules] = await perps.instrumentRules("hyperliquid_perps", { instrument: "BTC" });
  assert.equal(rules.instrument, "BTC");
  assert.ok(Number(rules.size_step) > 0);
  const kalshi = await perps.instrumentRules("kalshi_margin", { instrument: "KXBTCPERP" });
  assert.ok(kalshi[0].tick_size);
  const leverage = await perps.leverage("hyperliquid_perps", "BTC");
  assert.ok(leverage.leverage >= 1 && leverage.leverage <= leverage.max_leverage);
});

test(`[${environment}] order path: rest a post-only limit far from the market, then cancel it`, {
  skip: skipKey || (!orders && "set KAIROS_SDK_LIVE_ORDERS=1 (staging, trade:execute) to place and cancel one resting order"),
}, async (t) => {
  const [rules] = await perps.instrumentRules("hyperliquid_perps", { instrument: "BTC" });
  const snap = await perps.markets.snapshot("hyperliquid_perps", "BTC", { depth: 1 });
  const price = Math.floor(Number(snap.book.bids[0].price) / 2); // Hyperliquid always accepts a whole price
  const step = Number(rules.size_step);
  const decimals = rules.size_step.split(".")[1]?.length ?? 0;
  const minNotional = Number(rules.min_notional ?? "10") * 1.1;
  const quantity = (Math.ceil(minNotional / price / step) * step).toFixed(decimals);
  const clientOrderId = newClientOrderId();
  let placed;
  try {
    placed = await perps.placeOrder({
      venue: "hyperliquid_perps", instrument: "BTC", client_order_id: clientOrderId,
      side: "buy", kind: "limit", tif: "gtc", post_only: true, price: String(price), quantity,
    });
  } catch (error) {
    if (error instanceof KairosError && (error.status === 403 || error.status === 503)) {
      t.skip(`order path refused before reaching the venue: ${error.status} ${error.code ?? ""} ${error.message}`);
      return;
    }
    // A timeout or an unknown outcome may have left the order resting: clean it up by our id before failing.
    const status = await cleanUp(clientOrderId);
    if (status !== "cancelled" && status !== "absent" && status !== "rejected") {
      console.error(`order ${clientOrderId} not confirmed cancelled after a failed placement (last status ${status}); check it by hand`);
    }
    throw error;
  }
  let status = "not cleaned up";
  try {
    assert.equal(placed.client_order_id, clientOrderId);
    assert.equal((await perps.order("hyperliquid_perps", clientOrderId))?.client_order_id, clientOrderId);
  } finally {
    status = await cleanUp(clientOrderId);
    if (status !== "cancelled") console.error(`order ${clientOrderId} not confirmed cancelled (last status ${status}); check it by hand`);
  }
  assert.equal(status, "cancelled", `order ${clientOrderId} must end cancelled; last status ${status}`);
});

/**
 * Cancels by client order id and reads the order back until a read shows it final. Ten attempts, 2 s apart, with a
 * cancel on attempts 1, 4, 7 and 10; each request has the suite's 20 s timeout. Only a read decides the status, and a
 * `null` read (not visible yet, e.g. after a timed-out placement) keeps retrying. Returns the last status read:
 * an order status, `absent` (the last successful read returned `null`) or `unreadable`.
 */
async function cleanUp(clientOrderId: string): Promise<string> {
  const final = new Set(["cancelled", "filled", "expired", "rejected"]);
  let status = "unreadable";
  for (let attempt = 0; attempt < 10; attempt++) {
    if (attempt % 3 === 0) await perps.cancelOrder("hyperliquid_perps", clientOrderId).catch(() => {});
    const order = await perps.order("hyperliquid_perps", clientOrderId).catch(() => undefined);
    if (order === null) status = "absent";
    else if (order) status = String(order.status);
    if (final.has(status)) return status;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return status;
}
