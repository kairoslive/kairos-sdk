// Kairos SDK: one package for market data, wallet trading (/v3) and external signing (/v2).
// No runtime dependencies.

import { MarketDataClient, type MarketDataOptions } from "./markets.ts";
import { WalletClient, type WalletClientOptions } from "./wallets.ts";
import type { FetchLike } from "./http.ts";

export interface KairosOptions {
  /** Market data base URL. Default `https://md.kairos.trade`. */
  marketDataUrl?: string;
  /** Wallet API: your Kairos base URL, partner id and the wallet's EIP-1193 provider. */
  wallet?: Omit<WalletClientOptions, "fetch">;
  fetch?: FetchLike;
}

export interface Kairos {
  markets: MarketDataClient;
  /** Present when `wallet` options were passed. */
  wallet: WalletClient;
}

/** Build a client. `markets` always works; `wallet` needs `wallet` options. */
export function createKairos(opts: KairosOptions = {}): Kairos {
  const markets = new MarketDataClient({ baseUrl: opts.marketDataUrl, fetch: opts.fetch } satisfies MarketDataOptions);
  const wallet = opts.wallet ? new WalletClient({ ...opts.wallet, fetch: opts.fetch }) : undefined;
  return {
    markets,
    get wallet(): WalletClient {
      if (!wallet) throw new Error("pass `wallet: { baseUrl, partnerId, provider }` to createKairos to use the wallet API");
      return wallet;
    },
  };
}

export { Http, KairosError, type FetchLike, type HttpOptions, type Query } from "./http.ts";

export {
  WalletClient,
  ActionFailedError,
  type Action,
  type CancelResult,
  type Eip1193Provider,
  type OrderInput,
  type OrderResult,
  type SetupResult,
  type Side,
  type Step,
  type StepStatus,
  type TimeInForce,
  type WalletClientOptions,
  type WalletOrder,
  type WalletPosition,
  type WalletStatus,
} from "./wallets.ts";

export {
  MarketDataClient,
  MARKET_DATA_URL,
  type CandlesQuery,
  type Market,
  type MarketDataOptions,
  type MarketOutcome,
  type MarketPage,
  type Provider,
  type Timeframe,
  type TradesQuery,
} from "./markets.ts";

export * as signing from "./signing/index.ts";
