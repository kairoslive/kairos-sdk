// Fees (/v3/fees), preview: trading fees on trade plans accrue as debt per wallet and venue, paid in one settlement.
// Polymarket settles with one gasless signature; Predict.fun with one transfer the wallet sends (it pays BNB gas).

import { signWith, sleep, switchChain, WaitTimeoutError, lowerAddress, type CallOptions, type Eip1193Request } from "./common.ts";
import type { WalletContext } from "./wallets.ts";

export { FeeSettlementRequiredError } from "./http.ts";

/** Venues with fee settlement. Hyperliquid has none. */
export type FeeVenue = "polymarket" | "predictfun";

export type FeeSettlementStatus = "awaiting_signature" | "submitted" | "confirmed" | "failed" | "expired";

/** What the wallet must do for a settlement: sign typed data (Polymarket) or send a transaction (Predict.fun). */
export interface FeeWalletRequest {
  kind: "signature" | "transaction";
  /** The chain to be on (EIP-155 hex). */
  chainId: string;
  request: Eip1193Request;
}

export interface FeeSettlement {
  id: string;
  venue: FeeVenue;
  status: FeeSettlementStatus;
  /** The address the fees are paid from: the Polymarket deposit wallet, or the wallet itself on Predict.fun. */
  holdingWallet: string;
  /** `evm:<chainId>:<token>`. */
  assetKey: string;
  /** Decimal chain id, e.g. `"137"`. `walletRequest.chainId` is hex. */
  chainId: string;
  token: string;
  /** Who is paid. */
  treasury: string;
  decimals: number;
  /** The debt frozen into this settlement, in base units. Fees after it was created stay owed. */
  amountRaw: string;
  transactionHash: string | null;
  /** Polymarket: sign before this (RFC 3339). Predict.fun: null, no deadline. */
  expiresAt: string | null;
  /** Why it failed or expired. */
  failure: string | null;
  /** Present only while `awaiting_signature`. */
  walletRequest: FeeWalletRequest | null;
}

export interface VenueFees {
  venue: FeeVenue;
  holdingWallet: string;
  assetKey: string;
  decimals: number;
  /** Fees owed in base units. Negative is a credit that covers later fees. */
  owedRaw: string;
  /** At or above this, new trade plans are refused until the wallet settles. */
  thresholdRaw: string;
  /** The open settlement, if any. */
  settlement: FeeSettlement | null;
}

export interface FeeSummary {
  /** Venues with settlement here; a venue without it is left out. */
  venues: VenueFees[];
}

export type FeeAnswer = { wallet: string; signature: string } | { wallet: string; transactionHash: string };

export interface SettleOptions extends CallOptions {
  /** Give up waiting for confirmation after this long. Default: the client's `timeoutMs`. */
  timeoutMs?: number;
  /** Delay between reads while the payment confirms. Default: the client's `pollIntervalMs`. */
  pollIntervalMs?: number;
}

const TERMINAL: ReadonlySet<FeeSettlementStatus> = new Set(["confirmed", "failed", "expired"]);

/**
 * Preview: staging only for now. Requests carry the wallet's login token (partner id) or your API key, which must own the
 * wallet and have `trade:read` for reads and `trade:execute` for writes.
 */
export class FeesClient {
  private readonly ctx: WalletContext;

  constructor(ctx: WalletContext) {
    this.ctx = ctx;
  }

  /** What the wallet owes on each venue, and any open settlement. Reading this also credits payments that landed late. */
  summary(wallet: string, opts: CallOptions = {}): Promise<FeeSummary> {
    const w = lowerAddress(wallet, "wallet");
    return this.ctx.request<FeeSummary>(w, "GET", "/v3/fees", { query: { wallet: w }, signal: opts.signal });
  }

