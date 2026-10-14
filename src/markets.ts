// Market Data API: public, no key. Prices here are on a 0–100 scale; orders use 0–1.

import { Http, type FetchLike } from "./http.ts";

export type Provider = "polymarket" | "kalshi" | "predictfun" | "hyperliquid" | (string & {});
export type Timeframe = 1 | 60 | 300 | 900 | 3600 | 14400 | 86400;

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

export interface CandlesQuery {
  provider: Provider;
  /** Market/contract id. Polymarket also accepts the `0x…` condition id. */
  contractId: string;
  timeframeSeconds: Timeframe;
  start: string | Date;
  end: string | Date;
  /** Outcome index, 0 = first outcome (e.g. YES). */
  outcome?: number;
}

export interface TradesQuery {
  provider: Provider;
  contractId: string;
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
  fetch?: FetchLike;
}

export const MARKET_DATA_URL = "https://md.kairos.trade";

export class MarketDataClient {
  private readonly http: Http;

  constructor(opts: MarketDataOptions = {}) {
    this.http = new Http({ baseUrl: opts.baseUrl ?? MARKET_DATA_URL, fetch: opts.fetch });
  }

  /** One page of a provider's catalog. Pass `next_cursor` back as `cursor`. */
  list(provider: Provider, opts: { limit?: number; cursor?: string } = {}): Promise<MarketPage> {
    return this.http.get<MarketPage>("/v1/markets", { provider, limit: opts.limit, cursor: opts.cursor });
  }

  /** Every market of a provider, page by page. */
  async *all(provider: Provider, opts: { pageSize?: number } = {}): AsyncGenerator<Market> {
    let cursor: string | undefined;
    do {
      const page = await this.list(provider, { limit: opts.pageSize ?? 250, cursor });
      yield* page.markets;
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
  }

  get(provider: Provider, marketId: string): Promise<Market> {
    return this.http.get<Market>(`/v1/markets/${provider}/${encodeURIComponent(marketId)}`);
  }

  /** Up to 200 markets from one provider. */
  batch(provider: Provider, marketIds: string[]): Promise<unknown> {
    return this.http.post("/v1/markets/batch", { provider, market_ids: marketIds });
  }

  candles(q: CandlesQuery): Promise<unknown> {
    return this.http.get("/v1/candles", {
      provider: q.provider,
      contract_id: q.contractId,
      timeframe_seconds: q.timeframeSeconds,
      start: iso(q.start),
      end: iso(q.end),
      outcome: q.outcome,
    });
  }

  trades(q: TradesQuery): Promise<unknown> {
    return this.http.get("/v1/trades", {
      provider: q.provider,
      contract_id: q.contractId,
      window_seconds: q.windowSeconds,
      before: q.before,
      limit: q.limit,
    });
  }

  /** Resolution status for up to 200 markets. */
  resolutions(provider: Provider, marketIds: string[]): Promise<unknown> {
    return this.http.get("/v1/resolutions", { provider, market_ids: marketIds.join(",") });
  }
}

const iso = (t: string | Date) => (t instanceof Date ? t.toISOString() : t);
