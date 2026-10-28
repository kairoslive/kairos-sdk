// On-chain intents (/v3/onchain-intents), preview: split, merge or redeem a Polymarket position from the wallet's
// deposit wallet. Kairos builds the calls, the wallet signs twice (no gas), Kairos submits and verifies the finalized result.

import {
  SafetyCheckError,
  WaitTimeoutError,
  canonicalRaw,
  idempotencyKey,
  lowerAddress,
  marketRef,
  rfc3339,
  secondsFromNow,
  signWith,
  sleep,
  switchChain,
  type CallOptions,
  type Eip1193Request,
  type MarketRef,
} from "./common.ts";
import type { WalletContext } from "./wallets.ts";

export type OnchainOperation = "split" | "merge" | "redeem";

/** `confirmed` is the only final state; `reverted` is reserved. */
export type OnchainIntentStatus = "needs_signatures" | "awaiting_client" | "ready" | "reconciling" | "confirmed" | "reverted";

export type OnchainToken = { kind: "erc20"; contract: string } | { kind: "erc1155"; contract: string; tokenId: string };

/** An exact token movement on the deposit wallet. */
export interface OnchainEffect {
  token: OnchainToken;
  direction: "debit" | "credit";
  amountRaw: string;
}

export interface OnchainCall {
  target: string;
  value: string;
  data: string;
}

/** The signed, immutable terms. */
export interface OnchainIntentTerms {
  contractVersion: 1;
  id: string;
  partnerId: string;
  audience: string;
  /** Opaque signed identifier. */
  executionRegion: string;
  signer: string;
  account: string;
  chainId: "137";
  market: string;
  operation: OnchainOperation;
  submissionOwner: "kairos" | "client";
  /** Pinned in the signed terms; do not substitute it. */
  submissionEndpoint: string;
  batch: { factory: string; nonce: string; deadline: string; calls: OnchainCall[] };
  effects: OnchainEffect[];
  dependencies: { intentId: string; intentHash: string; account: string; chainId: string; effects: OnchainEffect[] }[];
  maxWalletGasCostRaw: "0";
  createdAt: string;
  executeBefore: string;
}

export interface OnchainIntentView {
  intent: {
    terms: OnchainIntentTerms;
    intentHash: string;
    status: OnchainIntentStatus;
    committed: boolean;
    dispatchClaimed: boolean;
    transactionHash: string | null;
    /** Set once confirmed from a finalized block. */
    proof: { transactionHash: string; blockHash: string; blockNumber: string; intentHash: string; effects: OnchainEffect[] } | null;
  };
  /** Kairos consent to the terms. */
  consentRequest: Eip1193Request;
  /** The deposit wallet's own batch authorization. */
  nativeRequest: Eip1193Request;
  /** Client submission only: add `signature` (the native signature) to `body` and POST it to `endpoint`. */
  submission: { endpoint: string; method: "POST"; kind: "deposit_wallet_batch"; body: Record<string, unknown> };
}

export interface OnchainIntentInput {
  /** The owner wallet that signs. */
  wallet: string;
  /** The wallet's Polymarket deposit wallet. Default: `tradingWallet` from `wallet.status`. */
  account?: string;
  /** A Polymarket binary market: `polymarket:0x…`, a bare condition id, or a market object. */
  market: MarketRef;
  operation: OnchainOperation;
  /** Base units (6 decimals): pUSD to split, pairs to merge, or outcome tokens to redeem. */
  amountRaw: string | bigint;
  /** Redeem only: the outcome index, 0 or 1. */
  outcome?: 0 | 1;
  /**
   * Who posts the signed batch. Default `kairos`. Never broadcast the batch from the wallet yourself: the wallet would pay
   * gas and Kairos would never confirm the intent.
   */
  submissionOwner?: "kairos" | "client";
  /** At most 5 minutes out, whole seconds. Default: now + 240 s. */
  executeBefore?: Date | number | string;
  /** Intents that must confirm first, e.g. a split before a merge. */
  dependencies?: string[];
}

export interface OnchainExecuteInput {
  intentHash: string;
  consentSignature: string;
  /** Kairos submission only. */
  nativeSignature?: string;
}

export interface OnchainWaitOptions extends CallOptions {
  /** Default: the client's `timeoutMs`. */
  timeoutMs?: number;
  /** Default: the client's `pollIntervalMs`. */
  pollIntervalMs?: number;
}

export interface OnchainRunOptions extends OnchainWaitOptions {
  account?: string;
  dependencies?: string[];
  executeBefore?: Date | number | string;
  /** Default: a random UUID. Reuse it to resume the same intent. */
  idempotencyKey?: string;
}

