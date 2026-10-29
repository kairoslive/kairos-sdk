// On-chain intents (/v3/onchain-intents), preview: split, merge or redeem a Polymarket position from the wallet's
// deposit wallet. Kairos builds the calls, the wallet signs twice (no gas), Kairos submits and verifies the finalized result.

import {
  SafetyCheckError,
  WaitTimeoutError,
  canonicalRaw,
  idempotencyKey,
  lowerAddress,
  marketRef,
  onChain,
  retryTransient,
  rfc3339,
  sameRequest,
  secondsFromNow,
  signWith,
  sleep,
  typedDataRequest,
  unixSeconds,
  valueHash,
  type CallOptions,
  type Eip1193Request,
  type MarketRef,
} from "./common.ts";
import { keccak256, toHex, utf8 } from "./signing/keccak.ts";
import {
  CONDITIONAL_TOKENS_LOWER,
  CTF_COLLATERAL_ADAPTER_LOWER,
  NEG_RISK_COLLATERAL_ADAPTER_LOWER,
  POSITION_MANAGER_LOWER,
  PUSD_LOWER,
  ROUTER_LOWER,
} from "./signing/polymarket-contracts.generated.ts";
import type { WalletContext } from "./wallets.ts";

export type OnchainOperation = "split" | "merge" | "redeem";

