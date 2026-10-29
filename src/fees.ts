// Fees (/v3/fees), preview: trading fees on trade plans accrue as debt per wallet and venue, paid in one settlement.
// Polymarket settles with one gasless signature; Predict.fun with one transfer the wallet sends (it pays BNB gas).

import {
  SafetyCheckError,
  WaitTimeoutError,
  lowerAddress,
  onChain,
  retryTransient,
  sameHex,
  signWith,
  sleep,
  typedDoc,
  uintValue,
  type CallOptions,
  type Eip1193Request,
} from "./common.ts";
import { PUSD_LOWER } from "./signing/polymarket-contracts.generated.ts";
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

// The collateral each venue settles in, and the chain it is paid on.
const RAILS: Record<FeeVenue, { chainId: bigint; token: string }> = {
  polymarket: { chainId: 137n, token: PUSD_LOWER },
  predictfun: { chainId: 56n, token: "0x55d398326f99059ff775485246999027b3197955" },
};

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
      checkSettlement(settlement, venue, lowerAddress(wallet, "wallet"));
      const paid = await this.runWalletRequest(settlement.walletRequest, this.ctx.signal(opts));
      settlement = await this.answerSettlement(settlement.id, { wallet, ...paid }, opts);
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
    const interval = opts.pollIntervalMs ?? this.ctx.pollIntervalMs;
    const deadline = Date.now() + (opts.timeoutMs ?? this.ctx.timeoutMs);
    const read = () => retryTransient(() => this.getSettlement(id, wallet, { signal }), deadline, interval, signal);
    let settlement = last ?? (await read());
    while (!TERMINAL.has(settlement.status)) {
      // An unsigned settlement does not move on its own.
      if (settlement.status === "awaiting_signature") return settlement;
      if (Date.now() >= deadline) throw new WaitTimeoutError(`fee settlement ${id} is still ${settlement.status}`, settlement);
      await sleep(interval, signal);
      settlement = await read();
    }
    return settlement;
  }

  private runWalletRequest(req: FeeWalletRequest, signal?: AbortSignal): Promise<{ signature: string } | { transactionHash: string }> {
    return onChain(
      this.ctx.provider,
      req.chainId,
      async () => {
        if (req.kind === "signature") return { signature: await signWith(this.ctx.provider, req.request) };
        const hash = await this.ctx.provider.request(req.request);
        if (typeof hash !== "string") throw new Error("wallet returned a non-string transaction hash");
        return { transactionHash: hash };
      },
      signal,
    );
  }
}

/** Refuse a settlement whose wallet request is anything but one transfer of the owed amount to the treasury. */
function checkSettlement(s: FeeSettlement, venue: FeeVenue, wallet: string): void {
  const refuse = (why: string): never => {
    throw new SafetyCheckError(`refusing to pay fee settlement ${s.id}: ${why}`, s);
  };
  const rail = RAILS[venue];
  const req = s.walletRequest!;
  if (s.venue !== venue) refuse(`it is for ${s.venue}`);
  if (!sameHex(s.token, rail.token) || uintValue(s.chainId) !== rail.chainId) refuse("it pays in another asset");
  if (uintValue(req.chainId) !== rail.chainId) refuse("it signs on another chain");
  if (uintValue(s.amountRaw) === undefined || uintValue(s.amountRaw) === 0n) refuse("its amount is not a positive integer");
  const transfer = transferData(s.treasury, s.amountRaw);
  if (venue === "polymarket") {
    const doc = typedDoc(req.request);
    if (req.kind !== "signature" || !doc || !sameHex(req.request.params[0], wallet)) refuse("it is not a signature by this wallet");
    const calls = doc!.message?.calls as { target?: unknown; value?: unknown; data?: unknown }[] | undefined;
    const ok =
      doc!.primaryType === "Batch" &&
      doc!.domain?.name === "DepositWallet" &&
      uintValue(doc!.domain?.chainId) === rail.chainId &&
      sameHex(doc!.domain?.verifyingContract, s.holdingWallet) &&
      sameHex(doc!.message?.wallet, s.holdingWallet) &&
      Array.isArray(calls) &&
      calls.length === 1 &&
      sameHex(calls[0].target, rail.token) &&
      uintValue(calls[0].value) === 0n &&
      sameHex(calls[0].data, transfer);
    if (!ok) refuse("the batch is not a single transfer of the owed amount to the treasury");
  } else {
    const tx = req.request.params[0] as Record<string, unknown> | undefined;
    const ok =
      req.kind === "transaction" &&
      req.request.method === "eth_sendTransaction" &&
      req.request.params.length === 1 &&
      !!tx &&
      sameHex(tx.from, wallet) &&
      sameHex(s.holdingWallet, wallet) &&
      sameHex(tx.to, rail.token) &&
      (tx.value === undefined || uintValue(tx.value) === 0n) &&
      (tx.chainId === undefined || uintValue(tx.chainId) === rail.chainId) &&
      sameHex(tx.data, transfer);
    if (!ok) refuse("the transaction is not a single transfer of the owed amount to the treasury");
  }
}

/** ERC-20 `transfer(to, amount)` calldata. */
function transferData(to: string, amountRaw: string): string {
  const amount = uintValue(amountRaw) ?? 0n;
  return "0xa9059cbb" + to.toLowerCase().replace(/^0x/, "").padStart(64, "0") + amount.toString(16).padStart(64, "0");
}
