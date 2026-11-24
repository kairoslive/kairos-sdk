// Perps: Hyperliquid perps, Polymarket Perps and Kalshi Margin.
//
// Three hosts serve perps. The Data API lists venues and instruments. The Market Data API serves books, funding, trades,
// candles, market state and liquidations; it is public. The Order Execution API serves your margin, positions, orders
// and fills, and places and cancels orders; it needs an API key. Types come from the perps paths of Kairos' OpenAPI
// specs (`scripts/generate-perps-openapi.mjs`). Where the handlers differ from the spec, the type follows the handler
// and says so.
//
// Every decimal is an exact string. Never parse prices, sizes or margins into a JS number for arithmetic.

import type { CallOptions } from "./common.ts";
import { Http, KairosError, type FetchLike, type Query } from "./http.ts";
import { RestClient, restAuthHeaders } from "./rest.ts";
import type { ApiKeyCredentials } from "./wallets.ts";
import type { components as ExecutionComponents } from "./openapi/perps-execution.ts";
import type { components as MarketDataComponents, paths as PerpsMarketDataPaths } from "./openapi/perps-market-data.ts";
import type { components as DataComponents, paths as PerpsDataPaths } from "./openapi/perps-data.ts";

export type { PerpsMarketDataPaths, PerpsDataPaths };
export type { paths as PerpsExecutionPaths } from "./openapi/perps-execution.ts";

type Exec = ExecutionComponents["schemas"];
type Md = MarketDataComponents["schemas"];
type Data = DataComponents["schemas"];

// ---------------------------------------------------------------------------------------------------------------------
// Hosts

export type PerpsEnvironment = "staging" | "production";

/**
 * Base URLs per environment. Perps defaults to staging: production serves only `POST/GET /perps/orders`,
 * `DELETE /perps/orders/{id}`, cancel-all, positions and reconcile today. The other execution routes answer 404 there.
 * The staging executor trades on live venues with real funds.
 */
export const PERPS_HOSTS = {
  staging: {
    executionUrl: "https://staging-execution.kairos.trade",
    marketDataUrl: "https://staging-md.kairos.trade",
    dataUrl: "https://staging-data.kairos.trade",
  },
  production: {
    executionUrl: "https://execution.kairos.trade",
    marketDataUrl: "https://md.kairos.trade",
    dataUrl: "https://data.kairos.trade",
  },
} as const satisfies Record<PerpsEnvironment, { executionUrl: string; marketDataUrl: string; dataUrl: string }>;

export interface PerpsOptions {
  /** Picks the default hosts. Default `staging`. */
  environment?: PerpsEnvironment;
  /** Order Execution API base URL (`/perps/*`). Overrides `environment`. */
  executionUrl?: string;
  /** Market Data API base URL (`/v1/perpetuals/*`). Overrides `environment`. */
  marketDataUrl?: string;
  /** Data API base URL (`/perpetuals/venues`, `/perpetuals/instruments`). Overrides `environment`. */
  dataUrl?: string;
  /**
   * The API key triple, sent as `x-client-id`, `x-api-key` and `x-api-secret`. Execution reads need `trade:read`; orders,
   * cancels, cancel-all and reconcile need `trade:execute`. Public market data works without a key, and a key raises
   * the rate budget. Keep the secret on a server. (A browser session bearer would also need a CSRF header, so it is not offered.)
   */
  auth?: { apiKey: ApiKeyCredentials };
  fetch?: FetchLike;
}

// ---------------------------------------------------------------------------------------------------------------------
// Execution types (Order Execution API, `/perps/*`)

/** The execution venue. Market data also accepts `hyperliquid` for `hyperliquid_perps`. */
export type PerpVenue = Exec["PerpVenue"];
export type PerpSide = Exec["PerpOrderRequest"]["side"];
export type PerpOrderKind = Exec["PerpOrderRequest"]["kind"];
export type PerpTimeInForce = Exec["PerpOrderRequest"]["tif"];
export type PerpTrigger = Exec["PerpOrderRequest"]["trigger"];
export type PerpMarginMode = NonNullable<Exec["PerpOrderRequest"]["margin_mode"]>;
export type PerpOrderStatus = NonNullable<Exec["PerpOrder"]["status"]>;

