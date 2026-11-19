import { RestClient, type DataPaths, type RestOptions } from "./rest.ts";
import type { CallOptions } from "./common.ts";
import { DATA_URL } from "./traders.ts";

export type DiscoverQuery = NonNullable<DataPaths["/api/markets/discover/v2"]["get"]["parameters"]["query"]>;

export class DataClient extends RestClient<DataPaths> {
  constructor(options: RestOptions = {}) {
    super({ ...options, baseUrl: options.baseUrl ?? DATA_URL });
  }

  /** One page of the full catalog, including markets listed on a single venue. */
  discover(query: DiscoverQuery = {}, opts: CallOptions = {}) {
    return this.request("GET", "/api/markets/discover/v2", { query, signal: opts.signal });
  }

  discoverTicker(limit?: number, opts: CallOptions = {}) {
    return this.request("GET", "/api/markets/discover/v2/ticker", { query: { limit }, signal: opts.signal });
  }

  discoverPulse(limit?: number, opts: CallOptions = {}) {
    return this.request("GET", "/api/markets/discover/v2/breaking", { query: { limit }, signal: opts.signal });
  }

  discoverExpiring(limit?: number, opts: CallOptions = {}) {
    return this.request("GET", "/api/markets/discover/v2/expiring", { query: { limit }, signal: opts.signal });
  }

  discoverSubcategories(category: string, opts: CallOptions = {}) {
    return this.request("GET", "/api/markets/discover/v2/subcategories", { query: { category }, signal: opts.signal });
  }

  sportsComboMarkets(opts: CallOptions = {}) {
    return this.request("GET", "/sports/combo-markets", opts);
  }

  discoverSearchIndex(opts: CallOptions = {}) {
    return this.request("GET", "/api/markets/discover/v2/search-index", opts);
  }
}
