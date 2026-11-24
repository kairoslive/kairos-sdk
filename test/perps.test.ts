// Perps client: each method's request (host, path, query, body, auth) and its parsed response.
// Canned bodies are trimmed copies of what staging answered on 2026-11-24.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  createKairos, exactDecimal, isPerpError, KairosError, newClientOrderId, PerpHistoryIncompleteError, PerpsClient, PERPS_HOSTS,
} from "../src/index.ts";
import { fakeFetch, type Call, type Reply } from "./helpers.ts";

const KEY = { clientId: "cid", apiKey: "key", apiSecret: "secret" };
const EXEC = "https://exec.test";
const MD = "https://md.test";
const DATA = "https://data.test";

const ORDER = {
  id: "d0492e41-e316-4033-bc99-df591ebdbe4b", venue: "kalshi_margin", account: "0", instrument: "KXETHPERP",
  client_order_id: "0123456789abcdef0123456789abcdef", venue_order_id: "01a20ae6", side: "buy", kind: "limit", tif: "gtc",
  trigger: "none", trigger_price: null, price: "1.5", quantity: "1", filled_quantity: "0", avg_fill_price: null, fee: "0",
  status: "open", reason: null, expires_at: null, created_at: "2026-11-24T00:13:27Z", updated_at: "2026-11-24T00:13:27Z",
};
const FILL = {
  venue: "hyperliquid_perps", venue_fill_id: "f1", order_id: ORDER.id, account: "0xabc", instrument: "BTC", side: "buy",
  price: "64000.5", quantity: "0.01", fee: "0.02", maker: false, liquidation: false, occurred_at: "2026-11-22T10:00:00Z",
};
const POSITION = {
  venue: "kalshi_margin", account: "0", instrument: "KXETHPERP", quantity: "-1", entry_price: "1.7052", realized_pnl: "-0.0018",
  fees: "0.0381", funding: "0", liquidation_price: "7.8786", leverage: null, margin_mode: null, isolated_margin: null,
  opened_at: "2026-11-24T00:13:27.928Z", updated_at: "2026-11-24T00:13:27.928Z",
};
const ACCOUNT = {
  venue: "kalshi_margin", account: "0", equity: "6.5329", available: "6.1408", withdrawable: null, initial_margin: "0.3921",
  maintenance_margin: "0.3143", risk: null, observed_at: "2026-11-24T00:13:37.568994Z",
};
const INSTRUMENT_REF = { provider: "PROVIDER_HYPERLIQUID_PERPS", instrumentId: "hl-mainnet-btc-usdt", venueInstrumentId: "BTC" };
const SNAPSHOT = {
  venue: "hyperliquid", environment: "mainnet", integration_id: "hyperliquid-perps", canonical_instrument_id: "hl-mainnet-btc-usdt",
  venue_instrument_id: "BTC", source: "venue_public_api", fetched_at_ns: 1795479276700114814,
  instrument_context: { base_asset_id: "BTC", quote_asset_id: "USDT", collateral_asset_id: "USDC", settlement_asset_id: "USDC", price_unit: "quote_per_base_asset", quantity_unit: "base_asset", contract_multiplier: null, notional_formula: "quantity_times_price" },
  book: { bids: [{ price: "61211", quantity: "4.37942", order_count: 29 }], asks: [{ price: "61212", quantity: "0.44381", order_count: 4 }], event_time_ns: 1795479275975000000, received_time_ns: 1795479276700114814, source_sequence: null, sequence_domain: "hyperliquid:unsequenced-l2-snapshot", feed_mode: "snapshot_only", depth: 1, requested_depth: 1, source_depth_limit: 20, depth_limited: false, native_volume_unit: "base_asset" },
  market_state: { event_time_ns: 1795479276700124339, status: "active", funding_rate: "0.0000125", next_funding_time_ns: 1795482000000000000, measures: [], prices: [{ price_type: "mark", value: "61206", observed_time_ns: 1795479276700124339 }, { price_type: "oracle", value: "61232.7", observed_time_ns: null }] },
};

type Handler = (c: Call, url: URL) => Reply | undefined;

