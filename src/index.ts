// Kairos SDK: one package for market data, trader stats, wallet trading (/v3) and external signing (/v2).
// No runtime dependencies.

import { MarketDataClient, type MarketDataOptions } from "./markets.ts";
import { TraderClient } from "./traders.ts";
import { WalletClient, type WalletClientOptions } from "./wallets.ts";
import type { FetchLike } from "./http.ts";

export interface KairosOptions {
  /** Market data base URL. Default `https://md.kairos.trade`. */
  marketDataUrl?: string;
  /** Data API base URL (trader stats). Default `https://data.kairos.trade`. */
  dataUrl?: string;
  /** Wallet API: your Kairos base URL, partner id (or API key, server-side) and the wallet's EIP-1193 provider. */
  wallet?: Omit<WalletClientOptions, "fetch">;
  fetch?: FetchLike;
}

export interface Kairos {
  markets: MarketDataClient;
  /** Public trader stats: positions with realized P&L, open and closed. */
  traders: TraderClient;
  /** Present when `wallet` options were passed. Also `wallet.fees`, `wallet.tradePlans` and `wallet.onchain` (preview). */
  wallet: WalletClient;
}

/** Build a client. `markets` and `traders` always work; `wallet` needs `wallet` options. */
export function createKairos(opts: KairosOptions = {}): Kairos {
  const markets = new MarketDataClient({ baseUrl: opts.marketDataUrl, fetch: opts.fetch } satisfies MarketDataOptions);
  const traders = new TraderClient({ baseUrl: opts.dataUrl, fetch: opts.fetch });
  const wallet = opts.wallet ? new WalletClient({ ...opts.wallet, fetch: opts.fetch }) : undefined;
  return {
    markets,
    traders,
    get wallet(): WalletClient {
      if (!wallet) throw new Error("pass `wallet: { baseUrl, partnerId, provider }` (or `apiKey` instead of `partnerId`) to createKairos to use the wallet API");
      return wallet;
    },
  };
}

export { Http, KairosError, FeeSettlementRequiredError, type FetchLike, type HttpOptions, type Query, type RequestOptions } from "./http.ts";

export { CHAINS, SafetyCheckError, WaitTimeoutError, type CallOptions } from "./common.ts";

export {
  WalletClient,
  ActionFailedError,
  type Action,
  type ActionErrorCode,
  type ApiKeyCredentials,
  type NextStep,
  type OrdersPage,
  type OrdersQuery,
  type OrderStatus,
  type PositionsPage,
  type VenueReadErrors,
  type VenueStatusDetail,
  type WalletContext,
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
  type WalletPositions,
  type WalletCredentials,
  type WalletStatus,
  type Venue,
  type VenueSetup,
  type VenueStatus,
  type MarketRef,
  type Eip1193Request,
  marketRef,
} from "./wallets.ts";

export {
  FeesClient,
  type FeeAnswer,
  type FeeSettlement,
  type FeeSettlementStatus,
  type FeeSummary,
  type FeeVenue,
  type FeeWalletRequest,
  type SettleOptions,
  type VenueFees,
} from "./fees.ts";

export {
  TradePlansClient,
  isTradePlanFinal,
  type Collateral,
  type CtfDependency,
  type FeeShape,
  type FundingPlan,
  type PartnerFeeTerms,
  type RunTradePlanOptions,
  type TradeBudget,
  type TradePlan,
  type TradePlanAnswer,
  type TradePlanError,
  type TradePlanExecution,
  type TradePlanFundingInput,
  type TradePlanInput,
  type TradePlanOrder,
  type TradePlanReport,
  type TradePlanStatus,
  type TradePlanWaitOptions,
  type TradePlanWalletRequest,
} from "./trade-plans.ts";

export {
  OnchainIntentsClient,
  type OnchainCall,
  type OnchainEffect,
  type OnchainExecuteInput,
  type OnchainIntentInput,
  type OnchainIntentStatus,
  type OnchainIntentTerms,
  type OnchainIntentView,
  type OnchainOperation,
  type OnchainRunOptions,
  type OnchainToken,
  type OnchainWaitOptions,
} from "./onchain-intents.ts";

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

export {
  TraderClient,
  DATA_URL,
  type TraderClientOptions,
  type TraderPerformance,
  type TraderPosition,
  type TraderPositions,
  type TraderPositionsQuery,
} from "./traders.ts";

export * as signing from "./signing/index.ts";
