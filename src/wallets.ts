// Wallet API (/v3): Kairos sends what to sign, the wallet signs it, the SDK sends it back.
// No Kairos account, API key or login: the wallet's signature is the auth.

import { Http, type FetchLike } from "./http.ts";

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
  [key: string]: unknown;
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
  fetch?: FetchLike;
}

export class WalletClient {
  private readonly http: Http;
  private readonly provider: Eip1193Provider;
  private readonly onStep?: (step: Step) => void;
  private readonly pollIntervalMs: number;
  private readonly timeoutMs: number;

  constructor(opts: WalletClientOptions) {
    if (!opts.partnerId) throw new Error("partnerId is required");
    this.http = new Http({ baseUrl: opts.baseUrl, headers: { "x-kairos-partner-id": opts.partnerId }, fetch: opts.fetch });
    this.provider = opts.provider;
    this.onStep = opts.onStep;
    this.pollIntervalMs = opts.pollIntervalMs ?? 2000;
    this.timeoutMs = opts.timeoutMs ?? 10 * 60 * 1000;
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

  /** The wallet's orders; `open: true` for live orders only. */
  async orders(wallet: string, opts: { open?: boolean; limit?: number } = {}): Promise<WalletOrder[]> {
    const res = await this.http.get<{ orders: WalletOrder[] }>(`/v3/wallets/${wallet}/orders`, {
      open: opts.open ? "true" : undefined,
      limit: opts.limit,
    });
    return res.orders;
  }

  async positions(wallet: string): Promise<WalletPosition[]> {
    const res = await this.http.get<{ positions: WalletPosition[] }>(`/v3/wallets/${wallet}/positions`);
    return res.positions;
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