function client(handler: Handler, auth = true) {
  const { impl, calls } = fakeFetch([(c) => handler(c, new URL(c.url))]);
  const perps = new PerpsClient({ executionUrl: EXEC, marketDataUrl: MD, dataUrl: DATA, auth: auth ? { apiKey: KEY } : undefined, fetch: impl });
  return { perps, calls, url: (i = 0) => new URL(calls[i].url) };
}

const ok = (body: unknown): Handler => () => [200, body];
const failure = (promise: Promise<unknown>) => promise.then(() => assert.fail("expected a rejection"), (e: unknown) => e as KairosError);
const query = (u: URL) => Object.fromEntries(u.searchParams);

test("account reads margin and balance with the API key headers", async () => {
  const { perps, calls, url } = client(ok(ACCOUNT));
  const account = await perps.account("kalshi_margin");
  assert.equal(account?.equity, "6.5329");
  assert.equal(account?.maintenance_margin, "0.3143");
  assert.equal(url().origin + url().pathname, `${EXEC}/perps/account`);
  assert.deepEqual(query(url()), { venue: "kalshi_margin" });
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers["x-client-id"], "cid");
  assert.equal(calls[0].headers["x-api-key"], "key");
  assert.equal(calls[0].headers["x-api-secret"], "secret");

  const none = client(ok(null));
  assert.equal(await none.perps.account("hyperliquid_perps", { account: "0xabc" }), null);
  assert.deepEqual(query(none.url()), { venue: "hyperliquid_perps", account: "0xabc" });
});

test("positions read every venue or filter by venue and account", async () => {
  const { perps, url } = client(ok([POSITION]));
  const [position] = await perps.positions();
  assert.equal(position.quantity, "-1");
  assert.equal(position.liquidation_price, "7.8786");
  assert.equal(url().pathname, "/perps/positions");
  assert.equal(url().search, "");
  await perps.positions({ venue: "kalshi_margin", account: "0" });
  assert.deepEqual(query(url(1)), { venue: "kalshi_margin", account: "0" });
});

test("orders, exact lookup, fills and history read the right routes", async () => {
  const { perps, url } = client((c, u) => {
    if (u.pathname === "/perps/orders") return [200, [ORDER]];
    if (u.pathname.startsWith("/perps/orders/")) return [200, null];
    if (u.pathname === "/perps/fills") return [200, [FILL]];
    if (u.pathname === "/perps/history/fills") return [200, { items: [FILL], next_cursor: "c2", complete: true }];
    if (u.pathname === "/perps/history/orders") return [200, { items: [ORDER], next_cursor: null, complete: true }];
    return undefined;
  });
  assert.equal((await perps.orders("kalshi_margin"))[0].client_order_id, ORDER.client_order_id);
  assert.deepEqual(query(url(0)), { venue: "kalshi_margin" });

  assert.equal(await perps.order("polymarket_perps", "a/b c"), null);
  assert.equal(url(1).pathname, "/perps/orders/a%2Fb%20c");
  assert.deepEqual(query(url(1)), { venue: "polymarket_perps" });

  assert.equal((await perps.fills("hyperliquid_perps", { limit: 5 }))[0].price, "64000.5");
  assert.deepEqual(query(url(2)), { venue: "hyperliquid_perps", limit: "5" });

  const page = await perps.fillHistory("hyperliquid_perps", { limit: 500, cursor: "c1" });
  assert.equal(page.next_cursor, "c2");
  assert.deepEqual(query(url(3)), { venue: "hyperliquid_perps", limit: "500", cursor: "c1" });

  assert.equal((await perps.orderHistory("kalshi_margin")).items.length, 1);
  assert.equal(url(4).pathname, "/perps/history/orders");
});

test("allFills follows next_cursor until it is absent", async () => {
  const pages: Record<string, unknown> = {
    "": { items: [FILL, { ...FILL, venue_fill_id: "f2" }], next_cursor: "c2", complete: true },
    c2: { items: [{ ...FILL, venue_fill_id: "f3" }], next_cursor: null, complete: true },
  };
  const { perps, calls } = client((_, u) => [200, pages[u.searchParams.get("cursor") ?? ""]]);
  const ids: string[] = [];
  for await (const fill of perps.allFills("hyperliquid_perps", { limit: 2 })) ids.push(fill.venue_fill_id);
  assert.deepEqual(ids, ["f1", "f2", "f3"]);
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[1].url).searchParams.get("limit"), "2");
});

