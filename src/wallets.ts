// Wallet API (/v3): Kairos sends what to sign, the wallet signs it, the SDK sends it back.
// Actions need only the wallet's signature; reading orders and positions needs a one-signature `login`.
// One setup, order, cancel and read cover every venue; the venue comes from the market.

import { Http, KairosError, type FetchLike, type Query } from "./http.ts";

/** Anything with an EIP-1193 `request`, e.g. `window.ethereum`, a WalletConnect provider, or a viem/ethers adapter. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export type Side = "buy" | "sell";
export type TimeInForce = "GTC" | "GTD" | "FOK" | "FAK" | "IOC";

export type Venue = "polymarket" | "predictfun" | "hyperliquid";

/** A market from the market data API, or its reference `venue:market_id` (a bare `0x…` condition id is Polymarket). */
export type MarketRef = string | { exchange_id: string; market_id?: string | number; condition_id?: string };

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

export interface Eip1193Request {
  method: string;
  params: unknown[];
}

export interface Step<R = unknown> {
  id: string;
  type: Action["type"];
  status: StepStatus;
  /** What the wallet runs next: a signature, or (approvals) transactions it sends itself. */
  request: Eip1193Request | null;
  description: string | null;
  /** The chain the wallet must be on for `request` (EIP-155 hex), or null for any chain. */
  chainId?: string | null;
  /** The venue this step is for. */
  venue?: Venue | null;
  /** For a `wallet_sendCalls` request: the same calls one transaction at a time. */
  fallbackRequests?: Eip1193Request[];
  result: R | null;
  error: string | null;
}

/** One venue's readiness after setup. */
export interface VenueSetup {
  ready: boolean;
  /** Where to send this venue's collateral. */
  tradingWallet?: string;
  next?: "setup" | "wait" | "fund" | "blocked" | null;
  error?: string;
  venueDetail?: Record<string, unknown>;
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

export interface OrderResult {
  orderId: string;
  status: string;
  venueOrderId: string | null;
  venue?: Venue;
  /** `venue:market_id`. */
  market?: string;
}

export interface CancelResult {
  cancelled: string[];
  /** Orders that were already filled or cancelled (cancel by id only). */
  alreadyClosed?: string[];
  /** Per-order failures for a cancel by id; a count for cancel-all. */
  failed: { orderId: string; reason: string }[] | number;
  venueDetail?: Record<string, unknown>;
}

/** One venue's readiness and balance. */
export interface VenueStatus {
  ready: boolean;
  next: "setup" | "wait" | "fund" | "blocked" | null;
  tradingWallet?: string;
  /** Collateral balance in whole units (`currency`). */
  balance: string | null;
  currency?: string;
  available?: boolean;
  error?: string;
  venueDetail?: Record<string, unknown>;
}

export interface WalletStatus {
  wallet: string;
  /** The wallet's Polymarket deposit wallet: fund this address with pUSD. */
  tradingWallet?: string;
  /** True when every venue is ready. */
  ready: boolean;
  /** Polymarket pUSD balance of the trading wallet, when known. */
  balance?: string | null;
  /** What the wallet needs next: `"setup"`, `"wait"` (approvals it sent are confirming; nothing to sign), `"fund"`, `"blocked"` (the venue account cannot be used here; see `venueDetail.reason`), or `null` when it can trade. */
  next: "setup" | "wait" | "fund" | "blocked" | null;
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
  side: string;
  price: string | null;
  size: string;
  filledSize: string;
  status: string;
  createdAt: string;
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
  avgPrice: string | null;
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
}

export interface WalletClientOptions {
  /** Your partner id from Kairos, sent as `X-Kairos-Partner-Id`. */
  partnerId: string;
  /** The wallet that signs each step. */
  provider: Eip1193Provider;
  /** Your Kairos base URL. */
  baseUrl: string;
  /** Called before each signature, e.g. to show `description` in your UI. */
  onStep?: (step: Step) => void;
  /** Delay between polls while a step is `working`. Default 2000 ms. */
  pollIntervalMs?: number;
  /** Give up on an action after this long. Default 10 minutes (actions expire after 15). */
  timeoutMs?: number;
  /** Called after each login with the new token, e.g. to keep it and pass it back via `useCredentials`. */
  onLogin?: (wallet: string, credentials: WalletCredentials) => void;
  fetch?: FetchLike;
}

export class WalletClient {
  private readonly http: Http;
  private readonly provider: Eip1193Provider;
  private readonly onStep?: (step: Step) => void;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;
  private readonly onLogin?: (wallet: string, credentials: WalletCredentials) => void;
  private readonly credentials = new Map<string, WalletCredentials>();
  private readonly logins = new Map<string, Promise<WalletCredentials>>();