  /** Freeze what the wallet owes on `venue` into a settlement, or return the one already open. 409 when nothing is owed. */
  createSettlement(wallet: string, venue: FeeVenue, opts: CallOptions = {}): Promise<FeeSettlement> {
    const w = lowerAddress(wallet, "wallet");
    return this.ctx.request<FeeSettlement>(w, "POST", "/v3/fees/settlements", { body: { wallet: w, venue }, signal: opts.signal });
  }

  /** Read a settlement. Reading is what moves it forward, so poll this until it is final. */
  getSettlement(id: string, wallet: string, opts: CallOptions = {}): Promise<FeeSettlement> {
    const w = lowerAddress(wallet, "wallet");
    return this.ctx.request<FeeSettlement>(w, "GET", `/v3/fees/settlements/${encodeURIComponent(id)}`, { query: { wallet: w }, signal: opts.signal });
  }

  /** Answer with the signature (Polymarket) or the hash of the transfer the wallet sent (Predict.fun). */
  answerSettlement(id: string, answer: FeeAnswer, opts: CallOptions = {}): Promise<FeeSettlement> {
    const w = lowerAddress(answer.wallet, "wallet");
    return this.ctx.request<FeeSettlement>(w, "POST", `/v3/fees/settlements/${encodeURIComponent(id)}/answer`, {
      body: { ...answer, wallet: w },
      signal: opts.signal,
    });
  }

  /**
   * Pay what the wallet owes on `venue`: create the settlement, have the wallet sign (Polymarket, no gas) or send the
   * transfer (Predict.fun, pays BNB gas), answer, and wait until it is `confirmed`, `failed` or `expired`.
   * Confirmation waits for a finalized block, so it can take minutes. Returns the final settlement; check `status`.
   */
  async settle(wallet: string, venue: FeeVenue, opts: SettleOptions = {}): Promise<FeeSettlement> {
    let settlement = await this.createSettlement(wallet, venue, opts);
    if (settlement.status === "awaiting_signature" && settlement.walletRequest) {
      settlement = await this.answerSettlement(settlement.id, { wallet, ...(await this.runWalletRequest(settlement.walletRequest)) }, opts);
    }
    return this.wait(settlement.id, wallet, opts, settlement);
  }

  /**
   * Settle every venue where the wallet owes anything (`owedRaw > 0`), one after another, not only those over the
   * threshold: paying early is harmless and keeps the next plan from being refused. Returns the final settlements.
   */
  async settleAll(wallet: string, opts: SettleOptions = {}): Promise<FeeSettlement[]> {
    const { venues } = await this.summary(wallet, opts);
    const settled: FeeSettlement[] = [];
    for (const v of venues) {
      if (BigInt(v.owedRaw) > 0n || v.settlement) settled.push(await this.settle(wallet, v.venue, opts));
    }
    return settled;
  }

  /** Read a settlement until it is final. */
  async wait(id: string, wallet: string, opts: SettleOptions = {}, last?: FeeSettlement): Promise<FeeSettlement> {
    const signal = this.ctx.signal(opts);
    const deadline = Date.now() + (opts.timeoutMs ?? this.ctx.timeoutMs);
    let settlement = last ?? (await this.getSettlement(id, wallet, { signal }));
    while (!TERMINAL.has(settlement.status)) {
      // An unsigned settlement does not move on its own.
      if (settlement.status === "awaiting_signature") return settlement;
      if (Date.now() >= deadline) throw new WaitTimeoutError(`fee settlement ${id} is still ${settlement.status}`, settlement);
      await sleep(opts.pollIntervalMs ?? this.ctx.pollIntervalMs, signal);
      settlement = await this.getSettlement(id, wallet, { signal });
    }
    return settlement;
  }

  private async runWalletRequest(req: FeeWalletRequest): Promise<{ signature: string } | { transactionHash: string }> {
    await switchChain(this.ctx.provider, req.chainId);
    if (req.kind === "signature") return { signature: await signWith(this.ctx.provider, req.request) };
    const hash = await this.ctx.provider.request(req.request);
    if (typeof hash !== "string") throw new Error("wallet returned a non-string transaction hash");
    return { transactionHash: hash };
  }
}