test("allOrders throws PerpHistoryIncompleteError after yielding an incomplete page", async () => {
  const { perps } = client(ok({ items: [ORDER], next_cursor: "c9", complete: false }));
  const seen: string[] = [];
  await assert.rejects(async () => {
    for await (const order of perps.allOrders("kalshi_margin")) seen.push(order.id);
  }, (error: unknown) => error instanceof PerpHistoryIncompleteError && error.cursor === "c9");
  assert.deepEqual(seen, [ORDER.id]);
});

test("funding payments page through Hyperliquid history", async () => {
  const payment = { time_ms: 1, instrument: "BTC", receipt_hash: "0x1", amount: "-0.01", size: "0.1", rate: "0.0000125" };
  const { perps, calls } = client((_, u) => [200, u.searchParams.get("cursor")
    ? { items: [{ ...payment, time_ms: 0 }], next_cursor: null, through_ms: 5 }
    : { items: [payment], next_cursor: "n", through_ms: 5 }]);
  const page = await perps.fundingPayments({ account: "0xabc", scope: "builder", limit: 1 });
  assert.equal(page.items[0].rate, "0.0000125");
  assert.deepEqual(query(new URL(calls[0].url)), { account: "0xabc", scope: "builder", limit: "1" });
  const all = [];
  for await (const p of perps.allFundingPayments()) all.push(p.time_ms);
  assert.deepEqual(all, [1, 0]);
  assert.equal(new URL(calls[1].url).pathname, "/perps/history/funding");
});

test("instrument rules, leverage and Kalshi subaccounts", async () => {
  const rules = { venue: "kalshi_margin", instrument: "KXBTCPERP", symbol: null, status: "open", tick_size: "0.0001", price_decimals: null, price_sig_figs: null, size_step: "1", size_sig_figs: null, min_quantity: "1", min_notional: null, max_notional: null, max_market_notional: null, max_leverage: null, margin_modes: [] };
  const leverage = { venue: "hyperliquid_perps", account: "0xabc", instrument: "BTC", leverage: 20, margin_mode: "cross", max_leverage: 40 };
  const { perps, url } = client((_, u) => {
    if (u.pathname === "/perps/instruments") return [200, [rules]];
    if (u.pathname === "/perps/leverage") return [200, leverage];
    if (u.pathname === "/perps/kalshi/accounts") return [200, ["0", "1"]];
    return undefined;
  });
  assert.equal((await perps.instrumentRules("kalshi_margin", { instrument: "KXBTCPERP" }))[0].tick_size, "0.0001");
  assert.deepEqual(query(url(0)), { venue: "kalshi_margin", instrument: "KXBTCPERP" });
  assert.equal((await perps.leverage("hyperliquid_perps", "BTC")).max_leverage, 40);
  assert.deepEqual(query(url(1)), { venue: "hyperliquid_perps", instrument: "BTC" });
  assert.deepEqual(await perps.kalshiAccounts(), ["0", "1"]);
});

test("placeOrder posts the API's order body unchanged", async () => {
  const { perps, calls } = client(ok(ORDER));
  const order = {
    venue: "kalshi_margin", instrument: "KXETHPERP", client_order_id: ORDER.client_order_id,
    side: "buy", kind: "limit", tif: "gtc", price: "1.5", quantity: "1", post_only: true,
  } as const;
  const placed = await perps.placeOrder(order);
  assert.equal(placed.status, "open");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].url, `${EXEC}/perps/orders`);
  assert.deepEqual(calls[0].body, order);
  assert.equal(calls[0].headers["content-type"], "application/json");
});