  constructor(opts: WalletClientOptions) {
    if (!opts.partnerId) throw new Error("partnerId is required");
    this.http = new Http({
      baseUrl: opts.baseUrl,
      headers: { "x-kairos-partner-id": opts.partnerId, "x-kairos-wallet-api": "2" },
      fetch: opts.fetch,
    });
    this.provider = opts.provider;
    this.onStep = opts.onStep;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
    this.onLogin = opts.onLogin;
  }

  /**
   * Sign in with Ethereum (one `personal_sign`) and keep the read token for `orders` and `positions`.
   * The wallet must be set up first.
   */
  login(wallet: string): Promise<WalletCredentials> {
    // Concurrent reads share one sign-in: a second would revoke the first one's key.
    const id = wallet.toLowerCase();
    let pending = this.logins.get(id);
    if (!pending) {
      pending = this.signIn(wallet).finally(() => this.logins.delete(id));
      this.logins.set(id, pending);
    }
    return pending;
  }

  private async signIn(wallet: string): Promise<WalletCredentials> {
    const credentials = await this.run<WalletCredentials>(wallet, { type: "login" });
    this.useCredentials(wallet, credentials);
    this.onLogin?.(wallet, credentials);
    return credentials;
  }

  /** Reuse a token from an earlier `login` (e.g. restored from storage). */
  useCredentials(wallet: string, credentials: WalletCredentials): void {
    this.credentials.set(wallet.toLowerCase(), credentials);
  }

  /** Set the wallet up on every venue (or only `venues`). Safe to call again: what is done is skipped. */
  setup(wallet: string, opts: { venues?: Venue[] } = {}): Promise<SetupResult> {
    return this.run<SetupResult>(wallet, opts.venues ? { type: "setup", venues: opts.venues } : { type: "setup" });
  }

  /** Place an order on the market's venue; any setup it still needs runs first, in the same action. */
  order(wallet: string, order: OrderInput): Promise<OrderResult> {
    const { price, size, market, ...rest } = order;
    return this.run<OrderResult>(wallet, { type: "order", market: marketRef(market), ...rest, price: String(price), size: String(size) });
  }

  /** Cancel orders by id (up to 100), on any venue. One signature. */
  cancel(wallet: string, orderIds: string[]): Promise<CancelResult> {
    return this.run<CancelResult>(wallet, { type: "cancel", orderIds });
  }

  /** Cancel every open order on every venue. One signature. */
  cancelAll(wallet: string): Promise<CancelResult> {
    return this.run<CancelResult>(wallet, { type: "cancel", all: true });
  }

  /** Whether the wallet can trade, and what it needs next. */
  status(wallet: string): Promise<WalletStatus> {
    return this.http.get<WalletStatus>(`/v3/wallets/${wallet}`);
  }

  /** The wallet's orders; `open: true` for live orders only. Logs in first if there is no usable key. */
  async orders(wallet: string, opts: { open?: boolean; limit?: number; venue?: Venue } = {}): Promise<WalletOrder[]> {
    const res = await this.authedGet<{ orders: WalletOrder[] }>(wallet, `/v3/wallets/${wallet}/orders`, {
      open: opts.open ? "true" : undefined,
      limit: opts.limit,
      venue: opts.venue,
    });
    return res.orders;
  }

  /** The wallet's positions on every venue (or one). Logs in first if there is no usable key. */
  positions(wallet: string, opts: { venue?: Venue } = {}): Promise<WalletPositions> {
    return this.authedGet<{ positions: WalletPositions }>(wallet, `/v3/wallets/${wallet}/positions`, { venue: opts.venue }).then(
      (r) => r.positions,
    );
  }