/**
 * Margin and balance for one venue account, in the venue's collateral (USDC on Hyperliquid, pUSD on Polymarket Perps,
 * USD on Kalshi Margin). `risk` is `healthy`, `margin_call`, `liquidating` or `reduce_only`. A null field means the
 * venue did not report it.
 */
export type PerpAccount = Exec["PerpAccount"];

/**
 * An open position. `quantity` is signed (negative is short), in the venue's native unit: base asset on Hyperliquid,
 * contracts on Polymarket Perps and Kalshi Margin. `realized_pnl`, `fees` and `funding` are in collateral.
 */
export type PerpPosition = Exec["PerpPosition"] & {
  // The handler (PerpPositionView) serves these; execution.yaml leaves them out.
  leverage?: number | null;
  margin_mode?: PerpMarginMode | null;
  isolated_margin?: string | null;
};

/** An order. `id` is Kairos' order id; fills reference it as `order_id`. `price` is the limit (or worst) price. */
export type PerpOrder = Exec["PerpOrder"];
/** A fill. `price` is per native unit; `fee` is in collateral. `liquidation` is true when the venue flagged it. */
export type PerpFill = Exec["PerpFill"];
export type PerpFillPage = Exec["PerpFillPage"];
export type PerpOrderPage = Exec["PerpOrderPage"];
/** Hyperliquid funding payments. `amount` is in USDC (negative means you paid); `rate` is per funding interval. */
export type PerpFundingPaymentsPage = Exec["PerpFundingPage"];
export type PerpFundingPayment = PerpFundingPaymentsPage["items"][number];
/** The body of a perps handler error. `error_details.code` is the stable class; top-level `code` can be a `PERP_*` code. */
export type PerpErrorBody = Exec["OrderErrorResponse"];

type OrderRequest = Exec["PerpOrderRequest"];
type Defaulted = "account" | "post_only" | "reduce_only" | "close_position" | "trigger";

/**
 * `POST /perps/orders`, as the API takes it. The handler defaults `account` to `"0"`, the flags to `false` and
 * `trigger` to `"none"`. execution.yaml marks them required; this type follows the handler.
 *
 * - `instrument` is venue-native: `BTC` (Hyperliquid main dex), the numeric `iid` (Polymarket Perps, e.g. `"1"`), or the
 *   ticker (Kalshi Margin, e.g. `KXBTCPERP`). Use `execution_instrument_id` from `markets.instruments()`.
 * - `account`: Hyperliquid `"0"` is the connected wallet. Polymarket `"0"` or a lowercase `0x` wallet. Kalshi a
 *   subaccount `"0"`–`"63"`.
 * - `client_order_id` is the idempotency key. Use 32 lowercase hex, which every venue accepts (`newClientOrderId()`).
 * - `price` and `quantity` are decimal strings. A market order still carries `price`, the worst acceptable price.
 *   Exception: a Polymarket Perps trigger (`trigger` + `trigger_price`, market, gtc) takes no `price`, and with
 *   `close_position: true` it sizes itself from the position, so `quantity` may be omitted.
 * - `expires_at` is RFC 3339, only with `tif: "gtd"`.
 */
export type PerpOrderInput = Omit<OrderRequest, Defaulted> & Partial<Pick<OrderRequest, Defaulted>>;

/**
 * The order rules a venue enforces, from `GET /perps/instruments` (served by the handler, missing from execution.yaml).
 * A rule the venue does not define is null.
 */
export interface PerpInstrumentRules {
  venue: PerpVenue;
  instrument: string;
  symbol: string | null;
  /** What new orders the instrument accepts: `close_only` takes only orders that reduce a position. */
  status: "open" | "close_only" | "closed";
  /** Kalshi Margin price grid. */
  tick_size: string | null;
  /** Hyperliquid and Polymarket Perps price precision. */
  price_decimals: number | null;
  price_sig_figs: number | null;
  size_step: string;
  size_sig_figs: number | null;
  min_quantity: string | null;
  min_notional: string | null;
  /** Limit-order notional cap; `max_market_notional` caps market orders where the venue splits them. */
  max_notional: string | null;
  max_market_notional: string | null;
  max_leverage: number | null;
  /** Modes an order or leverage update may select; empty where the API sets none. */
  margin_modes: PerpMarginMode[];
}

