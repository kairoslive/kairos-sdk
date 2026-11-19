import { randomBytes } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import { createKairos, KairosError, type MarketStream } from "../../src/index.ts";

const environment = process.env.KAIROS_ENV ?? "production";
assert.ok(environment === "production" || environment === "staging", "KAIROS_ENV must be production or staging");
const prefix = environment === "staging" ? "staging-" : "";
const marketDataUrl = process.env.KAIROS_MARKET_DATA_URL ?? `https://${prefix}md.kairos.trade`;
const dataUrl = process.env.KAIROS_DATA_URL ?? `https://${prefix}data.kairos.trade`;
const executionUrl = process.env.KAIROS_EXECUTION_URL ?? `https://${prefix}execution.kairos.trade`;
const streamUrl = process.env.KAIROS_STREAM_URL ?? `wss://${prefix}stream.kairos.trade`;
const partnerId = process.env.KAIROS_PARTNER_ID;
const signer = { async request(): Promise<never> { throw new Error("Live read/quote checks must never prompt the wallet"); } };
const wallet = `0x${randomBytes(20).toString("hex")}`;
const sdk = createKairos({
  marketDataUrl,
  dataUrl,
  execution: { baseUrl: executionUrl },
  wallet: partnerId ? { baseUrl: executionUrl, partnerId, provider: signer } : undefined,
  fetch: (url, init) => fetch(url, { ...init, signal: init?.signal ?? AbortSignal.timeout(15_000) }),
});
const md = sdk.markets;

test(`[${environment}] market metadata and cursor pagination`, async () => {
  const page = await md.list("polymarket", { limit: 2 });
  assert.equal(page.markets.length, 2);
  assert.ok(page.next_cursor);
  const [market] = page.markets;
  assert.match(String(market.condition_id), /^0x[0-9a-f]{64}$/);
  assert.ok(market.outcomes.length >= 2 && market.outcomes[0].token_id);
  const next = await md.list("polymarket", { limit: 2, cursor: page.next_cursor });
  assert.notEqual(next.markets[0].market_id, market.market_id);
  assert.equal((await md.get("polymarket", market.market_id)).market_id, market.market_id);
});

test(`[${environment}] JSON and binary candles, tick grid, identifier lookup, and trades`, async () => {
  const { markets: [market] } = await md.list("polymarket", { limit: 1 });
  assert.ok(market.condition_id);
  const end = new Date();
  const start = new Date(end.getTime() - 24 * 3600 * 1000);
  const contract = { provider: "polymarket", contractId: market.condition_id };
  const query = { ...contract, timeframeSeconds: 3600 as const, start, end };
  const [candles, binary, batch, tick, identifiers, tape, metrics] = await Promise.all([
    md.candles(query),
    md.candlesBinary(query),
    md.candlesBatch([query]),
    md.tickSize("polymarket", { contractId: market.condition_id }),
    md.resolveIdentifiers([{ provider: "polymarket", scope: "market", identifier: market.condition_id }]),
    md.tradeTape({ ...contract, limit: 5 }),
    md.tradeMetrics(contract),
  ]);
  assert.ok(Array.isArray(candles.candles));
  assert.deepEqual([...new Uint8Array(binary).slice(0, 2)], [0xca, 1]);
  assert.ok(Array.isArray(batch.results[0]?.candles));
  assert.equal(batch.results[0]?.error ?? null, null);
  assert.equal(tick.provider, "polymarket");
  assert.equal(identifiers.results[0]?.found, true);
  assert.equal(identifiers.results[0]?.market_id, market.market_id);
  assert.ok(Array.isArray(tape.trades));
  assert.equal(typeof metrics.metrics.trade_count, "number");
});

function matchedEvents() {
  return md.events.list({ status: ["live", "open"], executableVenue: ["polymarket"], limit: 10 });
}