test("cancelOrder, cancelAll and reconcile send venue and account", async () => {
  const { perps, calls } = client((c, u) => {
    if (c.method === "DELETE") return [200, { ...ORDER, status: "cancelled" }];
    if (u.pathname === "/perps/orders/cancel-all") return [200, { requested: true }];
    if (u.pathname === "/perps/reconcile") return [200, { reconciled: true }];
    return undefined;
  });
  assert.equal((await perps.cancelOrder("hyperliquid_perps", ORDER.client_order_id, { account: "0" })).status, "cancelled");
  assert.equal(calls[0].method, "DELETE");
  assert.equal(new URL(calls[0].url).pathname, `/perps/orders/${ORDER.client_order_id}`);
  assert.deepEqual(query(new URL(calls[0].url)), { venue: "hyperliquid_perps", account: "0" });

  assert.deepEqual(await perps.cancelAll("kalshi_margin"), { requested: true });
  assert.deepEqual(calls[1].body, { venue: "kalshi_margin", account: "0" });
  assert.equal(calls[1].method, "POST");

  assert.deepEqual(await perps.reconcile("polymarket_perps", { account: "0xabc" }), { reconciled: true });
  assert.deepEqual(calls[2].body, { venue: "polymarket_perps", account: "0xabc" });
});

test("perps errors keep status, the top-level PERP code and the stable class", async () => {
  const body = { error: "PERP_PRICE_OFF_GRID: price is not on the grid", code: "PERP_PRICE_OFF_GRID", error_details: { code: "VALIDATION_INVALID_ORDER", message: "price is not on the grid", actions: [] } };
  const { perps } = client(() => [400, body]);
  const error = await failure(perps.placeOrder({ venue: "hyperliquid_perps", instrument: "BTC", client_order_id: newClientOrderId(), side: "buy", kind: "limit", tif: "gtc", price: "1.23456", quantity: "0.001" }));
  assert.ok(error instanceof KairosError);
  assert.equal(error.status, 400);
  assert.equal(error.code, "PERP_PRICE_OFF_GRID");
  assert.equal(error.message, body.error);
  assert.ok(isPerpError(error, "VALIDATION_INVALID_ORDER"));
  assert.ok(isPerpError(error, "PERP_PRICE_OFF_GRID"));
  assert.equal(error.outcomeUnknown, false);

  const unknown = client(() => [502, { error: "venue did not answer", code: "PERP_OUTCOME_UNKNOWN", error_details: { code: "EXCHANGE_ERROR", message: "", actions: [] } }]);
  const lost = await failure(unknown.perps.cancelOrder("kalshi_margin", "x"));
  assert.equal(lost.outcomeUnknown, true);

  const paused = client(() => [503, { error: "paused", code: "MARKET_PAUSED", error_details: { code: "MARKET_PAUSED", message: "paused", actions: [] } }]);
  const halt = await failure(paused.perps.placeOrder({ venue: "kalshi_margin", instrument: "KXBTCPERP", client_order_id: "x", side: "buy", kind: "limit", tif: "gtc", price: "1", quantity: "1" }));
  assert.equal(halt.status, 503);
  assert.equal(halt.outcomeUnknown, false);
});

test("execution calls without auth fail before any request", async () => {
  const { perps, calls } = client(ok([]), false);
  await assert.rejects(perps.positions(), /need `auth`/);
  assert.equal(calls.length, 0);
});

test("market data: venues and instruments from the Data API, without a key", async () => {
  const venue = { venue: "hyperliquid", environment: "mainnet", market_data_service: "market_data_api", instruments: true, book: true, trades: true, candles: true, funding: true, market_state: true, notes: [] };
  const instrument = { instrument_id: "hl-mainnet-btc-usdt", venue: "hyperliquid", execution_venue: "hyperliquid_perps", execution_instrument_id: "BTC", venue_instrument_id: "BTC" };
  const { perps, calls } = client((_, u) => (u.pathname === "/perpetuals/venues" ? [200, [venue]] : [200, [instrument]]), false);
  assert.equal((await perps.markets.venues())[0].funding, true);
  assert.equal(calls[0].url, `${DATA}/perpetuals/venues`);
  assert.equal(calls[0].headers["x-api-key"], undefined);
  const [row] = await perps.markets.instruments({ venue: "hyperliquid" });
  assert.equal(row.execution_instrument_id, "BTC");
  assert.equal(calls[1].url, `${DATA}/perpetuals/instruments?venue=hyperliquid`);
});