/** `GET /perps/leverage` (served by the handler, missing from execution.yaml). */
export interface PerpLeverage {
  venue: PerpVenue;
  account: string;
  instrument: string;
  leverage: number;
  margin_mode: PerpMarginMode;
  max_leverage: number;
}

export interface PerpAccountQuery extends CallOptions {
  /** Default `"0"`, the primary account. */
  account?: string;
}

export interface PerpPageQuery extends CallOptions {
  /** 1–500, default 100. */
  limit?: number;
  /** `next_cursor` from the previous page. */
  cursor?: string;
}

export interface PerpFundingPaymentsQuery extends PerpPageQuery {
  /** Default `"0"`, the connected wallet. */
  account?: string;
  /** `main` (default) or `builder` (HIP-3 dex accounts; needs an explicit wallet as `account`). */
  scope?: "main" | "builder";
}

/** Thrown by an `all*` iterator when a page says `complete: false`: older rows could not be read just now. */
export class PerpHistoryIncompleteError extends Error {
  /** Resume from here once the history is readable again. Absent when the server sent none. */
  readonly cursor: string | undefined;

  constructor(cursor: string | undefined) {
    super("Older perps history could not be read just now; retry from `cursor`");
    this.name = "PerpHistoryIncompleteError";
    this.cursor = cursor;
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Market data types (Data API discovery, Market Data API books and history)

/** The market-data venue token. Execution's `hyperliquid_perps` is accepted as an alias of `hyperliquid`. */
export type PerpMarketVenue = MarketDataComponents["parameters"]["PerpetualHistoryVenue"];
/** A venue's market-data capabilities. */
export type PerpVenueInfo = Data["PerpetualVenueCapabilities"];
/**
 * A tradeable instrument. `instrument_id` (`hl-mainnet-btc-usdt`) or `venue_instrument_id` names it in market data;
 * `execution_venue` and `execution_instrument_id` name it in orders. Decimals are exact strings or null.
 */
export type PerpInstrument = Data["PerpetualInstrument"];
/** A venue-live book with market state (mark, oracle, funding). Book prices are per native unit. */
export type PerpSnapshot = Md["PerpetualSnapshot"];
export type PerpMarketState = Md["PerpetualMarketState"];
/** `{coefficient, scale}`: the value is `coefficient × 10^-scale`. Format it with `exactDecimal()`. */
export type PerpExactDecimal = Md["PerpetualV2ExactDecimal"];
export type PerpTrade = Md["PerpetualV2PublicTrade"];
export type PerpCandle = Md["PerpetualV2Candle"];
export type PerpFundingRate = Md["PerpetualV2FundingRateUpdate"];
export type PerpStateUpdate = Md["PerpetualV2MarketStateUpdate"];
export type PerpLiquidation = Md["PerpetualV2PublicLiquidation"];

/** One page of stored history, ascending by event time in `[from, to)`. No `nextCursor` means the range is done. */
export interface PerpHistoryPage<T> {
  data: T[];
  nextCursor?: string;
}

/** A time window for stored history. Each endpoint caps the span (trades and state: 7 days). */
export interface PerpHistoryRange extends CallOptions {
  /** Inclusive start: a Date, unix milliseconds, or RFC 3339. Default `to` minus the endpoint's maximum span. */
  from?: Date | number | string;
  /** Exclusive end: a Date, unix milliseconds, or RFC 3339. Default now. */
  to?: Date | number | string;
  /** Rows per page, 1–5000, default 1000. Each started 1000 rows costs one heavy rate-limit unit. */
  limit?: number;
  /**
   * `nextCursor` from the previous page. Send the same `from` and `to` with it. When paging by hand, set `to` on the
   * first request too: the server's default `to` (and so the default `from`) moves between calls. The `all*` iterators
   * pin it for you.
   */
  cursor?: string;
}

export interface PerpCandleRange extends PerpHistoryRange {
  /** Default `1m`. */
  interval?: "1m" | "5m" | "15m" | "1h" | "4h" | "1d";
  /** `trade` (default) or `mark` price candles. */
  kind?: "trade" | "mark";
}

/** The current funding rate: from the venue-live snapshot, or the newest stored market state when the snapshot has none. */
export interface PerpCurrentFunding {
  venue: PerpSnapshot["venue"];
  instrument_id: string;
  venue_instrument_id: string;
  /** Rate per funding interval as an exact decimal string; positive means longs pay. Null when no source states one. */
  funding_rate: string | null;
  /** Next funding time, unix nanoseconds, as a decimal string. Null when no source states one. */
  next_funding_time_ns: string | null;
  /**
   * When the rate was observed, unix nanoseconds, as a decimal string. From `snapshot`, both times arrive as JSON
   * numbers above 2^53, so their last digits are rounded; `stored_state` times are exact.
   */
  event_time_ns: string;
  /** Mark price from the snapshot (`price_type: "mark"`). Kalshi Margin states `settlement_mark` instead, so this is null there. */
  mark: string | null;
  /**
   * `snapshot`: the venue's public API, read now. `stored_state`: the newest row of `/state` within the last two minutes.
   * Kalshi Margin's snapshot carries no funding rate, so it answers from `stored_state`. When neither has a rate,
   * `funding_rate` is null and `source` is `snapshot`.
   */
  source: "snapshot" | "stored_state";
}

// ---------------------------------------------------------------------------------------------------------------------
// Helpers

/** A 32-character lowercase hex client order id: the format every perps venue accepts. */
export function newClientOrderId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Formats a market-data `{coefficient, scale}` decimal exactly, e.g. `{coefficient: "-214094", scale: 10}` → `"-0.0000214094"`. */
export function exactDecimal(value: PerpExactDecimal): string {
  const scale = value.scale ?? 0;
  const negative = value.coefficient.startsWith("-");
  const digits = negative ? value.coefficient.slice(1) : value.coefficient;
  if (!/^\d+$/.test(digits) || !Number.isInteger(scale)) throw new TypeError(`not an exact decimal: ${JSON.stringify(value)}`);
  let out: string;
  if (scale <= 0) {
    out = digits === "0" ? "0" : digits + "0".repeat(-scale);
  } else {
    const padded = digits.padStart(scale + 1, "0");
    const whole = padded.slice(0, -scale);
    const fraction = padded.slice(-scale).replace(/0+$/, "");
    out = fraction ? `${whole}.${fraction}` : whole;
  }
  return negative && /[1-9]/.test(out) ? `-${out}` : out;
}

function time(value: Date | number | string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function required(value: string, name: string): string {
  if (!value) throw new TypeError(`${name} is required`);
  return value;
}

function noRedirects(fetchImpl: FetchLike): FetchLike {
  return (url, init) => fetchImpl(url, { ...init, redirect: "error" });
}

// ---------------------------------------------------------------------------------------------------------------------
// Market data client

/** Public perps market data. Works without a key. */
export class PerpsMarketsClient {
  private readonly data: RestClient<PerpsDataPaths>;
  private readonly md: RestClient<PerpsMarketDataPaths>;

  constructor(options: Pick<PerpsOptions, "environment" | "marketDataUrl" | "dataUrl" | "auth" | "fetch"> = {}) {
    const hosts = PERPS_HOSTS[options.environment ?? "staging"];
    this.data = new RestClient({ baseUrl: options.dataUrl ?? hosts.dataUrl, auth: options.auth, fetch: options.fetch });
    this.md = new RestClient({ baseUrl: options.marketDataUrl ?? hosts.marketDataUrl, auth: options.auth, fetch: options.fetch });
  }

  /** `GET /perpetuals/venues` (Data API): each venue and which market data it serves. */
  venues(opts: CallOptions = {}): Promise<PerpVenueInfo[]> {
    return this.data.request("GET", "/perpetuals/venues", { signal: opts.signal });
  }

  /** `GET /perpetuals/instruments` (Data API): instruments and their static rules, optionally for one venue. Not paged. */
  instruments(opts: { venue?: PerpMarketVenue } & CallOptions = {}): Promise<PerpInstrument[]> {
    return this.data.request("GET", "/perpetuals/instruments", { query: { venue: opts.venue }, signal: opts.signal });
  }

  /**
   * `GET /v1/perpetuals/{venue}/{instrument}/snapshot`: the venue-live book (`depth` levels per side) with mark, oracle,
   * funding rate and open interest. `instrument` must be venue-native (`BTC`, `1`, `KXBTCPERP`: an instrument's
   * `venue_instrument_id`); a Kairos `instrument_id` is `400 invalid_request` here. Costs 6 heavy units.
   */
  snapshot(venue: PerpMarketVenue, instrument: string, opts: { depth?: number } & CallOptions = {}): Promise<PerpSnapshot> {
    return this.md.request("GET", "/v1/perpetuals/{venue}/{instrument}/snapshot", {
      path: { venue, instrument: required(instrument, "instrument") }, query: { depth: opts.depth }, signal: opts.signal,
    });
  }

  /**
   * The current funding rate and next funding time. Reads a depth-1 snapshot (6 heavy units). When the snapshot states
   * no rate (Kalshi Margin), it reads the last two minutes of stored `/state` (one more heavy unit) and uses the newest row.
   * `instrument` is venue-native, as for `snapshot`.
   */
  async currentFunding(venue: PerpMarketVenue, instrument: string, opts: CallOptions = {}): Promise<PerpCurrentFunding> {
    const s = await this.snapshot(venue, instrument, { depth: 1, signal: opts.signal });
    const mark = s.market_state.prices.find((p) => p.price_type === "mark")?.value ?? null;
    const base = { venue: s.venue, instrument_id: s.canonical_instrument_id, venue_instrument_id: s.venue_instrument_id, mark };
    const ns = (value: number | null) => (value === null ? null : BigInt(value).toString());
    if (s.market_state.funding_rate !== null) {
      return {
        ...base,
        funding_rate: s.market_state.funding_rate,
        next_funding_time_ns: ns(s.market_state.next_funding_time_ns),
        event_time_ns: ns(s.market_state.event_time_ns)!,
        source: "snapshot",
      };
    }
    const to = Date.now();
    let latest: PerpStateUpdate | undefined;
    for await (const row of this.allState(venue, s.canonical_instrument_id, { from: to - 120_000, to, limit: 1000, signal: opts.signal })) {
      if (row.fundingRate) latest = row;
    }
    if (!latest?.fundingRate) {
      return { ...base, funding_rate: null, next_funding_time_ns: null, event_time_ns: ns(s.market_state.event_time_ns)!, source: "snapshot" };
    }
    return {
      ...base,
      funding_rate: exactDecimal(latest.fundingRate),
      next_funding_time_ns: latest.nextFundingTimeNs ?? null,
      event_time_ns: latest.eventTimeNs,
      source: "stored_state",
    };
  }

  /** `GET /v1/perpetuals/{venue}/{instrument}/funding`: one page of stored funding rates. `instrument` may be the Kairos id. */
  funding(venue: PerpMarketVenue, instrument: string, range: PerpHistoryRange = {}): Promise<PerpHistoryPage<PerpFundingRate>> {
    return this.md.request("GET", "/v1/perpetuals/{venue}/{instrument}/funding", this.history(venue, instrument, range));
  }

  /** `GET /v1/perpetuals/{venue}/{instrument}/trades`: one page of stored public trades. At most 7 days per range. */
  trades(venue: PerpMarketVenue, instrument: string, range: PerpHistoryRange = {}): Promise<PerpHistoryPage<PerpTrade>> {
    return this.md.request("GET", "/v1/perpetuals/{venue}/{instrument}/trades", this.history(venue, instrument, range));
  }

  /** `GET /v1/perpetuals/{venue}/{instrument}/candles`: one page of stored candles. */
  candles(venue: PerpMarketVenue, instrument: string, range: PerpCandleRange = {}): Promise<PerpHistoryPage<PerpCandle>> {
    const input = this.history(venue, instrument, range);
    return this.md.request("GET", "/v1/perpetuals/{venue}/{instrument}/candles", {
      ...input, query: { ...input.query, interval: range.interval, kind: range.kind },
    });
  }

  /** `GET /v1/perpetuals/{venue}/{instrument}/state`: one page of stored market state (mark, oracle, funding, OI). At most 7 days. */
  state(venue: PerpMarketVenue, instrument: string, range: PerpHistoryRange = {}): Promise<PerpHistoryPage<PerpStateUpdate>> {
    return this.md.request("GET", "/v1/perpetuals/{venue}/{instrument}/state", this.history(venue, instrument, range));
  }

  /** `GET /v1/perpetuals/{venue}/{instrument}/liquidations`: one page of stored public liquidations (only Hyperliquid flags them). */
  liquidations(venue: PerpMarketVenue, instrument: string, range: PerpHistoryRange = {}): Promise<PerpHistoryPage<PerpLiquidation>> {
    return this.md.request("GET", "/v1/perpetuals/{venue}/{instrument}/liquidations", this.history(venue, instrument, range));
  }

  /** Every stored funding rate in the range, following `nextCursor`. */
  allFunding(venue: PerpMarketVenue, instrument: string, range: Omit<PerpHistoryRange, "cursor"> = {}): AsyncGenerator<PerpFundingRate> {
    return follow((r) => this.funding(venue, instrument, r), range);
  }

  /** Every stored trade in the range, following `nextCursor`. */
  allTrades(venue: PerpMarketVenue, instrument: string, range: Omit<PerpHistoryRange, "cursor"> = {}): AsyncGenerator<PerpTrade> {
    return follow((r) => this.trades(venue, instrument, r), range);
  }

  /** Every stored candle in the range, following `nextCursor`. */
  allCandles(venue: PerpMarketVenue, instrument: string, range: Omit<PerpCandleRange, "cursor"> = {}): AsyncGenerator<PerpCandle> {
    return follow((r) => this.candles(venue, instrument, r), range);
  }

  /** Every stored market-state row in the range, following `nextCursor`. */
  allState(venue: PerpMarketVenue, instrument: string, range: Omit<PerpHistoryRange, "cursor"> = {}): AsyncGenerator<PerpStateUpdate> {
    return follow((r) => this.state(venue, instrument, r), range);
  }

  /** Every stored liquidation in the range, following `nextCursor`. */
  allLiquidations(venue: PerpMarketVenue, instrument: string, range: Omit<PerpHistoryRange, "cursor"> = {}): AsyncGenerator<PerpLiquidation> {
    return follow((r) => this.liquidations(venue, instrument, r), range);
  }

  private history(venue: PerpMarketVenue, instrument: string, range: PerpHistoryRange) {
    return {
      path: { venue, instrument: required(instrument, "instrument") },
      query: { from: time(range.from), to: time(range.to), limit: range.limit, cursor: range.cursor },
      signal: range.signal,
    };
  }
}

/** Follows `nextCursor`. Pins `to` on the first page, because the server's default end moves and a cursor needs the same range. */
async function* follow<T, R extends PerpHistoryRange>(page: (range: R) => Promise<PerpHistoryPage<T>>, range: R): AsyncGenerator<T> {
  const pinned = { ...range, to: range.to ?? Date.now() } as R;
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await page({ ...pinned, cursor });
    yield* result.data;
    cursor = result.nextCursor || undefined;
    if (cursor && seen.has(cursor)) throw new Error("perps history returned the same cursor twice");
    if (cursor) seen.add(cursor);
  } while (cursor);
}

// ---------------------------------------------------------------------------------------------------------------------
// Execution client

/**
 * Perps for one Kairos account: margin, positions, orders, fills and funding payments, plus order placement and
 * cancellation. `markets` holds the public market data.
 *
 * Errors are `KairosError`: `status`, `code` (top-level, e.g. `PERP_PRICE_OFF_GRID`, `RATE_LIMITED`,
 * `AUTH_INSUFFICIENT_SCOPE`, `PERP_UNAVAILABLE`, `MARKET_PAUSED`) and `body` (`PerpErrorBody`, whose
 * `error_details.code` is the stable class). `outcomeUnknown` is true when an order or cancel may have taken effect;
 * look the order up with `order()` before you retry.
 */
export class PerpsClient {
  readonly markets: PerpsMarketsClient;
  private readonly http: Http;
  private readonly authenticated: boolean;

  constructor(options: PerpsOptions = {}) {
    const hosts = PERPS_HOSTS[options.environment ?? "staging"];
    const fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.markets = new PerpsMarketsClient(options);
    this.authenticated = Boolean(options.auth);
    this.http = new Http({
      baseUrl: options.executionUrl ?? hosts.executionUrl,
      headers: restAuthHeaders(options.auth),
      fetch: options.auth ? noRedirects(fetchImpl) : fetchImpl,
    });
  }

  /** `GET /perps/account`: equity, available, withdrawable, initial and maintenance margin, and risk. Null if none is stored yet. */
  account(venue: PerpVenue, opts: PerpAccountQuery = {}): Promise<PerpAccount | null> {
    return this.get("/perps/account", { venue, account: opts.account }, opts.signal);
  }

  /** `GET /perps/positions`: open positions on every venue, or one venue and account. */
  positions(opts: { venue?: PerpVenue; account?: string } & CallOptions = {}): Promise<PerpPosition[]> {
    return this.get("/perps/positions", { venue: opts.venue, account: opts.account }, opts.signal);
  }

  /** `GET /perps/orders`: working orders on a venue. */
  orders(venue: PerpVenue, opts: CallOptions = {}): Promise<PerpOrder[]> {
    return this.get("/perps/orders", { venue }, opts.signal);
  }

  /** `GET /perps/orders/{client_order_id}`: one order by your id, or null when Kairos has none. */
  order(venue: PerpVenue, clientOrderId: string, opts: CallOptions = {}): Promise<PerpOrder | null> {
    return this.get(`/perps/orders/${encodeURIComponent(required(clientOrderId, "clientOrderId"))}`, { venue }, opts.signal);
  }

  /** `GET /perps/fills`: the newest fills on a venue, one page (limit 1–500, default 100). Use `fillHistory` to page further. */
  fills(venue: PerpVenue, opts: { limit?: number } & CallOptions = {}): Promise<PerpFill[]> {
    return this.get("/perps/fills", { venue, limit: opts.limit }, opts.signal);
  }

  /** `GET /perps/history/fills`: one page of fills, newest first. */
  fillHistory(venue: PerpVenue, opts: PerpPageQuery = {}): Promise<PerpFillPage> {
    return this.get("/perps/history/fills", { venue, limit: opts.limit, cursor: opts.cursor }, opts.signal);
  }

  /** `GET /perps/history/orders`: one page of orders in any state, newest first. */
  orderHistory(venue: PerpVenue, opts: PerpPageQuery = {}): Promise<PerpOrderPage> {
    return this.get("/perps/history/orders", { venue, limit: opts.limit, cursor: opts.cursor }, opts.signal);
  }

  /** `GET /perps/history/funding`: one page of funding payments, newest first. Hyperliquid only; the other venues have none. */
  fundingPayments(opts: PerpFundingPaymentsQuery = {}): Promise<PerpFundingPaymentsPage> {
    return this.get("/perps/history/funding", { account: opts.account, scope: opts.scope, limit: opts.limit, cursor: opts.cursor }, opts.signal);
  }

  /** Every fill, newest first, following `next_cursor`. Throws `PerpHistoryIncompleteError` if a page is incomplete. */
  allFills(venue: PerpVenue, opts: Omit<PerpPageQuery, "cursor"> = {}): AsyncGenerator<PerpFill> {
    return followExecution((cursor) => this.fillHistory(venue, { ...opts, cursor }));
  }

  /** Every order, newest first, following `next_cursor`. Throws `PerpHistoryIncompleteError` if a page is incomplete. */
  allOrders(venue: PerpVenue, opts: Omit<PerpPageQuery, "cursor"> = {}): AsyncGenerator<PerpOrder> {
    return followExecution((cursor) => this.orderHistory(venue, { ...opts, cursor }));
  }

  /** Every Hyperliquid funding payment, newest first, following `next_cursor`. */
  allFundingPayments(opts: Omit<PerpFundingPaymentsQuery, "cursor"> = {}): AsyncGenerator<PerpFundingPayment> {
    return followExecution((cursor) => this.fundingPayments({ ...opts, cursor }).then((page) => ({ ...page, complete: true })));
  }

  /**
   * `GET /perps/instruments`: the price and size rules orders are validated against. Kalshi Margin needs `instrument`.
   * Ticks change live: read them again after a `PERP_PRICE_OFF_GRID`.
   */
  instrumentRules(venue: PerpVenue, opts: { instrument?: string } & CallOptions = {}): Promise<PerpInstrumentRules[]> {
    return this.get("/perps/instruments", { venue, instrument: opts.instrument }, opts.signal);
  }

  /** `GET /perps/leverage`: the account's leverage and margin mode on an instrument. Hyperliquid and Polymarket Perps. */
  leverage(venue: PerpVenue, instrument: string, opts: PerpAccountQuery = {}): Promise<PerpLeverage> {
    return this.get("/perps/leverage", { venue, account: opts.account, instrument }, opts.signal);
  }

  /** `GET /perps/kalshi/accounts`: the Kalshi Margin subaccount numbers you can trade. */
  kalshiAccounts(opts: CallOptions = {}): Promise<string[]> {
    return this.get("/perps/kalshi/accounts", {}, opts.signal);
  }

  /**
   * `POST /perps/orders`: places an order on a live venue. Needs `trade:execute`. Resending the same body with the same
   * `client_order_id` is safe; a different body with a used id is `409 CLIENT_ORDER_ID_CONFLICT`. A rejected order is
   * `400 VALIDATION_INVALID_ORDER` with a `PERP_*` `code`.
   */
  placeOrder(order: PerpOrderInput, opts: CallOptions = {}): Promise<PerpOrder> {
    return this.send("POST", "/perps/orders", { body: order, signal: opts.signal });
  }

  /** `DELETE /perps/orders/{client_order_id}`: cancels one order and returns its current row. Needs `trade:execute`. */
  cancelOrder(venue: PerpVenue, clientOrderId: string, opts: PerpAccountQuery = {}): Promise<PerpOrder> {
    return this.send("DELETE", `/perps/orders/${encodeURIComponent(required(clientOrderId, "clientOrderId"))}`, { query: { venue, account: opts.account }, signal: opts.signal });
  }

  /**
   * `POST /perps/orders/cancel-all`: asks the venue to cancel every working order on the account. `{requested: true}`
   * means accepted, not done: final states arrive later. On Polymarket Perps, `"0"` sweeps every enabled wallet.
   */
  cancelAll(venue: PerpVenue, opts: PerpAccountQuery = {}): Promise<{ requested: true }> {
    return this.send("POST", "/perps/orders/cancel-all", { body: { venue, account: opts.account ?? "0" }, signal: opts.signal });
  }

  /** `POST /perps/reconcile`: refreshes Kairos' stored orders and positions from the venue. Needs `trade:execute`. */
  reconcile(venue: PerpVenue, opts: PerpAccountQuery = {}): Promise<{ reconciled: true }> {
    return this.send("POST", "/perps/reconcile", { body: { venue, account: opts.account ?? "0" }, signal: opts.signal });
  }

  private get<T>(path: string, query: Query, signal?: AbortSignal): Promise<T> {
    return this.send("GET", path, { query, signal });
  }

  private send<T>(method: "GET" | "POST" | "DELETE", path: string, opts: { query?: Query; body?: unknown; signal?: AbortSignal }): Promise<T> {
    if (!this.authenticated) {
      return Promise.reject(new TypeError("perps execution calls need `auth`: pass { apiKey: { clientId, apiKey, apiSecret } }"));
    }
    return this.http.request<T>(method, path, opts);
  }
}

async function* followExecution<T>(page: (cursor: string | undefined) => Promise<{ items: T[]; next_cursor?: string | null; complete: boolean }>): AsyncGenerator<T> {
  const seen = new Set<string>();
  let cursor: string | undefined;
  do {
    const result = await page(cursor);
    yield* result.items;
    const next = result.next_cursor || undefined;
    if (!result.complete) throw new PerpHistoryIncompleteError(next ?? cursor);
    if (next && seen.has(next)) throw new Error("perps history returned the same cursor twice");
    if (next) seen.add(next);
    cursor = next;
  } while (cursor);
}

/** True when `error` is a perps error with this top-level or stable code. */
export function isPerpError(error: unknown, code: string): boolean {
  if (!(error instanceof KairosError)) return false;
  const details = (error.body as Partial<PerpErrorBody> | undefined)?.error_details;
  return error.code === code || details?.code === code;
}
