// Wallet API (/v3): Kairos sends what to sign, the wallet signs it, the SDK sends it back.
// Actions need only the wallet's signature; reading orders and positions needs a SIWE login (`login`).

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

/** The API key that unlocks a wallet's orders and positions. Treat it as a secret. */
export interface WalletCredentials {
  clientId: string;
  apiKey: string;
  apiSecret: string;
  /** ISO time after which the key stops working. */
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
  /** Called after each login with the new key, e.g. to keep it in secure storage and pass it back via `useCredentials`. */
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
   * Sign in with Ethereum (one `personal_sign`) and keep the wallet's API key for `orders` and `positions`.
   * The wallet must be set up first. A new login replaces the wallet's previous key.
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
    const { message } = await this.http.post<{ message: string }>("/v2/auth/siwe/challenge", { address: wallet });
    const signature = await this.provider.request({ method: "personal_sign", params: [utf8ToHex(message), wallet] });
    if (typeof signature !== "string") throw new Error("wallet returned a non-string signature");
    const key = await this.http.post<{ client_id: string; api_key: string; api_secret: string; expires_at: string }>(
      "/v2/auth/siwe/verify",
      { message, signature_hex: signature },
    );
    const credentials = { clientId: key.client_id, apiKey: key.api_key, apiSecret: key.api_secret, expiresAt: key.expires_at };
    this.useCredentials(wallet, credentials);
    this.onLogin?.(wallet, credentials);
    return credentials;
  }

  /** Reuse a key from an earlier `login` (e.g. restored from secure storage). */
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
      // A key replaced by a login elsewhere answers 401: log in once more.
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
  return { "x-client-id": c.clientId, "x-api-key": c.apiKey, "x-api-secret": c.apiSecret };
}

function utf8ToHex(text: string): string {
  let hex = "0x";
  for (const byte of new TextEncoder().encode(text)) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
