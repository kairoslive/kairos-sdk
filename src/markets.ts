// Market Data API: public, no key. Prices here are on a 0–100 scale; orders use 0–1.

import type { CallOptions } from "./common.ts";
import type { components } from "./openapi/market-data.ts";
import { Http, type FetchLike } from "./http.ts";
import { EventsClient } from "./events.ts";
import { RestClient, restAuthHeaders, type MarketDataPaths, type RestAuth } from "./rest.ts";

export type Provider = "polymarket" | "kalshi" | "predictfun" | "hyperliquid" | (string & {});
export type Timeframe = 1 | 60 | 300 | 900 | 3600 | 14400 | 86400;
type Schema = components["schemas"];
export type TickGridProvider = Schema["TickGridBatchRequest"]["provider"];
export type PerpetualVenue = Schema["PerpetualSnapshot"]["venue"];
export type MarketBatchPage = Omit<Schema["MarketBatchResponse"], "markets"> & { markets: Record<string, Market> };

export interface MarketIdentifier {
  provider: Provider;
  identifier: string;
  /** Resolve a market identifier or an outcome token to its market. */
  scope: "market" | "outcome";
}

export interface MarketContract {
  provider: Provider;
  contractId: string;
}

export interface TickGridQuery {
  contractId: string;
  /** Token-specific tick overrides are available on Polymarket. */
  assetId?: string;
}

export interface MarkPair {
  contractId: string;
  tokenId: string;
}

export interface TradeTapeQuery extends MarketContract, CallOptions {
  cursor?: string;
  limit?: number;
}

export interface TradeMetricsQuery extends MarketContract, CallOptions {
  windowSeconds?: number;
}

export interface MarketOutcome {
  outcome: string;
  normalized_outcome: string;
  token_id: string;
}

export interface Market {
  market_id: string;
  exchange_id: string;
  title: string;
  status: string;
  /** Polymarket: pass this as `market` when placing an order. */
  condition_id: string | null;
  outcomes: MarketOutcome[];
  tick_size: number | string | null;
  neg_risk: boolean | null;
  end_date: string | null;
  open_time: string | null;
  event_id: string | null;
  category: string | null;
  icon: string | null;
  image: string | null;
  [key: string]: unknown;
}

export interface MarketPage {
  markets: Market[];
  count: number;
  has_more: boolean;
  next_cursor: string | null;
  exchange_id: string;
}

/** Polymarket accepts a market id or 0x condition id as contractId. */
export interface CandlesQuery extends MarketContract, CallOptions {
  timeframeSeconds: Timeframe;
  start: string | Date;
  end: string | Date;
  /** Outcome index, 0 = first outcome (e.g. YES). */
  outcome?: number;
}

export interface TradesQuery extends MarketContract, CallOptions {
  /** Lookback window, 3600–86400 seconds. */
  windowSeconds?: number;
  /** Exclusive upper bound, unix seconds, for paging back. */
  before?: number;
  /** 1–500. */
  limit?: number;
}

export interface MarketDataOptions {
  /** Default `https://md.kairos.trade`. */
  baseUrl?: string;
  auth?: RestAuth;
  fetch?: FetchLike;
}

export const MARKET_DATA_URL = "https://md.kairos.trade";

export class MarketDataClient extends RestClient<MarketDataPaths> {
  readonly events: EventsClient;
  private readonly marketHttp: Http;

  constructor(opts: MarketDataOptions = {}) {
    const baseUrl = opts.baseUrl ?? MARKET_DATA_URL;
    super({ ...opts, baseUrl });
    const fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.marketHttp = new Http({
      baseUrl,
      headers: restAuthHeaders(opts.auth),
      fetch: opts.auth ? (url, init) => fetchImpl(url, { ...init, redirect: "error" }) : fetchImpl,
    });
    this.events = new EventsClient(this.marketHttp);
  }

  /** One page of a provider's catalog. Pass `next_cursor` back as `cursor`. */
  list(provider: Provider, opts: { limit?: number; cursor?: string } & CallOptions = {}): Promise<MarketPage> {
    return this.marketHttp.get<MarketPage>("/v1/markets", { provider, limit: opts.limit, cursor: opts.cursor }, undefined, opts.signal);
  }

