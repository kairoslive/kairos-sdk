// Wallet API (/v3): Kairos sends what to sign, the wallet signs it, the SDK sends it back.
// Actions need only the wallet's signature; reading orders and positions needs a one-signature `login`.
// One setup, order, cancel and read cover every venue; the venue comes from the market.

import { Http, KairosError, type FetchLike, type Query, type RequestOptions } from "./http.ts";
import { isTransient, marketRef, onChain, retryTransient, signWith, sleep, type CallOptions, type Eip1193Provider, type Eip1193Request, type MarketRef } from "./common.ts";
import { FeesClient } from "./fees.ts";
import { TradePlansClient } from "./trade-plans.ts";
import { OnchainIntentsClient } from "./onchain-intents.ts";

export { marketRef, type Eip1193Provider, type Eip1193Request, type MarketRef } from "./common.ts";

export type Side = "buy" | "sell";
export type TimeInForce = "GTC" | "GTD" | "FOK" | "FAK" | "IOC";

export type Venue = "polymarket" | "predictfun" | "hyperliquid";


export interface OrderInput {
  /** The market: an object from `markets.list`, or `venue:market_id` such as `predictfun:1027194` or `hyperliquid:11422`. */
  market: MarketRef;
  /** Outcome name, e.g. `"Yes"`. */
  outcome: string;
  side: Side;
  /** 0–1. Strings keep decimals exact. */
  price: string | number;
  size: string | number;
  timeInForce?: TimeInForce;
  postOnly?: boolean;
  /** Your id for the order. Reusing it with the same terms returns the existing order instead of placing a second one. On Hyperliquid it must be `0x` + 32 lowercase hex. */
  clientOrderId?: string;
  /** Unix seconds; GTD only. Predict.fun orders never outlive the wallet's venue session (about a day). */
  expiresAt?: number;
}

export type Action =
  | { type: "login" }
  | { type: "setup"; venues?: Venue[] }
  | ({ type: "order" } & Omit<OrderInput, "price" | "size" | "market"> & { market: string; price: string; size: string })
  | { type: "cancel"; orderIds: string[] }
  | { type: "cancel"; all: true };

export type StepStatus = "needs_signature" | "working" | "done" | "failed";

/** Why an action failed, when the server gives a code. Other codes may appear; treat unknown ones as a plain failure. */
export type ActionErrorCode =
  | "NO_MATCH"
  | "VENUE_REJECTED"
  | "ORDER_OUTCOME_UNKNOWN"
  | "CANCEL_OUTCOME_UNKNOWN"
  | "SIGNATURE_EXPIRED"
  | "CLIENT_ORDER_ID_CONFLICT"
  | "HYPERLIQUID_AGENT_MISSING"
  | "POLYMARKET_V2_TRADING_DISABLED"
  | (string & {});

export interface Step<R = unknown> {
  id: string;
  type: Action["type"];
  status: StepStatus;
  /** What the wallet runs next: a signature, or (approvals) transactions it sends itself. */
  request: Eip1193Request | null;
  description: string | null;
  /** The chain the wallet must be on for `request` (EIP-155 hex), or null for any chain. */
  chainId: string | null;
  /** The venue this step is for. */
  venue: Venue | null;
  /** For a `wallet_sendCalls` request: the same calls one transaction at a time. */
  fallbackRequests?: Eip1193Request[];
  /** Unix ms: the last moment the server accepts the answer to `request`. */
  expiresAtMs?: number;
  /** Unix ms: an order is waiting on the venue until then; `result` holds its provisional state. */
  holdUntilMs?: number;
  result: R | null;
  error: string | null;
  /** Set on some failures. */
  errorCode?: ActionErrorCode;
}

export type NextStep = "setup" | "wait" | "fund" | "blocked" | null;

