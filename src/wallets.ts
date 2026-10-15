// Wallet API (/v3): Kairos sends what to sign, the wallet signs it, the SDK sends it back.
// Actions need only the wallet's signature; reading orders and positions needs a one-signature `login`.

import { Http, KairosError, type FetchLike, type Query } from "./http.ts";

/** Anything with an EIP-1193 `request`, e.g. `window.ethereum`, a WalletConnect provider, or a viem/ethers adapter. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export type Side = "buy" | "sell";
export type TimeInForce = "GTC" | "GTD" | "FOK" | "FAK" | "IOC";

export interface OrderInput {
  /** The market's condition id (`condition_id` on the market data API). */
  market: string;
  /** Outcome name, e.g. `"Yes"`. */
  outcome: string;
  side: Side;
  /** 0–1. Strings keep decimals exact. */
  price: string | number;
  size: string | number;
  timeInForce?: TimeInForce;
  postOnly?: boolean;
  clientOrderId?: string;
}

export type Action =
  | { type: "login" }
  | { type: "setup" }
  | ({ type: "order" } & Omit<OrderInput, "price" | "size"> & { price: string; size: string })
  | { type: "cancel"; orderIds: string[] }
  | { type: "cancel"; all: true };

export type StepStatus = "needs_signature" | "working" | "done" | "failed";

export interface Step<R = unknown> {
  id: string;
  type: Action["type"];
  status: StepStatus;
  request: { method: string; params: unknown[] } | null;
  description: string | null;
  result: R | null;
  error: string | null;
}

export interface SetupResult {
  ready: boolean;
  /** The wallet's Polymarket deposit wallet: fund this address with pUSD. */
  tradingWallet: string;
  /** The approvals transaction, when setup sent one. */
  transactionHash?: string | null;
}

export interface OrderResult {
  orderId: string;
  status: string;
  venueOrderId: string | null;
}

export interface CancelResult {
  cancelled: string[];
  /** Orders that were already filled or cancelled (cancel by id only). */
  alreadyClosed?: string[];
  /** Per-order failures for a cancel by id; a count for cancel-all. */
  failed: { orderId: string; reason: string }[] | number;
}

export interface WalletStatus {
  wallet: string;
  /** The wallet's Polymarket deposit wallet: fund this address with pUSD. */
  tradingWallet: string;
  ready: boolean;
  /** pUSD balance of the trading wallet, when known. */
  balance: string | null;
  /** What the wallet needs next: `"setup"`, `"fund"`, or `null` when it can trade. */
  next: "setup" | "fund" | null;
}

export interface WalletOrder {
  id: string;
  status: string;
  [key: string]: unknown;
}

export interface WalletPosition {
  token_id: string;
  market_id: string;
  outcome: string | null;
  net_size: string;
  [key: string]: unknown;
}

/** `GET /v3/wallets/{address}/positions`: open positions plus resolved and closed ones. */
export interface WalletPositions {
  positions: WalletPosition[];
  /** Positions whose market resolved; `redeemable` is true for winners. */
  resolved: WalletPosition[];
  /** Positions closed to zero. */
  closed: { exchange_id: string; token_id: string }[];
  /** Server time of this snapshot. */
  as_of: string;
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
    this.http = new Http({ baseUrl: opts.baseUrl, headers: { "x-kairos-partner-id": opts.partnerId }, fetch: opts.fetch });
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

  /** Create the wallet's trading account and approvals. Safe to call again: a ready wallet returns at once. */
  setup(wallet: string): Promise<SetupResult> {
    return this.run<SetupResult>(wallet, { type: "setup" });
  }

  /** Place an order. One signature. */
  order(wallet: string, order: OrderInput): Promise<OrderResult> {
    const { price, size, ...rest } = order;
    return this.run<OrderResult>(wallet, { type: "order", ...rest, price: String(price), size: String(size) });
  }

  /** Cancel orders by id (up to 100). One signature. */
  cancel(wallet: string, orderIds: string[]): Promise<CancelResult> {
    return this.run<CancelResult>(wallet, { type: "cancel", orderIds });
  }

  /** Cancel every open order. One signature. */
  cancelAll(wallet: string): Promise<CancelResult> {
    return this.run<CancelResult>(wallet, { type: "cancel", all: true });
  }

  /** Whether the wallet can trade, and what it needs next. */
  status(wallet: string): Promise<WalletStatus> {
    return this.http.get<WalletStatus>(`/v3/wallets/${wallet}`);
  }

  /** The wallet's orders; `open: true` for live orders only. Logs in first if there is no usable key. */
  async orders(wallet: string, opts: { open?: boolean; limit?: number } = {}): Promise<WalletOrder[]> {
    const res = await this.authedGet<{ orders: WalletOrder[] }>(wallet, `/v3/wallets/${wallet}/orders`, {
      open: opts.open ? "true" : undefined,
      limit: opts.limit,
    });
    return res.orders;
  }

  /** The wallet's positions. Logs in first if there is no usable key. */
  positions(wallet: string): Promise<WalletPositions> {
    return this.authedGet<{ positions: WalletPositions }>(wallet, `/v3/wallets/${wallet}/positions`).then((r) => r.positions);
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
          const signature = await this.provider.request(step.request);
          if (typeof signature !== "string") throw new Error("wallet returned a non-string signature");
          step = await this.http.post<Step<R>>(`/v3/actions/${step.id}`, { signature });
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
}

function authHeaders(c: WalletCredentials): Record<string, string> {
  return { authorization: `SIWE ${c.token}` };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