/**
 * Preview: staging only for now. Polymarket binary markets on Polygon; the wallet must be set up on Polymarket.
 * Requests carry the wallet's login token (partner id) or your API key, which must own the wallet.
 */
export class OnchainIntentsClient {
  private readonly ctx: WalletContext;

  constructor(ctx: WalletContext) {
    this.ctx = ctx;
  }

  /** Prepare an intent. Sign both requests soon after: it must execute before `executeBefore`. */
  async prepare(input: OnchainIntentInput, opts: { idempotencyKey?: string } & CallOptions = {}): Promise<OnchainIntentView> {
    const body = await this.prepareBody(input, opts);
    const key = opts.idempotencyKey ?? idempotencyKey();
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new Error("idempotencyKey must be 1–128 visible ASCII characters");
    return this.ctx.request<OnchainIntentView>(body.wallet, "POST", "/v3/onchain-intents", { body, headers: { "idempotency-key": key }, signal: opts.signal });
  }

  get(id: string, wallet: string, opts: CallOptions = {}): Promise<OnchainIntentView> {
    return this.ctx.request<OnchainIntentView>(lowerAddress(wallet, "wallet"), "GET", intentPath(id), { signal: opts.signal });
  }

  /** Commit with the signatures. Repeating it returns the current state. */
  execute(id: string, wallet: string, input: OnchainExecuteInput, opts: CallOptions = {}): Promise<OnchainIntentView> {
    return this.ctx.request<OnchainIntentView>(lowerAddress(wallet, "wallet"), "POST", `${intentPath(id)}/execute`, { body: input, signal: opts.signal });
  }

  /** Client submission only: the transaction hash you got. A hint; Kairos confirms from the chain. */
  report(id: string, wallet: string, input: { intentHash: string; transactionHash: string }, opts: CallOptions = {}): Promise<OnchainIntentView> {
    const body = { ...input, transactionHash: input.transactionHash.toLowerCase() };
    return this.ctx.request<OnchainIntentView>(lowerAddress(wallet, "wallet"), "POST", `${intentPath(id)}/reports`, { body, signal: opts.signal });
  }

  /** Read the intent until it is `confirmed` (or `reverted`). */
  async wait(id: string, wallet: string, opts: OnchainWaitOptions = {}, last?: OnchainIntentView): Promise<OnchainIntentView> {
    const signal = this.ctx.signal(opts);
    const deadline = Date.now() + (opts.timeoutMs ?? this.ctx.timeoutMs);
    let view = last ?? (await this.get(id, wallet, { signal }));
    while (view.intent.status !== "confirmed" && view.intent.status !== "reverted") {
      if (!view.intent.committed) return view;
      if (Date.now() >= deadline) throw new WaitTimeoutError(`on-chain intent ${id} is still ${view.intent.status}`, view);
      await sleep(opts.pollIntervalMs ?? this.ctx.pollIntervalMs, signal);
      view = await this.get(id, wallet, { signal });
    }
    return view;
  }

  /** Split `amountRaw` pUSD into that many of both outcome tokens. */
  split(wallet: string, market: MarketRef, amountRaw: string | bigint, opts: OnchainRunOptions = {}): Promise<OnchainIntentView> {
    return this.run({ wallet, market, operation: "split", amountRaw, ...pick(opts) }, opts);
  }

  /** Merge `amountRaw` of both outcome tokens back into pUSD. */
  merge(wallet: string, market: MarketRef, amountRaw: string | bigint, opts: OnchainRunOptions = {}): Promise<OnchainIntentView> {
    return this.run({ wallet, market, operation: "merge", amountRaw, ...pick(opts) }, opts);
  }

  /** Redeem `amountRaw` tokens of a winning `outcome` (0 or 1) of a resolved market for pUSD. */
  redeem(wallet: string, market: MarketRef, amountRaw: string | bigint, opts: OnchainRunOptions & { outcome: 0 | 1 }): Promise<OnchainIntentView> {
    return this.run({ wallet, market, operation: "redeem", outcome: opts.outcome, amountRaw, ...pick(opts) }, opts);
  }

