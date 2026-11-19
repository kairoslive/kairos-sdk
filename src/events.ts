import type { CallOptions } from "./common.ts";
import { Http } from "./http.ts";
import type { Provider } from "./markets.ts";

export type MatchedSide = "yes" | "no";
export type EventStatus = "upcoming" | "live" | "open" | "resolving" | "ended" | "closed" | "resolved";

export interface MatchedVenue {
  exchange_id: Provider;
  market_id: string;
  market_id_no?: string | null;
  token_id_yes: string;
  token_id_no: string;
  outcome_yes_label: string;
  outcome_no_label: string;
  tick_size: number | null;
  open: boolean;
  executable: boolean;
}

export interface MatchedMarket {
  id: string;
  event_id: string;
  title: string;
  status: EventStatus;
  category: string | null;
  start_time: string | null;
  close_time: string | null;
  listed_at: string | null;
  outcomes: Record<MatchedSide, string>;
  venues: MatchedVenue[];
  /** Router availability across venues, independent of a caller's setup and funding. */
  executable_venues: Provider[];
  route: { provider: Provider; market_id: string; market: string };
  books: Record<MatchedSide, string>;
}

export interface MatchedEventRef {
  id: string;
  title: string;
  category: string | null;
}

export interface MatchedEvent extends MatchedEventRef {
  image: string | null;
  venues: Provider[];
  venue_events: { exchange_id: Provider; event_id: string }[];
  status: EventStatus;
  market_count: number;
  start_time: string | null;
  first_close_time: string | null;
  last_close_time: string | null;
  markets?: MatchedMarket[];
}

export interface EventsQuery extends CallOptions {
  q?: string;
  category?: string;
  venue?: Provider[];
  executableVenue?: Provider[];
  status?: EventStatus[];
  minVenues?: number;
  routable?: boolean;
  startsAfter?: string | Date;
  startsBefore?: string | Date;
  closesAfter?: string | Date;
  closesBefore?: string | Date;
  sort?: "start_time" | "close_time" | "newest" | "markets";
  includeMarkets?: boolean;
  limit?: number;
  cursor?: string;
}

export interface EventsPage {
  events: MatchedEvent[];
  count: number;
  total: number;
  next_cursor: string | null;
  has_more: boolean;
  as_of: string;
}

export interface MatchedMarketDetail {
  market: MatchedMarket;
  event: MatchedEventRef;
  as_of: string;
}

export interface MatchedMarketLookup {
  markets: Record<string, { ref_side: MatchedSide; market: MatchedMarket; event: MatchedEventRef }>;
  as_of: string;
}

export class EventsClient {
  private readonly http: Http;

  constructor(http: Http) {
    this.http = http;
  }

  list(q: EventsQuery = {}): Promise<EventsPage> {
    return this.http.get("/v1/events", {
      q: q.q, category: q.category, venue: q.venue?.join(","), executable_venue: q.executableVenue?.join(","),
      status: q.status?.join(","), min_venues: q.minVenues, routable: q.routable, sort: q.sort,
      starts_after: iso(q.startsAfter), starts_before: iso(q.startsBefore), closes_after: iso(q.closesAfter),
      closes_before: iso(q.closesBefore), include_markets: q.includeMarkets, limit: q.limit, cursor: q.cursor,
    }, undefined, q.signal);
  }

  async *all(query: Omit<EventsQuery, "cursor"> = {}): AsyncGenerator<MatchedEvent> {
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await this.list({ ...query, cursor });
      yield* page.events;
      cursor = page.has_more ? page.next_cursor ?? undefined : undefined;
      if (cursor && cursors.has(cursor)) throw new Error("Kairos repeated the events cursor");
      if (cursor) cursors.add(cursor);
    } while (cursor);
  }

  get(id: string, opts: CallOptions = {}): Promise<{ event: MatchedEvent; as_of: string }> {
    return this.http.get(`/v1/events/${encodeURIComponent(id)}`, undefined, undefined, opts.signal);
  }

  market(id: string, opts: CallOptions = {}): Promise<MatchedMarketDetail> {
    return this.http.get(`/v1/matched-markets/${encodeURIComponent(id)}`, undefined, undefined, opts.signal);
  }

  lookup(refs: readonly string[], opts: CallOptions = {}): Promise<MatchedMarketLookup> {
    if (refs.length < 1 || refs.length > 100 || refs.some(ref => !ref || ref.includes(","))) {
      throw new RangeError("Pass 1–100 comma-free venue:market_id references");
    }
    return this.http.get("/v1/matched-markets", { markets: refs.join(",") }, undefined, opts.signal);
  }
}

function iso(value?: string | Date): string | undefined {
  return value instanceof Date ? value.toISOString() : value;
}