/** `confirmed` is the only final state; `reverted` is reserved: the server does not send it today. */
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
    const interval = opts.pollIntervalMs ?? this.ctx.pollIntervalMs;
    const deadline = Date.now() + (opts.timeoutMs ?? this.ctx.timeoutMs);
    const read = () => retryTransient(() => this.get(id, wallet, { signal }), deadline, interval, signal);
    let view = last ?? (await read());
    while (view.intent.status !== "confirmed" && view.intent.status !== "reverted") {
      if (!view.intent.committed) return view;
      if (Date.now() >= deadline) throw new WaitTimeoutError(`on-chain intent ${id} is still ${view.intent.status}`, view);
      await sleep(interval, signal);
      view = await read();
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
    const prepared = view;
    const [consentSignature, nativeSignature] = await onChain(
      this.ctx.provider,
      "0x89",
      async () => [await signWith(this.ctx.provider, prepared.consentRequest), await signWith(this.ctx.provider, prepared.nativeRequest)],
      signal,
    );
    // Execute is idempotent, so a reply lost in transit is safe to ask for again.
    const deadline = Math.min(Date.now() + (opts.timeoutMs ?? this.ctx.timeoutMs), Date.parse(prepared.intent.terms.executeBefore) + 60_000);
    const signed = { intentHash: prepared.intent.intentHash, consentSignature, nativeSignature };
    view = await retryTransient(() => this.execute(id, body.wallet, signed, { signal }), deadline, opts.pollIntervalMs ?? this.ctx.pollIntervalMs, signal);
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

const field = (name: string, type: string) => ({ name, type });

/** The Kairos consent the server asks the signer for, rebuilt from the terms. */
export function intentConsentRequest(t: OnchainIntentTerms, intentHash: string): Eip1193Request {
  return typedDataRequest(t.signer, {
    types: {
      EIP712Domain: [field("name", "string"), field("version", "string"), field("chainId", "uint256")],
      OnchainIntent: [
        field("signer", "address"),
        field("partnerId", "string"),
        field("audience", "string"),
        field("intentId", "string"),
        field("intentHash", "bytes32"),
        field("executeBefore", "uint256"),
      ],
    },
    domain: { name: "KairosOnchainIntent", version: "1", chainId: t.chainId },
    primaryType: "OnchainIntent",
    message: { signer: t.signer, partnerId: t.partnerId, audience: t.audience, intentId: t.id, intentHash, executeBefore: unixSeconds(t.executeBefore) },
  });
}

/** The deposit wallet's batch the server asks the signer for, rebuilt from the terms. */
export function intentNativeRequest(t: OnchainIntentTerms): Eip1193Request {
  return typedDataRequest(t.signer, {
    types: {
      EIP712Domain: [field("name", "string"), field("version", "string"), field("chainId", "uint256"), field("verifyingContract", "address")],
      Batch: [field("wallet", "address"), field("nonce", "uint256"), field("deadline", "uint256"), field("calls", "Call[]")],
      Call: [field("target", "address"), field("value", "uint256"), field("data", "bytes")],
    },
    domain: { name: "DepositWallet", version: "1", chainId: t.chainId, verifyingContract: t.account },
    primaryType: "Batch",
    message: {
      wallet: t.account,
      nonce: t.batch.nonce,
      deadline: unixSeconds(t.batch.deadline),
      calls: t.batch.calls.map((c) => ({ target: c.target, value: c.value, data: c.data })),
    },
  });
}

const selector = (signature: string) => toHex(keccak256(utf8(signature))).slice(0, 10);
const APPROVE = selector("approve(address,uint256)");
const APPROVE_ALL = selector("setApprovalForAll(address,bool)");
const OPERATIONS: Record<OnchainOperation, { target: string; selector: string; amountWord: number }[]> = {
  split: [
    { target: CTF_COLLATERAL_ADAPTER_LOWER, selector: selector("splitPosition(address,bytes32,bytes32,uint256[],uint256)"), amountWord: 4 },
    { target: NEG_RISK_COLLATERAL_ADAPTER_LOWER, selector: selector("splitPosition(address,bytes32,bytes32,uint256[],uint256)"), amountWord: 4 },
    { target: ROUTER_LOWER, selector: selector("split(bytes31,uint256)"), amountWord: 1 },
  ],
  merge: [
    { target: CTF_COLLATERAL_ADAPTER_LOWER, selector: selector("mergePositions(address,bytes32,bytes32,uint256[],uint256)"), amountWord: 4 },
    { target: NEG_RISK_COLLATERAL_ADAPTER_LOWER, selector: selector("mergePositions(address,bytes32,bytes32,uint256[],uint256)"), amountWord: 4 },
    { target: ROUTER_LOWER, selector: selector("merge(bytes31,uint256)"), amountWord: 1 },
  ],
  redeem: [{ target: ROUTER_LOWER, selector: selector("redeem(bytes31,uint256,uint256)"), amountWord: 2 }],
};

/** The 32-byte argument word `i` of calldata, as a bigint. */
function word(data: string, i: number): bigint | undefined {
  const hex = data.slice(10 + 64 * i, 74 + 64 * i);
  return hex.length === 64 ? BigInt("0x" + hex) : undefined;
}

/** The batch must be the server's own two calls: one approval of the operator, then the operation, for exactly the amount. */
function checkCalls(calls: OnchainCall[], body: PrepareBody): string | undefined {
  if (calls.length !== 2 || calls.some((c) => c.value !== "0" || !/^0x([0-9a-f]{2})+$/.test(c.data))) return "the batch is not an approval and one operation";
  const [approval, op] = calls.map((c) => ({ target: c.target.toLowerCase(), selector: c.data.slice(0, 10), data: c.data }));
  const amount = BigInt(body.amountRaw);
  const known = OPERATIONS[body.operation].find((o) => o.target === op.target && o.selector === op.selector);
  if (!known || word(op.data, known.amountWord) !== amount) return "the batch runs another operation";
  if (body.operation === "redeem" && word(op.data, 1) !== BigInt(body.outcome ?? -1)) return "the batch redeems another outcome";
  const operator = word(approval.data, 0);
  if (operator !== BigInt(op.target)) return "the batch approves another operator";
  const positions = op.target === ROUTER_LOWER ? POSITION_MANAGER_LOWER : CONDITIONAL_TOKENS_LOWER;
  const approvalOk =
    body.operation === "split"
      ? approval.target === PUSD_LOWER && approval.selector === APPROVE && word(approval.data, 1) === amount && approval.data.length === 138
      : approval.target === positions && approval.selector === APPROVE_ALL && word(approval.data, 1) === 1n && approval.data.length === 138;
  return approvalOk ? undefined : "the batch approves something else";
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
  if (t.chainId !== "137") refuse("it is for another chain");
  if (t.operation !== body.operation) refuse(`operation changed to ${t.operation}`);
  if (t.submissionOwner !== body.submissionOwner) refuse("submission owner changed");
  if (lc(t.market).replace(/^polymarket:/, "") !== lc(body.market).replace(/^polymarket:/, "")) refuse(`market changed to ${t.market}`);
  if (t.maxWalletGasCostRaw !== "0") refuse("the wallet would pay gas");
  if (Date.parse(t.executeBefore) > Date.parse(body.executeBefore) || Date.parse(t.batch.deadline) > Date.parse(body.executeBefore)) refuse("it runs later than requested");
  if (JSON.stringify(t.dependencies.map((d) => d.intentId)) !== JSON.stringify(body.dependencies)) refuse("its prerequisites differ");
  const debits = t.effects.filter((e) => e.direction === "debit");
  if (!debits.length || debits.some((e) => e.amountRaw !== body.amountRaw)) refuse("it debits a different amount");
  const calls = checkCalls(t.batch.calls, body);
  if (calls) refuse(calls);
  let hash: string | undefined;
  try {
    hash = valueHash(t);
  } catch {
    refuse("its terms are malformed");
  }
  if (hash !== view.intent.intentHash) refuse("its intentHash does not match the terms");
  if (!sameRequest(view.consentRequest, intentConsentRequest(t, hash!))) refuse("the consent does not name this intent");
  if (!sameRequest(view.nativeRequest, intentNativeRequest(t))) refuse("the batch differs from the terms");
}

function intentPath(id: string): string {
  return `/v3/onchain-intents/${encodeURIComponent(id)}`;
}