  /** Every market of a provider, page by page. */
  async *all(provider: Provider, opts: { pageSize?: number } & CallOptions = {}): AsyncGenerator<Market> {
    let cursor: string | undefined;
    do {
      const page = await this.list(provider, { limit: opts.pageSize ?? 250, cursor, signal: opts.signal });
      yield* page.markets;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  get(provider: Provider, marketId: string, opts: CallOptions = {}): Promise<Market> {
    return this.marketHttp.get<Market>(marketPath(provider, marketId), undefined, undefined, opts.signal);
  }

  /** Up to 200 markets from one provider. */
  batch(provider: Provider, marketIds: readonly string[], opts: CallOptions = {}): Promise<MarketBatchPage> {
    return this.marketHttp.post("/v1/markets/batch", { provider, market_ids: marketIds }, undefined, opts.signal);
  }

  /** Resolve up to 200 venue market or outcome identifiers to canonical market ids. */
  resolveIdentifiers(requests: readonly MarketIdentifier[], opts: CallOptions = {}): Promise<Schema["MarketIdentifierResolveResponse"]> {
    return this.marketHttp.post("/v1/market-identifiers/resolve", { requests }, undefined, opts.signal);
  }

  /** Read the price grid used to validate an order. Predict.fun returns a documented unsupported result. */
  tickSize(provider: TickGridProvider, market: TickGridQuery, opts: CallOptions = {}) {
    return this.request("GET", "/v1/markets/tick-size", { query: { provider, ...tickGridParams(market) }, signal: opts.signal });
  }

  /** Read several grids in one request. Each item may independently return an error. */
  tickSizes(provider: TickGridProvider, items: readonly TickGridQuery[], opts: CallOptions = {}) {
    return this.request("POST", "/v1/markets/tick-size/batch", {
      body: { provider, items: items.map(tickGridParams) },
      signal: opts.signal,
    });
  }

  /** Last traded prices on a 0–100 scale. Never-traded pairs may be absent. */
  marks(provider: Provider, pairs: readonly MarkPair[], opts: CallOptions = {}): Promise<Schema["MarksResponse"]> {
    const keys = pairs.map(({ contractId, tokenId }) => `${contractId}:${tokenId}`).join(",");
    return this.marketHttp.get("/v1/marks", { provider, pairs: keys }, undefined, opts.signal);
  }

  candles(q: CandlesQuery): Promise<Schema["CandleListResponse"]> {
    return this.marketHttp.get("/v1/candles", candleParams(q), undefined, q.signal);
  }

  /** Up to 200 series. Inspect each result's error field even when the request succeeds. */
  candlesBatch(requests: readonly Omit<CandlesQuery, "signal">[], opts: CallOptions = {}): Promise<Schema["CandleBatchResponse"]> {
    return this.marketHttp.post("/v1/candles/batch", { requests: requests.map(candleParams) }, undefined, opts.signal);
  }

  /** Retrieve Kairos's little-endian candle frame for high-volume charting. */
  async candlesBinary(q: CandlesQuery): Promise<ArrayBuffer> {
    const response = await this.marketHttp.requestResponse("GET", "/v1/candles", {
      query: candleParams(q),
      headers: { accept: "application/x-kairos-candles" },
      signal: q.signal,
    });
    return response.arrayBuffer();
  }

  trades(q: TradesQuery): Promise<Schema["TradeHistoryResponse"]> {
    return this.marketHttp.get("/v1/trades", {
      provider: q.provider,
      contract_id: q.contractId,
      window_seconds: q.windowSeconds,
      before: q.before,
      limit: q.limit,
    }, undefined, q.signal);
  }

  /** Cursor-paginated trade tape. Pass next_cursor back as cursor. */
  tradeTape(q: TradeTapeQuery): Promise<Schema["TradeTapeResponse"]> {
    return this.marketHttp.get("/v1/trades/tape", {
      provider: q.provider, contract_id: q.contractId, cursor: q.cursor, limit: q.limit,
    }, undefined, q.signal);
  }

  tradeMetrics(q: TradeMetricsQuery): Promise<Schema["TradeMetricsResponse"]> {
    return this.marketHttp.get("/v1/trades/metrics", {
      provider: q.provider, contract_id: q.contractId, window_seconds: q.windowSeconds,
    }, undefined, q.signal);
  }

  /** Settlement payouts for up to 200 markets. Unsettled markets may be absent. */
  resolutions(provider: Provider, marketIds: readonly string[], opts: CallOptions = {}): Promise<Schema["ResolutionsResponse"]> {
    return this.marketHttp.get("/v1/resolutions", { provider, market_ids: marketIds.join(",") }, undefined, opts.signal);
  }

  resolutionStatus(provider: Provider, marketId: string, opts: CallOptions = {}): Promise<Schema["ResolutionStatus"]> {
    return this.marketHttp.get(`${marketPath(provider, marketId)}/resolution`, undefined, undefined, opts.signal);
  }

  resolutionStatuses(provider: Provider, marketIds: readonly string[], opts: CallOptions = {}): Promise<Schema["ResolutionStatusesResponse"]> {
    return this.marketHttp.get("/v1/resolutions/status", { provider, market_ids: marketIds.join(",") }, undefined, opts.signal);
  }

  resolutionEvents(provider: Provider, marketId: string, opts: CallOptions = {}): Promise<Schema["ResolutionEventsResponse"]> {
    return this.marketHttp.get(`${marketPath(provider, marketId)}/resolution/events`, undefined, undefined, opts.signal);
  }

  /** Point-in-time book, trades, funding, and instrument context for a perpetual. */
  perpetualSnapshot(venue: PerpetualVenue, instrument: string, opts: { depth?: number } & CallOptions = {}) {
    return this.request("GET", "/v1/perpetuals/{venue}/{instrument}/snapshot", {
      path: { venue, instrument }, query: { depth: opts.depth }, signal: opts.signal,
    });
  }
}

function marketPath(provider: Provider, marketId: string): string {
  return `/v1/markets/${encodeURIComponent(provider)}/${encodeURIComponent(marketId)}`;
}

function tickGridParams(q: TickGridQuery) {
  return { contract_id: q.contractId, asset_id: q.assetId };
}

function candleParams(q: Omit<CandlesQuery, "signal">) {
  return {
    provider: q.provider, contract_id: q.contractId, timeframe_seconds: q.timeframeSeconds,
    start: iso(q.start), end: iso(q.end), outcome: q.outcome,
  };
}

const iso = (t: string | Date) => (t instanceof Date ? t.toISOString() : t);
