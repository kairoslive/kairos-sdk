// Trader analytics on the Data API: public, no key. Positions here, open and closed, carry
// realized P&L, which the wallet API's `positions` read does not keep once a position closes.

import { Http, type FetchLike } from "./http.ts";
import type { Provider } from "./markets.ts";

export const DATA_URL = "https://data.kairos.trade";

/** One position, open or closed. Decimal strings keep values exact; prices are 0–1. */
export interface TraderPosition {
  market_id: string;
  market_name: string | null;
  icon: string | null;
  token_id: string;
  /** e.g. `"Yes"`. */
  outcome: string;
  /** Shares held now; `"0"` once closed. */
  size: string;
  /** Average entry price. */
  entry_price: string;
  /** Mark price, `null` once closed. */
  current_price: string | null;
  /** USD paid for the shares still held. */
  cost_basis: string;
  unrealized_pnl: string | null;
  /** P&L booked by selling or settling so far. */
  realized_pnl: string;
  status: "OPEN" | "CLOSED";
  opened_at: string | null;
  closed_at: string | null;
  provider: Provider;
  [key: string]: unknown;
}

/** Totals over the trader's whole history, not just the returned page. */
export interface TraderPerformance {
  wallet_address: string;
  total_realized_pnl: string;
  total_unrealized_pnl: string;
  total_pnl: string;
  roi_percent: string;
  open_positions: number;
  closed_positions: number;
  total_positions: number;
  /** Cost basis of open positions. */
  positions_value: string;
  winning_positions: number;
  losing_positions: number;
  /** 0–1, over closed, resolved positions. */
  win_rate: number | string;
  total_volume: string;
  markets_traded: number;
  join_date: string | null;
  largest_win: string | null;
  last_updated: string;
  [key: string]: unknown;
}

export interface TraderPositions {
  wallet_address: string;
  performance: TraderPerformance;
  open_positions: TraderPosition[];
  closed_positions: TraderPosition[];
  has_more: boolean;
}

export interface TraderPositionsQuery {
  /** `"all"` (default), `"open"` or `"closed"`. */
  status?: "all" | "open" | "closed";
  /** Include resolved positions still waiting to be redeemed. */
  includeRedeemable?: boolean;
  /** Detected from the address when omitted. */
  provider?: Provider;
  /** 1–1000, default 200. Sorted by current value. */
  limit?: number;
  offset?: number;
}

export interface TraderClientOptions {
  /** Default `https://data.kairos.trade`. */
  baseUrl?: string;
  fetch?: FetchLike;
}

export class TraderClient {
  private readonly http: Http;

  constructor(opts: TraderClientOptions = {}) {
    this.http = new Http({ baseUrl: opts.baseUrl ?? DATA_URL, fetch: opts.fetch });
  }

  /**
   * A trader's positions with realized and unrealized P&L, plus lifetime stats. For a Kairos
   * wallet, pass its trading wallet (`status(wallet).tradingWallet`): that's the address that trades.
   * Public and rate limited (30 a minute per IP).
   */
  positions(address: string, q: TraderPositionsQuery = {}): Promise<TraderPositions> {
    return this.http.get<TraderPositions>(`/trader-stats/positions/${encodeURIComponent(address)}`, {
      status: q.status,
      include_redeemable: q.includeRedeemable,
      provider: q.provider,
      limit: q.limit,
      offset: q.offset,
    });
  }

  /** Every closed position, page by page. */
  async *closedPositions(address: string, opts: { pageSize?: number; provider?: Provider } = {}): AsyncGenerator<TraderPosition> {
    const limit = opts.pageSize ?? 200;
    for (let offset = 0; ; offset += limit) {
      const page = await this.positions(address, { status: "closed", limit, offset, provider: opts.provider });
      yield* page.closed_positions;
      if (!page.has_more || !page.closed_positions.length) return;
    }
  }
}