test("market data: snapshot and current funding", async () => {
  const { perps, calls } = client(ok(SNAPSHOT), false);
  const snap = await perps.markets.snapshot("hyperliquid", "xyz:TSLA", { depth: 5 });
  assert.equal(snap.book.bids[0].price, "61211");
  assert.equal(calls[0].url, `${MD}/v1/perpetuals/hyperliquid/xyz%3ATSLA/snapshot?depth=5`);
  const funding = await perps.markets.currentFunding("hyperliquid_perps", "BTC");
  assert.equal(funding.funding_rate, "0.0000125");
  assert.equal(funding.next_funding_time_ns, "1795482000000000000");
  assert.match(funding.event_time_ns, /^17954792767001\d{5}$/); // a JSON number above 2^53: last digits rounded
  assert.equal(funding.mark, "61206");
  assert.equal(funding.source, "snapshot");
  assert.equal(funding.instrument_id, "hl-mainnet-btc-usdt");
  assert.equal(calls.length, 2, "no stored-state read when the snapshot has a rate");
  assert.equal(calls[1].url, `${MD}/v1/perpetuals/hyperliquid_perps/BTC/snapshot?depth=1`);
});

test("market data: current funding falls back to stored state when the snapshot has no rate (Kalshi Margin)", async () => {
  const kalshi = {
    ...SNAPSHOT, venue: "kalshi_margin", canonical_instrument_id: "kalshi-margin-mainnet-kxbtcperp", venue_instrument_id: "KXBTCPERP",
    market_state: { ...SNAPSHOT.market_state, funding_rate: null, next_funding_time_ns: null, prices: [{ price_type: "settlement_mark", value: "6.1253", observed_time_ns: null }] },
  };
  const row = (t: string, rate?: { coefficient: string; scale?: number }) => ({ instrument: INSTRUMENT_REF, eventTimeNs: t, stateSource: "ticker", fundingRate: rate, nextFundingTimeNs: "1795496400000000000" });
  const { perps, calls } = client((_, u) => {
    if (u.pathname.endsWith("/snapshot")) return [200, kalshi];
    return [200, u.searchParams.get("cursor") ? { data: [row("3")] } : { data: [row("1", { coefficient: "5", scale: 6 }), row("2", { coefficient: "17", scale: 5 })], nextCursor: "n" }];
  }, false);
  const funding = await perps.markets.currentFunding("kalshi_margin", "KXBTCPERP");
  assert.deepEqual(funding, {
    venue: "kalshi_margin", instrument_id: "kalshi-margin-mainnet-kxbtcperp", venue_instrument_id: "KXBTCPERP", mark: null,
    funding_rate: "0.00017", next_funding_time_ns: "1795496400000000000", event_time_ns: "2", source: "stored_state",
  });
  const state = new URL(calls[1].url);
  assert.equal(state.pathname, "/v1/perpetuals/kalshi_margin/kalshi-margin-mainnet-kxbtcperp/state");
  assert.equal(Number(state.searchParams.get("to")) - Number(state.searchParams.get("from")), 120_000);
  assert.equal(calls.length, 3, "follows the state cursor to the newest row");
});

test("market data errors expose the nested error.code", async () => {
  const { perps } = client(() => [429, { error: { code: "rate_limited", message: "anonymous rate limit exceeded" } }], false);
  const error = await failure(perps.markets.trades("hyperliquid", "BTC"));
  assert.equal(error.status, 429);
  assert.equal(error.code, "rate_limited");
  assert.equal(error.message, "anonymous rate limit exceeded");
});

