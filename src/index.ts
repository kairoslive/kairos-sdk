// Kairos SDK: one package for market data, trader stats, wallet trading (/v3) and external signing (/v2).
// No runtime dependencies.

import { MarketStream, type MarketStreamOptions } from "./stream.ts";
import { DataClient } from "./data.ts";
import { ExecutionClient } from "./execution.ts";
import type { RestOptions } from "./rest.ts";
import { MarketDataClient, type MarketDataOptions } from "./markets.ts";
import { TraderClient } from "./traders.ts";
import { WalletClient, type WalletClientOptions } from "./wallets.ts";
import type { FetchLike } from "./http.ts";

export interface KairosOptions {
  /** Market data base URL. Default `https://md.kairos.trade`. */
  marketDataUrl?: string;
  /** Data API base URL (Discover, search and trader stats). Default `https://data.kairos.trade`. */
  dataUrl?: string;
  /** Credentials for optional enhanced Market Data access. */
  marketDataAuth?: RestOptions["auth"];
  /** Data API credentials and optional override for dataUrl. */
  data?: Omit<RestOptions, "fetch">;
  /** Trading API credentials and base URL. Use API key secrets on a server. */
  execution?: Omit<RestOptions, "fetch">;
  /** Wallet API: your Kairos base URL, partner id (or API key, server-side) and the wallet's EIP-1193 provider. */
  wallet?: Omit<WalletClientOptions, "fetch">;
  fetch?: FetchLike;
}

export interface Kairos {
  markets: MarketDataClient;
  data: DataClient;
  execution: ExecutionClient;
  stream(options?: MarketStreamOptions): MarketStream;
  /** Public trader stats: positions with realized P&L, open and closed. */
  traders: TraderClient;
  /** Present when `wallet` options were passed. Also `wallet.fees`, `wallet.tradePlans` and `wallet.onchain` (preview). */
  wallet: WalletClient;
}

/** Build a client. `markets` and `traders` always work; `wallet` needs `wallet` options. */
export function createKairos(opts: KairosOptions = {}): Kairos {
  const markets = new MarketDataClient({ baseUrl: opts.marketDataUrl, auth: opts.marketDataAuth, fetch: opts.fetch } satisfies MarketDataOptions);
  const dataUrl = opts.data?.baseUrl ?? opts.dataUrl;
  const data = new DataClient({ ...opts.data, baseUrl: dataUrl, fetch: opts.fetch });
  const execution = new ExecutionClient({ ...opts.execution, fetch: opts.fetch });
  const traders = new TraderClient({ baseUrl: dataUrl, fetch: opts.fetch });
  const wallet = opts.wallet ? new WalletClient({ ...opts.wallet, fetch: opts.fetch }) : undefined;
  return {
    markets,
    data,
    execution,
    stream: (options) => new MarketStream(options),
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
  type ActionAnswer,
  type RunActionOptions,
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
  type RoutedLegResult,
  type RoutedOrderInput,
  type ComboInput,
  type ComboResult,
  type WalletCombo,
  type RoutedOrderResult,
  type RoutePlan,
  type RoutePlanLeg,
  type Step,
  type StepStatus,
  type StepType,
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
  isOnchainIntentFinal,
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
  type MarketBatchPage,
  type MarkPair,
  type MarketContract,
  type MarketIdentifier,
  type PerpetualVenue,
  type TickGridProvider,
  type TickGridQuery,
  type TradeMetricsQuery,
  type TradeTapeQuery,
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

export {
  MARKET_STREAM_PUBLIC_PROTOCOL,
  MARKET_STREAM_URL,
  MarketStream,
  decodeMarketStreamFrame,
  encodeMarketStreamRequest,
  type MarketStreamAuth,
  type MarketStreamContract,
  type MarketStreamFrame,
  type MarketStreamMessage,
  type MarketStreamOptions,
  type MarketStreamRequest,
  type MarketStreamSocket,
  type MarketStreamSocketEvents,
  type MarketStreamSocketFactory,
  type MarketStreamSocketOptions,
  type MarketStreamSubscription,
  type MarketStreamTopic,
} from "./stream.ts";

export { DataClient, type DiscoverQuery } from "./data.ts";
export { ExecutionClient, EXECUTION_URL, type RouteQuoteQuery, type RouteBuyInput, type RouteCloseInput, type RouteLinkInput } from "./execution.ts";
export { RestClient, type RestAuth, type RestOptions, type DataPaths, type ExecutionPaths, type MarketDataPaths } from "./rest.ts";
export {
  EventsClient, type EventsPage, type EventsQuery, type EventStatus, type MatchedEvent, type MatchedEventRef,
  type MatchedMarket, type MatchedMarketDetail, type MatchedMarketLookup, type MatchedSide, type MatchedVenue,
} from "./events.ts";
export { readWebhook, verifyWebhookSignature, type WebhookEvent, type WebhookType, type WebhookVerifyOptions } from "./webhooks.ts";
