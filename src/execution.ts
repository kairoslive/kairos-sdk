import type { CallOptions } from "./common.ts";
import { RestClient, type ExecutionPaths, type RestOptions } from "./rest.ts";

export const EXECUTION_URL = "https://execution.kairos.trade";

type GetQuery<P extends keyof ExecutionPaths> = NonNullable<NonNullable<ExecutionPaths[P]["get"]>["parameters"]["query"]>;
type PostBody<P extends keyof ExecutionPaths> = NonNullable<NonNullable<ExecutionPaths[P]["post"]>["requestBody"]>["content"]["application/json"];

export type RouteQuoteQuery = GetQuery<"/orders/route-quote">;
export type RouteBuyInput = PostBody<"/orders/route-buy">;
export type RouteCloseInput = PostBody<"/orders/route-close">;
export type RouteLinkInput = PostBody<"/orders/market-links">;

/** Trading API for authenticated accounts. Partner wallets use WalletClient instead. */
export class ExecutionClient extends RestClient<ExecutionPaths> {
  constructor(options: RestOptions = {}) {
    super({ ...options, baseUrl: options.baseUrl ?? EXECUTION_URL });
  }

  routeFees(query: GetQuery<"/orders/route-fees">, opts: CallOptions = {}) {
    return this.request("GET", "/orders/route-fees", { query, signal: opts.signal });
  }

  routeQuote(query: RouteQuoteQuery, opts: CallOptions = {}) {
    return this.request("GET", "/orders/route-quote", { query, signal: opts.signal });
  }

  routeBuy(body: RouteBuyInput, opts: CallOptions = {}) {
    return this.request("POST", "/orders/route-buy", { body, signal: opts.signal });
  }

  routeClose(body: RouteCloseInput, opts: CallOptions = {}) {
    return this.request("POST", "/orders/route-close", { body, signal: opts.signal });
  }

  routes(query?: GetQuery<"/orders/routes">, opts: CallOptions = {}) {
    return this.request("GET", "/orders/routes", { query, signal: opts.signal });
  }

  routeLink(body: RouteLinkInput, opts: CallOptions = {}) {
    return this.request("POST", "/orders/market-links", { body, signal: opts.signal });
  }

  comboQuote(body: PostBody<"/combo/quote">, opts: CallOptions = {}) {
    return this.request("POST", "/combo/quote", { body, signal: opts.signal });
  }

  comboBuy(body: PostBody<"/combo/execute">, opts: CallOptions = {}) {
    return this.request("POST", "/combo/execute", { body, signal: opts.signal });
  }

  comboPositions(opts: CallOptions = {}) {
    return this.request("GET", "/combo/positions", opts);
  }

  comboCashOutQuote(body: PostBody<"/combo/cash-out-quote">, opts: CallOptions = {}) {
    return this.request("POST", "/combo/cash-out-quote", { body, signal: opts.signal });
  }

  comboCashOut(body: PostBody<"/combo/cash-out">, opts: CallOptions = {}) {
    return this.request("POST", "/combo/cash-out", { body, signal: opts.signal });
  }

  comboRedeem(body: PostBody<"/combo/redeem">, opts: CallOptions = {}) {
    return this.request("POST", "/combo/redeem", { body, signal: opts.signal });
  }
}