/** One venue's readiness after setup. */
export interface VenueSetup {
  ready: boolean;
  /** Where to send this venue's collateral. */
  tradingWallet?: string;
  next?: NextStep;
  /** Polymarket: the approvals transaction, when setup sent one. */
  transactionHash?: string | null;
  /** Predict.fun: when the venue session ends (RFC 3339). */
  sessionExpiresAt?: string;
  /** Set when this venue's setup failed; the other venues still ran. */
  error?: string;
  /** On `next: "fund"` or `"blocked"`: `reason`, and venue specifics such as `approvals` and `gasWei`. */
  venueDetail?: { reason?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface SetupResult {
  /** True when every venue is ready. */
  ready: boolean;
  /** The wallet's Polymarket deposit wallet: fund this address with pUSD. */
  tradingWallet?: string;
  /** The Polymarket approvals transaction, when setup sent one. */
  transactionHash?: string | null;
  venues?: Partial<Record<Venue, VenueSetup>>;
}

/** Order statuses on Kairos order rows. */
export type OrderStatus =
  | "pending"
  | "queued"
  | "locked"
  | "executing"
  | "live"
  | "partial"
  | "filled"
  | "cancelled"
  | "expired"
  | "failed"
  | "orphaned"
  | (string & {});

export interface OrderResult {
  orderId: string;
  /** An order status, or the venue's first answer such as `matched`, `delayed` or `unmatched`. */
  status: OrderStatus | "matched" | "delayed" | "unmatched";
  venueOrderId: string | null;
  /** The venue's first answer. */
  venueStatus?: string | null;
  /** Shares filled; null when unknown. */
  filledSize?: string | null;
  /** Collateral filled, before venue fees; null when unknown. */
  filledNotional?: string | null;
  avgPrice?: string | null;
  /** True once matching has finished. */
  final?: boolean;
  /** False when the order did nothing, failed, or is not confirmed yet. */
  success?: boolean;
  /** Why `success` is false, e.g. "No fill: the venue matched none of this order". */
  message?: string | null;
  venue?: Venue;
  /** `venue:market_id`. */
  market?: string;
}

export interface CancelResult {
  cancelled: string[];
  /** Orders that were already filled or cancelled (cancel by id only). */
  alreadyClosed?: string[];
  /** Per-order failures for a cancel by id; a count for cancel-all. */
  failed: { orderId: string; reason: string; code?: string }[] | number;
  venueDetail?: Record<string, unknown>;
}

/** Venue specifics on a status read. Keys depend on the venue. */
export interface VenueStatusDetail {
  /** The chain this venue signs on (EIP-155 hex). */
  chainId?: string;
  /** Predict.fun: BNB for gas, whole units. */
  gasBalance?: string | null;
  /** Predict.fun: approvals still to send. */
  missingApprovals?: number;
  /** Predict.fun: when the venue session ends (RFC 3339). */
  sessionExpiresAt?: string | null;
  /** Hyperliquid: `"Mainnet"` or `"Testnet"`. */
  network?: string;
  /** Hyperliquid: perps USDC the next order can move to spot. */
  transferFromPerps?: { available: string; note?: string };
  /** Hyperliquid: e.g. `HYPERLIQUID_AGENT_MISSING` when setup must run again. */
  code?: string;
  reason?: string;
  /** Hyperliquid: the account cannot be used here (`next: "blocked"`). */
  blocked?: boolean;
  accountMode?: string;
  [key: string]: unknown;
}

/** One venue's readiness and balance. */
export interface VenueStatus {
  ready: boolean;
  next: NextStep;
  tradingWallet?: string;
  /** Collateral balance in whole units (`currency`); null when it could not be read. */
  balance: string | null;
  currency?: string;
  /** False when this venue could not be read right now (`error` says why); it is left out of `ready` and `next`. */
  available?: boolean;
  error?: string;
  /** When this venue was read (RFC 3339). */
  asOf?: string;
  venueDetail?: VenueStatusDetail;
}

export interface WalletStatus {
  wallet: string;
  /** The wallet's Polymarket deposit wallet: fund this address with pUSD. */
  tradingWallet?: string;
  /** True when every available venue is ready. */
  ready: boolean;
  /** Polymarket pUSD balance of the trading wallet, when known. */
  balance?: string | null;
  /** What the wallet needs next: `"setup"`, `"wait"` (approvals it sent are confirming; nothing to sign), `"fund"`, `"blocked"` (the venue account cannot be used here; see `venueDetail.reason`), or `null` when it can trade. */
  next: NextStep;
  /** Venues this deployment offers; others are left out. */
  venues?: Partial<Record<Venue, VenueStatus>>;
}

/** An order, the same shape on every venue: prices 0–1 and sizes in shares, as decimal strings. */
export interface WalletOrder {
  orderId: string;
  venue: Venue;
  /** `venue:market_id`. */
  market: string;
  marketId: string;
  outcome: string | null;
  tokenId?: string | null;
  side: Side | (string & {});
  /** `limit` or `market`. */
  type?: string;
  price: string | null;
  size: string;
  filledSize: string;
  avgFillPrice?: string | null;
  timeInForce?: TimeInForce | (string & {});
  postOnly?: boolean;
  expiresAt?: string | null;
  status: OrderStatus;
  venueOrderId?: string | null;
  clientOrderId?: string | null;
  createdAt: string;
  updatedAt?: string;
  [key: string]: unknown;
}

export interface WalletPosition {
  venue: Venue;
  market: string;
  marketId: string;
  outcome: string | null;
  tokenId: string;
  /** Shares held. */
  size: string;
  /** Shares not locked by open sell orders. */
  availableToSell?: string;
  avgPrice: string | null;
  realizedPnl?: string | null;
  /** The address that holds the shares. */
  holdingWallet?: string;
  lastTradeAt?: string | null;
  [key: string]: unknown;
}

/** `GET /v3/wallets/{address}/positions`: open positions plus resolved and closed ones. */
export interface WalletPositions {
  positions: WalletPosition[];
  /** Positions whose market resolved; `redeemable` is true for winners. */
  resolved: (WalletPosition & { redeemable: boolean })[];
  /** Positions closed to zero. */
  closed: { venue: Venue; tokenId: string }[];
  /** Server time of this snapshot. */
  asOf: string;
  [key: string]: unknown;
}

/** Venues whose read failed, with why. The other venues' rows are still returned. */
export type VenueReadErrors = Partial<Record<Venue, { error: string }>>;

export interface OrdersPage {
  orders: WalletOrder[];
  /** Present when some venue could not be read. */
  venueDetail?: VenueReadErrors;
}

export interface PositionsPage {
  positions: WalletPositions;
  /** Present when some venue could not be read. */
  venueDetail?: VenueReadErrors;
}

/** What a `login` returns: a read-only token for one wallet's orders and positions. */
export interface WalletCredentials {
  /** Send as `Authorization: SIWE <token>`. */
  token: string;
  /** ISO time after which the token stops working. */
  expiresAt: string;
}

/** Thrown when an action ends in `failed`. Start a new action to retry. */
export class ActionFailedError extends Error {
  readonly step: Step;

  constructor(step: Step) {
    super(step.error ?? `${step.type} failed`);
    this.name = "ActionFailedError";
    this.step = step;
  }

  /** The server's failure code, e.g. `NO_MATCH` or `SIGNATURE_EXPIRED`, when it gave one. */
  get errorCode(): ActionErrorCode | undefined {
    return this.step.errorCode;
  }

  /** True when the order or cancel may still have happened: check `orders(wallet, { open: true })` before retrying. */
  get outcomeUnknown(): boolean {
    return this.step.errorCode === "ORDER_OUTCOME_UNKNOWN" || this.step.errorCode === "CANCEL_OUTCOME_UNKNOWN";
  }
}

/** An API key from your Kairos account, with the `trade:execute` scope (and `trade:read` for fee reads). */
export interface ApiKeyCredentials {
  clientId: string;
  apiKey: string;
  apiSecret: string;
}

export interface WalletClientOptions {
  /** Your partner id from Kairos, sent as `X-Kairos-Partner-Id`. Pass this or `apiKey`, not both. */
  partnerId?: string;
  /**
   * Your API key, sent as `X-Client-Id`, `X-Api-Key` and `X-Api-Secret` instead of a partner id. Pass this or `partnerId`, not both.
   * Server-side only: never ship the secret to a browser or app.
   */
  apiKey?: ApiKeyCredentials;
  /** The wallet that signs each step. */
  provider: Eip1193Provider;
  /** Your Kairos base URL. */
  baseUrl: string;
  /** Called before each signature, e.g. to show `description` in your UI. */
  onStep?: (step: Step) => void;
  /** Delay between polls while something is working. Default 2000 ms. */
  pollIntervalMs?: number;
  /** Give up waiting after this long. Default 15 minutes, the life of an action. */
  timeoutMs?: number;
  /** Aborts every call made by this client. A per-call `signal` takes precedence. */
  signal?: AbortSignal;
  /** Called after each login with the new token, e.g. to keep it and pass it back via `useCredentials`. */
  onLogin?: (wallet: string, credentials: WalletCredentials) => void;
  fetch?: FetchLike;
}

/** What the fee, plan and intent clients borrow from the wallet client. */
export interface WalletContext {
  provider: Eip1193Provider;
  pollIntervalMs: number;
  timeoutMs: number;
  signal(opts?: CallOptions): AbortSignal | undefined;
  /** A request that proves the caller: `SIWE` login in partner mode, the API key in key mode. */
  request<T>(wallet: string, method: "GET" | "POST", path: string, opts?: RequestOptions): Promise<T>;
  status(wallet: string, opts?: CallOptions): Promise<WalletStatus>;
}

// Bounds the "action is busy" retries so a stuck lock cannot spin forever.
const MAX_BUSY_RETRIES = 5;
const MIN_HOLD_WAIT_MS = 250;

export class WalletClient {
  /** Preview: staging only for now. Trading fees owed by the wallet, and paying them. */
  readonly fees: FeesClient;
  /** Preview: staging only for now. A buy signed in one batch, optionally bridging the collateral it needs first. */
  readonly tradePlans: TradePlansClient;
  /** Preview: staging only for now. Split, merge and redeem Polymarket positions without gas. */
  readonly onchain: OnchainIntentsClient;

  private readonly http: Http;
  private readonly provider: Eip1193Provider;
  private readonly apiKeyMode: boolean;
  private readonly onStep?: (step: Step) => void;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly defaultSignal?: AbortSignal;
  private readonly onLogin?: (wallet: string, credentials: WalletCredentials) => void;
  private readonly credentials = new Map<string, WalletCredentials>();
  private readonly logins = new Map<string, Promise<WalletCredentials>>();

  constructor(opts: WalletClientOptions) {
    if (!opts.partnerId === !opts.apiKey) throw new Error("pass either partnerId or apiKey (not both)");
    const key = opts.apiKey;
    if (key && !(key.clientId && key.apiKey && key.apiSecret)) throw new Error("apiKey needs clientId, apiKey and apiSecret");
    const auth: Record<string, string> = key
      ? { "x-client-id": key.clientId, "x-api-key": key.apiKey, "x-api-secret": key.apiSecret }
      : { "x-kairos-partner-id": opts.partnerId! };
    this.http = new Http({ baseUrl: opts.baseUrl, headers: { ...auth, "x-kairos-wallet-api": "2" }, fetch: opts.fetch });
    this.provider = opts.provider;
    this.apiKeyMode = !!key;
    this.onStep = opts.onStep;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.timeoutMs = opts.timeoutMs ?? 15 * 60 * 1000;
    this.defaultSignal = opts.signal;
    this.onLogin = opts.onLogin;

    const context: WalletContext = {
      provider: this.provider,
      pollIntervalMs: this.pollIntervalMs,
      timeoutMs: this.timeoutMs,
      signal: (o) => this.signalFor(o),
      request: (wallet, method, path, o) => this.callerRequest(wallet, method, path, o, !this.apiKeyMode),
      status: (wallet, o) => this.status(wallet, o),
    };
    this.fees = new FeesClient(context);
    this.tradePlans = new TradePlansClient(context);
    this.onchain = new OnchainIntentsClient(context);
  }

  /**
   * Sign in with Ethereum (one `personal_sign`) and keep the read token for `orders` and `positions`.
   * The wallet must be set up on at least one venue first.
   */
  login(wallet: string, opts: CallOptions = {}): Promise<WalletCredentials> {
    // Concurrent callers share one sign-in so the wallet is prompted once; tokens are stateless and never revoked.
    const id = wallet.toLowerCase();
    let pending = this.logins.get(id);
    if (!pending) {
      pending = this.signIn(wallet, opts).finally(() => this.logins.delete(id));
      this.logins.set(id, pending);
    }
    return pending;
  }

  private async signIn(wallet: string, opts: CallOptions): Promise<WalletCredentials> {
    const credentials = await this.run<WalletCredentials>(wallet, { type: "login" }, opts);
    this.useCredentials(wallet, credentials);
    this.onLogin?.(wallet, credentials);
    return credentials;
  }

  /** Reuse a token from an earlier `login` (e.g. restored from storage). */
  useCredentials(wallet: string, credentials: WalletCredentials): void {
    this.credentials.set(wallet.toLowerCase(), credentials);
  }

  /** Set the wallet up on every venue (or only `venues`). Safe to call again: what is done is skipped. */
  setup(wallet: string, opts: { venues?: Venue[] } & CallOptions = {}): Promise<SetupResult> {
    return this.run<SetupResult>(wallet, opts.venues ? { type: "setup", venues: opts.venues } : { type: "setup" }, opts);
  }

  /** Place an order on the market's venue; any setup it still needs runs first, in the same action. */
  order(wallet: string, order: OrderInput, opts: CallOptions = {}): Promise<OrderResult> {
    const { price, size, market, ...rest } = order;
    return this.run<OrderResult>(wallet, { type: "order", market: marketRef(market), ...rest, price: String(price), size: String(size) }, opts);
  }

  /** Cancel orders by Kairos `orderId` (up to 100), on any venue. One signature. */
  cancel(wallet: string, orderIds: string[], opts: CallOptions = {}): Promise<CancelResult> {
    return this.run<CancelResult>(wallet, { type: "cancel", orderIds }, opts);
  }

  /** Cancel every open order on every venue. One signature. */
  cancelAll(wallet: string, opts: CallOptions = {}): Promise<CancelResult> {
    return this.run<CancelResult>(wallet, { type: "cancel", all: true }, opts);
  }

  /** Whether the wallet can trade, and what it needs next. */
  status(wallet: string, opts: CallOptions = {}): Promise<WalletStatus> {
    return this.http.get<WalletStatus>(`/v3/wallets/${wallet}`, undefined, undefined, this.signalFor(opts));
  }

  /** The wallet's orders; `open: true` for live orders only. Logs in first if there is no usable token. */
  async orders(wallet: string, opts: OrdersQuery = {}): Promise<WalletOrder[]> {
    return (await this.ordersPage(wallet, opts)).orders;
  }

  /** Like `orders`, plus `venueDetail` naming any venue that could not be read. */
  ordersPage(wallet: string, opts: OrdersQuery = {}): Promise<OrdersPage> {
    const query: Query = { open: opts.open ? "true" : undefined, limit: opts.limit, venue: opts.venue };
    return this.callerRequest<OrdersPage>(wallet, "GET", `/v3/wallets/${wallet}/orders`, { query, signal: opts.signal }, true);
  }

  /** The wallet's positions on every venue (or one). Logs in first if there is no usable token. */
  async positions(wallet: string, opts: { venue?: Venue } & CallOptions = {}): Promise<WalletPositions> {
    return (await this.positionsPage(wallet, opts)).positions;
  }

  /** Like `positions`, plus `venueDetail` naming any venue that could not be read. */
  positionsPage(wallet: string, opts: { venue?: Venue } & CallOptions = {}): Promise<PositionsPage> {
    return this.callerRequest<PositionsPage>(wallet, "GET", `/v3/wallets/${wallet}/positions`, { query: { venue: opts.venue }, signal: opts.signal }, true);
  }

  /**
   * A request that proves who is calling. With `siwe`, it carries the wallet's login token, logging in first when there is
   * no usable one and once more on a 401. Without it (API-key mode) the key is the proof; a token already held is still sent.
   */
  private async callerRequest<T>(wallet: string, method: "GET" | "POST", path: string, opts: RequestOptions = {}, siwe: boolean): Promise<T> {
    const signal = this.signalFor(opts);
    const send = (c?: WalletCredentials) => this.http.request<T>(method, path, { ...opts, signal, headers: { ...opts.headers, ...(c ? authHeaders(c) : {}) } });
    let credentials = this.usableCredentials(wallet);
    if (!siwe) return send(credentials);
    const fresh = !credentials;
    if (!credentials) credentials = await this.login(wallet, { signal });
    try {
      return await send(credentials);
    } catch (e) {
      // A token the server no longer accepts answers 401: log in once more.
      if (fresh || !(e instanceof KairosError) || e.status !== 401) throw e;
      return send(await this.login(wallet, { signal }));
    }
  }

  private usableCredentials(wallet: string): WalletCredentials | undefined {
    const c = this.credentials.get(wallet.toLowerCase());
    return c && Date.parse(c.expiresAt) > Date.now() + 60_000 ? c : undefined;
  }

  private signalFor(opts?: CallOptions): AbortSignal | undefined {
    return opts?.signal ?? this.defaultSignal;
  }

  getAction<R = unknown>(id: string, opts: CallOptions = {}): Promise<Step<R>> {
    return this.http.get<Step<R>>(`/v3/actions/${id}`, undefined, undefined, this.signalFor(opts));
  }

  /** Run any action to completion: sign each step with the provider and return the result. */
  async run<R = unknown>(wallet: string, action: Action, opts: CallOptions = {}): Promise<R> {
    const signal = this.signalFor(opts);
    const deadline = Date.now() + this.timeoutMs;
    const read = (id: string) => retryTransient(() => this.getAction<R>(id, { signal }), deadline, this.pollIntervalMs, signal);
    let step = await this.http.post<Step<R>>("/v3/actions", { wallet, action }, undefined, signal);
    // An answer that got no clean reply, re-sent instead of prompting the wallet again if the same request is still open.
    let retry: { request: string; answer: StepAnswer } | undefined;
    let busy = 0;
    for (;;) {
      switch (step.status) {
        case "done":
          return step.result as R;
        case "failed":
          throw new ActionFailedError(step);
        case "needs_signature": {
          if (!step.request) throw new ActionFailedError({ ...step, error: "step has no signing request" });
          const key = JSON.stringify(step.request);
          let answer = retry?.request === key ? retry.answer : undefined;
          retry = undefined;
          if (!answer) {
            this.onStep?.(step);
            const open = step;
            answer = await onChain(this.provider, open.chainId, () => this.answer(open), signal);
          }
          try {
            step = await this.http.post<Step<R>>(`/v3/actions/${step.id}`, answer, undefined, signal);
            busy = 0;
          } catch (e) {
            // Another request holds the action, or the answer may have landed unseen: read it and carry on from where it is.
            if (!(isBusy(e) || isTransient(e)) || ++busy > MAX_BUSY_RETRIES) throw e;
            signal?.throwIfAborted();
            retry = { request: key, answer };
            await sleep(Math.min(this.pollIntervalMs, 1000), signal);
            step = await read(step.id);
          }
          break;
        }
        case "working": {
          const now = Date.now();
          if (now > deadline) throw new ActionFailedError({ ...step, error: "timed out waiting for the action", errorCode: timeoutCode(step) });
          const wait = step.holdUntilMs && step.holdUntilMs > now ? Math.max(MIN_HOLD_WAIT_MS, step.holdUntilMs - now) : this.pollIntervalMs;
          await sleep(Math.min(wait, Math.max(0, deadline - now) + 1), signal);
          step = await read(step.id);
          break;
        }
        default:
          throw new ActionFailedError({ ...step, error: `unexpected step status ${String(step.status)}` });
      }
    }
  }

  /** A signature comes back as `signature`; sent transactions as `result`. */
  private async answer(step: Step): Promise<StepAnswer> {
    const request = step.request!;
    if (request.method === "wallet_sendCalls" || request.method === "eth_sendTransaction") {
      try {
        return { result: await this.provider.request(request) };
      } catch (e) {
        if (!step.fallbackRequests?.length || !isUnsupported(e)) throw e;
        const hashes: unknown[] = [];
        for (const tx of step.fallbackRequests) hashes.push(await this.provider.request(tx));
        return { result: hashes };
      }
    }
    return { signature: await signWith(this.provider, request) };
  }
}

export interface OrdersQuery extends CallOptions {
  open?: boolean;
  /** 1–500. Default 50. */
  limit?: number;
  venue?: Venue;
}

type StepAnswer = { signature: string } | { result: unknown };

function isBusy(e: unknown): boolean {
  return e instanceof KairosError && e.status === 409 && /busy/i.test(e.message);
}

// A working order or cancel may still land after the client stops waiting.
function timeoutCode(step: Step): ActionErrorCode | undefined {
  if (step.type === "order") return "ORDER_OUTCOME_UNKNOWN";
  if (step.type === "cancel") return "CANCEL_OUTCOME_UNKNOWN";
  return step.errorCode;
}

function isUnsupported(e: unknown): boolean {
  const code = (e as { code?: number })?.code;
  return code === 4200 || code === -32601 || code === 4100;
}

function authHeaders(c: WalletCredentials): Record<string, string> {
  return { authorization: `SIWE ${c.token}` };
}