test("market data: history pages send from, to, limit, cursor, interval and kind", async () => {
  const trade = { instrument: INSTRUMENT_REF, tradeId: "t1", eventTimeNs: "1", price: { coefficient: "64658" }, quantity: { coefficient: "3", scale: 4 } };
  const { perps, calls } = client((_, u) => [200, { data: u.pathname.endsWith("/trades") ? [trade] : [] }], false);
  const from = new Date("2026-11-23T00:00:00Z");
  const page = await perps.markets.trades("hyperliquid", "hl-mainnet-btc-usdt", { from, to: 1795479276000, limit: 2, cursor: "k" });
  assert.equal(exactDecimal(page.data[0].quantity), "0.0003");
  const u0 = new URL(calls[0].url);
  assert.equal(u0.pathname, "/v1/perpetuals/hyperliquid/hl-mainnet-btc-usdt/trades");
  assert.deepEqual(query(u0), { from: "2026-11-23T00:00:00.000Z", to: "1795479276000", limit: "2", cursor: "k" });

  await perps.markets.candles("kalshi_margin", "KXBTCPERP", { interval: "1h", kind: "mark" });
  assert.deepEqual(query(new URL(calls[1].url)), { interval: "1h", kind: "mark" });
  for (const [method, route] of [["funding", "funding"], ["state", "state"], ["liquidations", "liquidations"]] as const) {
    await perps.markets[method]("polymarket_perps", "1");
    assert.equal(new URL(calls.at(-1)!.url).pathname, `/v1/perpetuals/polymarket_perps/1/${route}`);
  }
});

test("market data: all* follows nextCursor with the same pinned range", async () => {
  const candle = (n: string) => ({ instrument: INSTRUMENT_REF, intervalLabel: "1m", intervalStartNs: n });
  const { perps, calls } = client((_, u) => [200, u.searchParams.get("cursor")
    ? { data: [candle("3")] }
    : { data: [candle("1"), candle("2")], nextCursor: "p2" }], false);
  const starts: string[] = [];
  for await (const c of perps.markets.allCandles("hyperliquid", "BTC", { interval: "1m", limit: 2 })) starts.push(c.intervalStartNs);
  assert.deepEqual(starts, ["1", "2", "3"]);
  const [first, second] = calls.map((c) => new URL(c.url).searchParams);
  assert.ok(first.get("to"), "the iterator pins `to` on the first page");
  assert.equal(second.get("to"), first.get("to"));
  assert.equal(second.get("cursor"), "p2");
  assert.equal(second.get("interval"), "1m");
});

test("market data: a repeated cursor stops the iterator instead of looping", async () => {
  const { perps } = client(ok({ data: [], nextCursor: "same" }), false);
  await assert.rejects(async () => {
    for await (const _ of perps.markets.allTrades("hyperliquid", "BTC")) void _;
  }, /same cursor twice/);
});

test("exactDecimal formats coefficient and scale exactly", () => {
  assert.equal(exactDecimal({ coefficient: "-214094", scale: 10 }), "-0.0000214094");
  assert.equal(exactDecimal({ coefficient: "646844", scale: 1 }), "64684.4");
  assert.equal(exactDecimal({ coefficient: "64658" }), "64658");
  assert.equal(exactDecimal({ coefficient: "1500", scale: 3 }), "1.5");
  assert.equal(exactDecimal({ coefficient: "0", scale: 4 }), "0");
  assert.equal(exactDecimal({ coefficient: "-0", scale: 2 }), "0");
  assert.equal(exactDecimal({ coefficient: "12", scale: -2 }), "1200");
  assert.throws(() => exactDecimal({ coefficient: "1e5" }), TypeError);
});

test("newClientOrderId is 32 lowercase hex and unique", () => {
  const a = newClientOrderId();
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, newClientOrderId());
});

test("hosts default to staging; production and explicit URLs override", async () => {
  const seen: string[] = [];
  const fetchImpl = async (url: string) => { seen.push(url); return new Response("[]", { status: 200 }); };
  await new PerpsClient({ auth: { apiKey: KEY }, fetch: fetchImpl }).positions();
  await new PerpsClient({ environment: "production", auth: { apiKey: KEY }, fetch: fetchImpl }).positions();
  await new PerpsClient({ environment: "production", executionUrl: "https://own.test/", auth: { apiKey: KEY }, fetch: fetchImpl }).positions();
  await createKairos({ perps: { auth: { apiKey: KEY } }, fetch: fetchImpl }).perps.markets.venues();
  assert.deepEqual(seen, [
    `${PERPS_HOSTS.staging.executionUrl}/perps/positions`,
    `${PERPS_HOSTS.production.executionUrl}/perps/positions`,
    "https://own.test/perps/positions",
    `${PERPS_HOSTS.staging.dataUrl}/perpetuals/venues`,
  ]);
});