  /** Prepare, check, sign both requests on Polygon, execute (Kairos submits) and wait until confirmed. */
  private async run(input: OnchainIntentInput, opts: OnchainRunOptions): Promise<OnchainIntentView> {
    const signal = this.ctx.signal(opts);
    const body = await this.prepareBody(input, { signal });
    let view = await this.prepare(body, { idempotencyKey: opts.idempotencyKey, signal });
    const id = view.intent.terms.id;
    if (view.intent.committed || view.intent.status === "confirmed") return this.wait(id, body.wallet, opts, view);
    checkPrepared(view, body);
    await switchChain(this.ctx.provider, "0x89");
    const consentSignature = await signWith(this.ctx.provider, view.consentRequest);
    const nativeSignature = await signWith(this.ctx.provider, view.nativeRequest);
    view = await this.execute(id, body.wallet, { intentHash: view.intent.intentHash, consentSignature, nativeSignature }, { signal });
    return this.wait(id, body.wallet, opts, view);
  }

  private async prepareBody(input: OnchainIntentInput, opts: CallOptions): Promise<PrepareBody> {
    const wallet = lowerAddress(input.wallet, "wallet");
    if ((input.operation === "redeem") !== (input.outcome !== undefined)) throw new Error("outcome is required for redeem and only for redeem");
    if (input.outcome !== undefined && input.outcome !== 0 && input.outcome !== 1) throw new Error("outcome must be 0 or 1");
    const market = marketRef(input.market);
    if (!/^(polymarket:)?0x[0-9a-fA-F]{64}$/i.test(market)) throw new Error("on-chain intents need a Polymarket market");
    let account = input.account;
    if (!account) {
      const status = await this.ctx.status(wallet, opts);
      account = status.venues?.polymarket?.tradingWallet ?? status.tradingWallet;
      if (!account) throw new Error("the wallet has no Polymarket deposit wallet yet; run wallet.setup first");
    }
    return {
      wallet,
      account: lowerAddress(account, "account"),
      market,
      operation: input.operation,
      amountRaw: canonicalRaw(input.amountRaw, "amountRaw", { positive: true }),
      ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
      submissionOwner: input.submissionOwner ?? "kairos",
      executeBefore: input.executeBefore !== undefined ? rfc3339(input.executeBefore) : secondsFromNow(240),
      dependencies: input.dependencies ?? [],
    };
  }
}

interface PrepareBody {
  wallet: string;
  account: string;
  market: string;
  operation: OnchainOperation;
  amountRaw: string;
  outcome?: 0 | 1;
  submissionOwner: "kairos" | "client";
  executeBefore: string;
  dependencies: string[];
}

function pick(opts: OnchainRunOptions): Partial<OnchainIntentInput> {
  return { account: opts.account, dependencies: opts.dependencies, executeBefore: opts.executeBefore };
}

/** Refuse an intent that is not what was asked for. Throws before anything is signed. */
function checkPrepared(view: OnchainIntentView, body: PrepareBody): void {
  const t = view.intent.terms;
  const refuse = (why: string): never => {
    throw new SafetyCheckError(`refusing to sign on-chain intent ${t.id}: ${why}`, view);
  };
  const lc = (s: unknown) => String(s ?? "").toLowerCase();
  if (lc(t.signer) !== body.wallet) refuse("it is for another wallet");
  if (lc(t.account) !== body.account) refuse("it uses another account");
  if (t.operation !== body.operation) refuse(`operation changed to ${t.operation}`);
  if (t.submissionOwner !== body.submissionOwner) refuse("submission owner changed");
  if (lc(t.market).replace(/^polymarket:/, "") !== lc(body.market).replace(/^polymarket:/, "")) refuse(`market changed to ${t.market}`);
  if (t.maxWalletGasCostRaw !== "0") refuse("the wallet would pay gas");
  const debits = t.effects.filter((e) => e.direction === "debit");
  if (!debits.length || debits.some((e) => e.amountRaw !== body.amountRaw)) refuse("it debits a different amount");
  for (const req of [view.consentRequest, view.nativeRequest]) {
    if (req.method !== "eth_signTypedData_v4" || lc(req.params[0]) !== body.wallet) refuse("a request is for another signer");
  }
  const native = typedDoc(view.nativeRequest);
  if (lc(native?.domain?.verifyingContract) !== body.account || lc(native?.message?.wallet) !== body.account) refuse("the batch is for another account");
  const consent = typedDoc(view.consentRequest);
  if (consent?.message?.intentHash !== view.intent.intentHash || consent?.message?.intentId !== t.id) refuse("the consent does not name this intent");
}

function typedDoc(request: Eip1193Request): { domain?: Record<string, unknown>; message?: Record<string, unknown> } | undefined {
  try {
    return typeof request.params[1] === "string" ? JSON.parse(request.params[1]) : (request.params[1] as never);
  } catch {
    return undefined;
  }
}

function intentPath(id: string): string {
  return `/v3/onchain-intents/${encodeURIComponent(id)}`;
}