  private async authedGet<T>(wallet: string, path: string, query?: Query): Promise<T> {
    let credentials = this.credentials.get(wallet.toLowerCase());
    const fresh = !credentials || Date.parse(credentials.expiresAt) <= Date.now() + 60_000;
    if (fresh) credentials = await this.login(wallet);
    try {
      return await this.http.get<T>(path, query, authHeaders(credentials!));
    } catch (e) {
      // A token this node no longer accepts answers 401: log in once more.
      if (fresh || !(e instanceof KairosError) || e.status !== 401) throw e;
      return this.http.get<T>(path, query, authHeaders(await this.login(wallet)));
    }
  }

  getAction<R = unknown>(id: string): Promise<Step<R>> {
    return this.http.get<Step<R>>(`/v3/actions/${id}`);
  }

  /** Run any action to completion: sign each step with the provider and return the result. */
  async run<R = unknown>(wallet: string, action: Action): Promise<R> {
    const deadline = Date.now() + this.timeoutMs;
    let step = await this.http.post<Step<R>>("/v3/actions", { wallet, action });
    for (;;) {
      switch (step.status) {
        case "done":
          return step.result as R;
        case "failed":
          throw new ActionFailedError(step);
        case "needs_signature": {
          if (!step.request) throw new ActionFailedError({ ...step, error: "step has no signing request" });
          this.onStep?.(step);
          if (step.chainId) await this.switchChain(step.chainId);
          const answer = await this.answer(step);
          step = await this.http.post<Step<R>>(`/v3/actions/${step.id}`, answer);
          break;
        }
        case "working":
          if (Date.now() > deadline) throw new ActionFailedError({ ...step, error: "timed out waiting for the action" });
          await sleep(this.pollIntervalMs);
          step = await this.getAction<R>(step.id);
          break;
        default:
          throw new ActionFailedError({ ...step, error: `unexpected step status ${String(step.status)}` });
      }
    }
  }
  /** A signature comes back as `signature`; sent transactions as `result`. */
  private async answer(step: Step): Promise<{ signature: string } | { result: unknown }> {
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
    const signature = await this.provider.request(request);
    if (typeof signature !== "string") throw new Error("wallet returned a non-string signature");
    return { signature };
  }

  private async switchChain(chainId: string): Promise<void> {
    const current = await this.provider.request({ method: "eth_chainId", params: [] }).catch(() => null);
    if (typeof current === "string" && current.toLowerCase() === chainId.toLowerCase()) return;
    try {
      await this.provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch (e) {
      const params = CHAINS[chainId.toLowerCase()];
      if ((e as { code?: number })?.code !== 4902 || !params) throw e;
      await this.provider.request({ method: "wallet_addEthereumChain", params: [params] });
    }
  }
}

/** Chains a step may ask for, so a wallet that does not know one can add it. */
const CHAINS: Record<string, unknown> = {
  "0x89": {
    chainId: "0x89",
    chainName: "Polygon",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    rpcUrls: ["https://polygon-rpc.com"],
    blockExplorerUrls: ["https://polygonscan.com"],
  },
  "0x38": {
    chainId: "0x38",
    chainName: "BNB Smart Chain",
    nativeCurrency: { name: "BNB", symbol: "BNB", decimals: 18 },
    rpcUrls: ["https://bsc-dataseed.binance.org"],
    blockExplorerUrls: ["https://bscscan.com"],
  },
};

function isUnsupported(e: unknown): boolean {
  const code = (e as { code?: number })?.code;
  return code === 4200 || code === -32601 || code === 4100;
}

/** `venue:market_id` for a market object or reference. */
export function marketRef(market: MarketRef): string {
  if (typeof market === "string") return market;
  if (market.exchange_id === "polymarket" && market.condition_id) return `polymarket:${market.condition_id}`;
  if (market.market_id === undefined || market.market_id === "") throw new Error("market has no market_id");
  return `${market.exchange_id}:${market.market_id}`;
}

function authHeaders(c: WalletCredentials): Record<string, string> {
  return { authorization: `SIWE ${c.token}` };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