test(`[${environment}] Discover and matched market resolution`, async () => {
  const [discover, page] = await Promise.all([sdk.data.discover({ limit: 2 }), matchedEvents()]);
  assert.ok(discover.markets.length > 0);
  const [event] = page.events;
  const market = event?.markets?.[0];
  assert.ok(market?.route?.market);
  assert.match(market.books.yes, /^syn_/);
  const [detail, lookup] = await Promise.all([md.events.market(market.id), md.events.lookup([market.route.market])]);
  assert.equal(detail.event.id, event.id);
  assert.equal(detail.market.id, market.id);
  assert.equal(lookup.markets[market.route.market]?.market.id, market.id);
});

test(`[${environment}] stream ping, order book, and synthetic quote`, { skip: typeof WebSocket === "undefined" }, async () => {
  const { events } = await matchedEvents();
  const markets = events.flatMap((event) => event.markets ?? []);
  const contracts = new Set(markets.flatMap((market) => market.venues.filter((venue) => venue.exchange_id === "polymarket" && venue.open)
    .map((venue) => venue.market_id)).slice(0, 5));
  const books = new Set(markets.map((market) => market.books.yes).slice(0, 5));
  assert.ok(contracts.size && books.size);
  await new Promise<void>((resolve, reject) => {
    let stream: MarketStream | undefined;
    let pong = false;
    let book = false;
    let quote = false;
    const finish = (error?: Error) => {
      clearTimeout(timer);
      stream?.close();
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`Stream timed out (ping=${pong}, book=${book}, synthetic=${quote})`)), 15_000);
    stream = sdk.stream({
      url: streamUrl,
      onOpen: (live) => {
        live.ping(42);
        for (const contractId of contracts) live.subscribe({ provider: "polymarket", contractId, topics: ["orderbook_slow"] });
        for (const contractId of books) live.subscribe({ provider: "synthetic", contractId, topics: ["synthetic.quote"] });
      },
      onFrame: (frame) => {
        if (frame.type === "PongResponse" && frame.data.timestampMs === 42n) pong = true;
        if (frame.type === "OrderbookSnapshot" && frame.data.contractId && contracts.has(frame.data.contractId) &&
            (frame.data.outcomes?.length ?? 0) >= 2) book = true;
        if (frame.type === "SyntheticQuote" && frame.data.syntheticId && books.has(frame.data.syntheticId) &&
            (frame.data.bestBid || frame.data.bestAsk)) quote = true;
        if (pong && book && quote) finish();
      },
      onError: finish,
    });
  });
});

test(`[${environment}] trader positions include performance and position lists`, async () => {
  const address = process.env.KAIROS_TRADER_WALLET ?? "0x0000000000000000000000000000000000000001";
  const res = await sdk.traders.positions(address, { provider: "polymarket", limit: 1 });
  assert.equal(res.wallet_address.toLowerCase(), address.toLowerCase());
  assert.equal(typeof res.performance.total_realized_pnl, "string");
  assert.ok(Array.isArray(res.open_positions) && Array.isArray(res.closed_positions));
});

test(`[${environment}] Trading API route quote requires account credentials`, async () => {
  await assert.rejects(sdk.execution.routeQuote({ provider: "polymarket", market_id: "0x01", side: "yes", quantity: "1" }),
    (error) => error instanceof KairosError && error.status === 401);
});

test(`[${environment}] Partner API v3 wallet status and setup prerequisite`, { skip: !partnerId }, async () => {
  const status = await sdk.wallet.status(wallet);
  assert.equal(status.wallet.toLowerCase(), wallet.toLowerCase());
  assert.equal(status.next, "setup");
  assert.match(status.tradingWallet ?? "", /^0x[0-9a-f]{40}$/i);
  assert.ok(status.venues?.polymarket);
  await assert.rejects(sdk.wallet.comboQuote(wallet, { legs: ["1", "2"], side: "buy", amount: "1" }),
    (error) => error instanceof KairosError && error.status === 409 && /not set up/i.test(error.message));
});
