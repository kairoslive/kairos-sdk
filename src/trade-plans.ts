// Trade plans (/v3/trade-plans), preview: one buy, signed up front in one batch with a fee ceiling and deadlines.
// When the venue account is short, a plan can first bridge exactly the shortfall from the wallet's USDC on Polygon or Arbitrum.

import {
  SafetyCheckError,
  WaitTimeoutError,
  canonicalDecimal,
  canonicalRaw,
  idempotencyKey,
  lowerAddress,
  marketRef,
  onChain,
  randomClientOrderId,
  requestHash,
  retryTransient,
  rfc3339,
  sameHex,
  sameRequest,
  secondsFromNow,
  signWith,
  sleep,
  typedDataRequest,
  typedDoc,
  uintValue,
  unixSeconds,
  valueHash,
  type CallOptions,
  type Eip1193Request,
  type MarketRef,
  type TypedDoc,
} from "./common.ts";
import type { TimeInForce, Venue, WalletContext } from "./wallets.ts";
import {
  CTF_EXCHANGE_V1_LOWER,
  CTF_EXCHANGE_V2_LOWER,
  NEG_RISK_CTF_EXCHANGE_V1_LOWER,
  NEG_RISK_CTF_EXCHANGE_V2_LOWER,
} from "./signing/polymarket-contracts.generated.ts";

/** `needs_wallet_action` and `refunded` are reserved: the server does not send them today. */
export type TradePlanStatus =
  | "needs_signatures"
  | "ready_to_execute"
  | "needs_wallet_action"
  | "funding_pending"
  | "trade_pending"
  | "reconciling"
  | "completed"
  | "expired"
  | "failed"
  | "funded_trade_failed"
  | "funded_trade_expired"
  | "refunded";

/** The order as the plan will place it. Prices 0–1 and sizes in shares, as canonical decimal strings. */
export interface TradePlanOrder {
  /** `venue:market_id`. */
  market: string;
  outcome: string;
  side: "buy";
  price: string;
  size: string;
  timeInForce: TimeInForce;
  postOnly: boolean;
  clientOrderId: string;
  /** RFC 3339; GTD only. */
  expiresAt?: string;
}

/** Bridge the shortfall from this source. Raw amounts are integer strings in the source token's base units. */
export interface TradePlanFundingInput {
  /** Decimal chain id: `"137"` (Polygon) or `"42161"` (Arbitrum). */
  sourceChainId: string;
  /** That chain's native USDC. */
  sourceToken: string;
  /** The most the source may be debited, bridge fees included. */
  maxAmountRaw: string;
  /** Default `"0"`: funding is gasless. */
  maxGasCostRaw?: string;
  /** 0–10000. */
  slippageBps: number;
}

export interface TradePlanInput {
  /** The wallet that signs and owns the plan. */
  wallet: string;
  order: {
    market: MarketRef;
    outcome: string;
    /** Plans are buy-only. */
    side?: "buy";
    /** 0–1, canonical: `"0.5"`, not `"0.50"`. */
    price: string | number;
    /** Shares, canonical, matching the venue's share lot. */
    size: string | number;
    /** Default `GTC`. Hyperliquid takes `GTC`, `FAK` or `IOC`. */
    timeInForce?: TimeInForce;
    /** GTC or GTD only. Default false. */
    postOnly?: boolean;
    /** Default: a random `0x` + 32 hex id. Unique per wallet and venue. */
    clientOrderId?: string;
    /** GTD only: a `Date`, unix seconds, or RFC 3339 with whole seconds. Must be after `tradeSubmitBefore`. */
    expiresAt?: Date | number | string;
  };
  /** Omit when the collateral is already at the venue. */
  funding?: TradePlanFundingInput | null;
  /** Who submits the funding permits. The SDK's `run` supports only `"kairos"` (the default). */
  submission?: { funding?: "kairos" | "client"; trade?: "kairos" };
  /** Default `single_batch`. */
  interactionMode?: "single_batch" | "allow_followup";
  /** The last moment Kairos may place the trade: at most 5 minutes out. Default: now + 240 s. */
  tradeSubmitBefore?: Date | number | string;
  /** Confirmed merge or redeem intents whose pUSD credit this buy may count on (a split spends pUSD, so it cannot). Polymarket only. */
  ctfDependencies?: string[];
}

export type Collateral =
  | { kind: "evm"; chainId: string; token: string }
  | { kind: "hypercore"; environment: "mainnet" | "testnet"; ledger: "spot"; token: "USDC" };

export type FeeShape =
  | { model: "flat"; bps: number }
  | { model: "curve"; points: { price: string; feeBps: number }[] }
  | { model: "parabolic"; edgeBps: number; centerBps: number };

/** Your fee on this plan, as signed by the wallet. */
export interface PartnerFeeTerms {
  scheduleId: string;
  /** The highest rate either shape reaches. */
  maxBps: number;
  maker: FeeShape;
  taker: FeeShape;
}

/** The most the plan can spend, in collateral base units. */
export interface TradeBudget {
  collateral: Collateral;
  decimals: number;
  notionalRaw: string;
  /** Platform fee bound plus the venue fee bound. */
  maxCollateralFeeRaw: string;
  /** Kairos and partner fee ceiling together, at most 1000 (10%). */
  maxPlatformFeeBps: number;
  /** `notionalRaw + maxCollateralFeeRaw`: the most the wallet authorizes. */
  maxDebitRaw: string;
  /** What the venue account could already spend when the plan was prepared. */
  existingSpendableRaw: string;
  partnerFee?: PartnerFeeTerms;
}

export interface FundingPlan {
  sourceChainId: string;
  sourceToken: string;
  sourceDecimals: number;
  quoteId: string;
  providerRequestId: string;
  /** What the source is debited, fees included. */
  amountInRaw: string;
  maxGasCostRaw: string;
  destination: Collateral;
  destinationDecimals: number;
  /** Equals the plan's `tradingWallet`. */
  recipient: string;
  /** Where a failed bridge refunds: the wallet. */
  refundRecipient: string;
  requiredArrivalRaw: string;
  minimumArrivalRaw: string;
  expectedArrivalRaw: string;
  quoteExpiresAt: string;
  fundingSubmitBefore: string;
  maxAmountRaw: string;
  slippageBps: number;
}

/** One thing the wallet signs. Sign `request` on `chainId` and answer with `requestId: id`. */
export interface TradePlanWalletRequest {
  /** `plan`, `trade`, `funding-1` or `funding-2`. */
  id: string;
  purpose: "plan" | "trade" | "funding";
  kind: "signature" | "transaction";
  signer: string;
  chainId: string | null;
  request: Eip1193Request;
  requestHash: string;
  collectAfter: string[];
  executeAfter: string[];
  /** Client-owned funding only: where you post the signed permit yourself. */
  externalSubmission?: { endpoint: string; method: "POST"; kind: string; requestId: string; api: string };
  status: "ready" | "accepted" | "confirmed" | "blocked" | "submitted" | "unknown" | "failed";
  /** True when it can be signed now. */
  actionable: boolean;
}

export interface TradePlanExecution {
  committed: boolean;
  phase: "collecting" | "funding" | "trade" | "finished";
  fundingStatus: "not_required" | "not_started" | "pending" | "awaiting_client" | "unknown" | "confirmed" | "failed" | "refunded";
  tradeStatus: "not_started" | "unknown" | "accepted" | "failed" | "expired" | (string & {});
  movementId?: string;
  /** The Kairos order id once placed. */
  orderId?: string;
  venueOrderId?: string;
  venueOrderStatus?: string;
  confirmedArrivalRaw?: string;
  refundedAmountRaw?: string;
}

export interface TradePlanError {
  /** `OUTCOME_UNKNOWN` (in flight), `PLAN_EXPIRED`, `TRADE_EXPIRED`, `FUNDING_SHORTFALL`, `COLLATERAL_CHANGED`, `VENUE_REJECTED`, `PREFLIGHT_REFUSED`, `NATIVE_NOT_DISPATCHED`. */
  code: string;
  message: string;
  stepId?: string;
  /** `reconcile` (keep reading) or `inspect_funds` (it ended; check where the collateral is). */
  nextAction: string;
}

export interface CtfDependency {
  intent: { intentId: string; intentHash: string; account: string; chainId: string; effects: unknown[] };
  anticipatedCreditRaw: string;
}

export interface TradePlan {
  contractVersion: 1;
  id: string;
  planHash: string;
  /** Grows by one on every change. */
  revision: string;
  wallet: string;
  ctfDependencies?: CtfDependency[];
  partnerId: string;
  /** The deployment the plan is bound to. */
  audience: string;
  interactionMode: "single_batch" | "allow_followup";
  submission: { funding: "kairos" | "client"; trade: "kairos" };
  status: TradePlanStatus;
  venue: Venue;
  /** Opaque signed identifier. */
  tradeExecutionRegion: string;
  /** The order as it will be placed; check it before signing (`run` does). */
  order: TradePlanOrder;
  /** Where the collateral must be. */
  tradingWallet: string;
  tradePayloadDigest: string;
  tradeBudget: TradeBudget;
  funding: FundingPlan | null;
  createdAt: string;
  /** Answer and execute before this. */
  executeBefore: string;
  tradeSubmitBefore: string;
  requests: TradePlanWalletRequest[];
  execution: TradePlanExecution;
  error: TradePlanError | null;
}

export type TradePlanAnswer = { kind: "signature"; requestId: string; signature: string };

/** Client-owned funding: tells Kairos a permit was posted. A hint only; it cannot confirm funding. */
export interface TradePlanReport {
  requestId: string;
  requestHash: string;
  providerRequestId: string;
}

export interface TradePlanWaitOptions extends CallOptions {
  /** Default: the client's `timeoutMs`. */
  timeoutMs?: number;
  /** Default: the client's `pollIntervalMs`. */
  pollIntervalMs?: number;
}

export interface RunTradePlanOptions extends TradePlanWaitOptions {
  /** Default: a random UUID. Reuse it to resume the same plan after a crash. */
  idempotencyKey?: string;
  /** Refuse to sign when the plan could debit more collateral than this (base units). */
  maxDebitRaw?: string | bigint;
  /** Called before each signature, e.g. to explain it in your UI. */
  onSign?: (request: TradePlanWalletRequest, plan: TradePlan) => void;
}

const TERMINAL: ReadonlySet<TradePlanStatus> = new Set(["completed", "expired", "failed", "funded_trade_failed", "funded_trade_expired", "refunded"]);

/** True when the plan will not change again. */
export function isTradePlanFinal(plan: Pick<TradePlan, "status">): boolean {
  return TERMINAL.has(plan.status);
}

/**
 * Preview: staging only for now. The wallet must be set up on the venue first (`wallet.setup`).
 * Requests carry the wallet's login token (partner id) or your API key, which must own the wallet.
 */
export class TradePlansClient {
  private readonly ctx: WalletContext;

  constructor(ctx: WalletContext) {
    this.ctx = ctx;
  }

  /** Prepare a plan for the wallet to sign. The same `idempotencyKey` and input return the same plan. */
  async prepare(input: TradePlanInput, opts: { idempotencyKey?: string } & CallOptions = {}): Promise<TradePlan> {
    return this.send(prepareBody(input), opts.idempotencyKey ?? idempotencyKey(), opts);
  }

  get(id: string, wallet: string, opts: CallOptions = {}): Promise<TradePlan> {
    return this.ctx.request<TradePlan>(lowerAddress(wallet, "wallet"), "GET", planPath(id), { signal: opts.signal });
  }

  /** Send signatures; they can come in several batches. `wallet` picks the login token. */
  answer(id: string, wallet: string, planHash: string, answers: TradePlanAnswer[], opts: CallOptions = {}): Promise<TradePlan> {
    return this.post(id, wallet, "answers", { planHash, answers }, opts);
  }

  /** Commit the plan, with any signatures not sent yet. Kairos then funds (if needed) and places the trade. */
  execute(id: string, wallet: string, planHash: string, answers: TradePlanAnswer[] = [], opts: CallOptions = {}): Promise<TradePlan> {
    return this.post(id, wallet, "execute", { planHash, answers }, opts);
  }

  /** Client-owned funding only: report the permits you posted yourself. */
  report(id: string, wallet: string, planHash: string, reports: TradePlanReport[], opts: CallOptions = {}): Promise<TradePlan> {
    return this.post(id, wallet, "reports", { planHash, reports }, opts);
  }

  /** Read the plan until it is final. `completed` means the venue accepted the order, not that it filled. */
  async wait(id: string, wallet: string, opts: TradePlanWaitOptions = {}, last?: TradePlan): Promise<TradePlan> {
    const signal = this.ctx.signal(opts);
    const interval = opts.pollIntervalMs ?? this.ctx.pollIntervalMs;
    const deadline = Date.now() + (opts.timeoutMs ?? this.ctx.timeoutMs);
    const read = () => retryTransient(() => this.get(id, wallet, { signal }), deadline, interval, signal);
    let plan = last ?? (await read());
    while (!TERMINAL.has(plan.status)) {
      // Unsigned or uncommitted plans do not move on their own.
      if (!plan.execution.committed && plan.status !== "needs_wallet_action") {
        if (Date.parse(plan.executeBefore) > Date.now()) return plan;
      }
      if (Date.now() >= deadline) throw new WaitTimeoutError(`trade plan ${id} is still ${plan.status}; read it, never repeat the order`, plan);
      await sleep(interval, signal);
      plan = await read();
    }
    return plan;
  }

  /**
   * Prepare, check, sign, execute and wait. Before anything is signed it refuses (with `SafetyCheckError`) a plan whose
   * wallet, order, funding, deadlines or budget differ from the request, beyond what the server may rewrite: the outcome's
   * canonical name (on Hyperliquid, its coin), and Predict.fun GTC becoming GTD bounded by the venue session.
   * Client-owned funding is refused; use `prepare`/`answer`/`report` for it. Returns the final plan: check `status`.
   */
  async run(input: TradePlanInput, opts: RunTradePlanOptions = {}): Promise<TradePlan> {
    if ((input.submission?.funding ?? "kairos") !== "kairos") {
      throw new Error("run supports Kairos-submitted funding only; sign and post client-owned permits yourself");
    }
    const signal = this.ctx.signal(opts);
    const body = prepareBody(input);
    let plan = await this.send(body, opts.idempotencyKey ?? idempotencyKey(), { signal });
    if (TERMINAL.has(plan.status)) return plan;
    if (plan.execution.committed) return this.wait(plan.id, body.wallet, opts, plan);
    checkPrepared(plan, body, opts);

    const answers: TradePlanAnswer[] = [];
    for (const req of plan.requests) {
      if (!req.actionable || req.status !== "ready") continue;
      if (req.kind !== "signature") throw new SafetyCheckError(`plan request ${req.id} asks for a ${req.kind}`, plan);
      opts.onSign?.(req, plan);
      const signature = await onChain(this.ctx.provider, req.chainId, () => signWith(this.ctx.provider, req.request), signal);
      answers.push({ kind: "signature", requestId: req.id, signature });
    }
    // Execute is idempotent, so a reply lost in transit is safe to ask for again.
    const deadline = Math.min(Date.now() + (opts.timeoutMs ?? this.ctx.timeoutMs), Date.parse(plan.executeBefore) + 60_000);
    const id = plan.id;
    const planHash = plan.planHash;
    plan = await retryTransient(() => this.execute(id, body.wallet, planHash, answers, { signal }), deadline, opts.pollIntervalMs ?? this.ctx.pollIntervalMs, signal);
    return this.wait(plan.id, body.wallet, opts, plan);
  }

  private send(body: PrepareBody, key: string, opts: CallOptions): Promise<TradePlan> {
    if (!/^[\x21-\x7e]{1,128}$/.test(key)) throw new Error("idempotencyKey must be 1–128 visible ASCII characters");
    return this.ctx.request<TradePlan>(body.wallet, "POST", "/v3/trade-plans", { body, headers: { "idempotency-key": key }, signal: opts.signal });
  }

  private post(id: string, wallet: string, op: string, body: unknown, opts: CallOptions): Promise<TradePlan> {
    return this.ctx.request<TradePlan>(lowerAddress(wallet, "wallet"), "POST", `${planPath(id)}/${op}`, { body, signal: opts.signal });
  }
}

interface PrepareBody {
  wallet: string;
  interactionMode: "single_batch" | "allow_followup";
  submission: { funding: "kairos" | "client"; trade: "kairos" };
  order: TradePlanOrder;
  funding: Required<TradePlanFundingInput> | null;
  tradeSubmitBefore: string;
  ctfDependencies?: string[];
}

/** The wire body, with the server's value rules checked here so mistakes fail before a round trip. */
function prepareBody(input: TradePlanInput): PrepareBody {
  const o = input.order;
  if ((o.side ?? "buy") !== "buy") throw new Error("trade plans accept buys only");
  const price = canonicalDecimal(o.price, "price");
  if (!price.startsWith("0.")) throw new Error("price must be between 0 and 1");
  const timeInForce = o.timeInForce ?? "GTC";
  const postOnly = o.postOnly ?? false;
  if (postOnly && timeInForce !== "GTC" && timeInForce !== "GTD") throw new Error("postOnly needs timeInForce GTC or GTD");
  if ((timeInForce === "GTD") !== (o.expiresAt !== undefined)) throw new Error("expiresAt is required with GTD and only with GTD");
  const clientOrderId = o.clientOrderId ?? randomClientOrderId();
  if (!/^[\x21-\x7e]{1,128}$/.test(clientOrderId)) throw new Error("clientOrderId must be 1–128 visible ASCII characters");
  const order: TradePlanOrder = {
    market: marketRef(o.market),
    outcome: o.outcome,
    side: "buy",
    price,
    size: canonicalDecimal(o.size, "size"),
    timeInForce,
    postOnly,
    clientOrderId,
    ...(o.expiresAt !== undefined ? { expiresAt: rfc3339(o.expiresAt) } : {}),
  };
  const f = input.funding;
  const funding = f
    ? {
        sourceChainId: canonicalRaw(f.sourceChainId, "funding.sourceChainId", { positive: true }),
        sourceToken: lowerAddress(f.sourceToken, "funding.sourceToken"),
        maxAmountRaw: canonicalRaw(f.maxAmountRaw, "funding.maxAmountRaw", { positive: true }),
        maxGasCostRaw: canonicalRaw(f.maxGasCostRaw ?? "0", "funding.maxGasCostRaw"),
        slippageBps: checkBps(f.slippageBps),
      }
    : null;
  return {
    wallet: lowerAddress(input.wallet, "wallet"),
    interactionMode: input.interactionMode ?? "single_batch",
    submission: { funding: input.submission?.funding ?? "kairos", trade: "kairos" },
    order,
    funding,
    tradeSubmitBefore: input.tradeSubmitBefore !== undefined ? rfc3339(input.tradeSubmitBefore) : secondsFromNow(240),
    ...(input.ctfDependencies?.length ? { ctfDependencies: input.ctfDependencies } : {}),
  };
}

function checkBps(bps: number): number {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error("funding.slippageBps must be an integer 0–10000");
  return bps;
}

/** The plan hash the server signs over: the plan without its live fields, requests reduced to their pinned parts. */
export function tradePlanHash(plan: TradePlan): string {
  const { planHash: _h, revision: _r, status: _s, execution: _e, error: _x, requests, ...pinned } = plan;
  const reqs = requests
    .filter((r) => r.purpose !== "plan")
    .map((r) => ({
      id: r.id,
      purpose: r.purpose,
      kind: r.kind,
      signer: r.signer,
      chainId: r.chainId ?? null,
      requestHash: r.requestHash,
      collectAfter: r.collectAfter,
      executeAfter: r.executeAfter,
      ...(r.externalSubmission ? { externalSubmission: r.externalSubmission } : {}),
    }));
  return valueHash({ ...pinned, requests: reqs });
}

/** The plan authorization the server asks the wallet to sign, rebuilt from the plan. */
export function tradePlanAuthorization(plan: TradePlan, chainId: bigint): Eip1193Request {
  const field = (name: string, type: string) => ({ name, type });
  return typedDataRequest(plan.wallet, {
    domain: { name: "KairosTradePlan", version: "1", chainId: Number(chainId) },
    primaryType: "TradePlan",
    types: {
      EIP712Domain: [field("name", "string"), field("version", "string"), field("chainId", "uint256")],
      TradePlan: [
        field("wallet", "address"),
        field("partnerId", "string"),
        field("audience", "string"),
        field("planId", "string"),
        field("planHash", "bytes32"),
        field("executeBefore", "uint256"),
        field("tradeSubmitBefore", "uint256"),
      ],
    },
    message: {
      wallet: plan.wallet,
      partnerId: plan.partnerId,
      audience: plan.audience,
      planId: plan.id,
      planHash: plan.planHash,
      executeBefore: unixSeconds(plan.executeBefore),
      tradeSubmitBefore: unixSeconds(plan.tradeSubmitBefore),
    },
  });
}

const VENUE_CHAINS: Record<Venue, readonly bigint[]> = { polymarket: [137n], predictfun: [56n], hyperliquid: [42161n, 421614n] };
const POLYMARKET_EXCHANGES = [CTF_EXCHANGE_V2_LOWER, NEG_RISK_CTF_EXCHANGE_V2_LOWER, CTF_EXCHANGE_V1_LOWER, NEG_RISK_CTF_EXCHANGE_V1_LOWER];
const SHARE_DECIMALS: Partial<Record<Venue, number>> = { polymarket: 6, predictfun: 18 };
// Relay's approval proxy, the only contract a funding permit may pay.
const RELAY_APPROVAL_PROXY = "0x5567954cd026cebfe486062cb75848e0f1c12e58";

/** `value` (a canonical decimal) in base units, rounded up. */
function units(value: string, decimals: number): bigint {
  const [whole, frac = ""] = value.split(".");
  const scaled = BigInt(whole + (frac + "0".repeat(decimals)).slice(0, decimals));
  return frac.length > decimals && /[1-9]/.test(frac.slice(decimals)) ? scaled + 1n : scaled;
}

/** Refuse a prepared plan that is not what was asked for. Throws before anything is signed. */
function checkPrepared(plan: TradePlan, body: PrepareBody, opts: RunTradePlanOptions): void {
  const refuse = (why: string): never => {
    throw new SafetyCheckError(`refusing to sign trade plan ${plan.id}: ${why}`, plan);
  };
  const same = (a: string | undefined | null, b: string | undefined | null) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

  if (!same(plan.wallet, body.wallet)) refuse("it is for another wallet");
  if (plan.submission?.funding !== "kairos" || plan.submission?.trade !== "kairos") refuse("it uses client-owned submission");

  const want = body.order;
  const got = plan.order;
  const venue = want.market.includes(":") ? want.market.split(":")[0].toLowerCase() : "polymarket";
  if (plan.venue !== venue) refuse(`venue changed to ${plan.venue}`);
  if (!same(got.market, want.market)) refuse(`market changed to ${got.market}`);
  if (got.side !== "buy") refuse(`side changed to ${got.side}`);
  if (got.price !== want.price) refuse(`price changed to ${got.price}`);
  if (got.size !== want.size) refuse(`size changed to ${got.size}`);
  if (got.postOnly !== want.postOnly) refuse("postOnly changed");
  if (got.clientOrderId !== want.clientOrderId) refuse("clientOrderId changed");
  const outcomeOk = got.outcome.trim().toLowerCase() === want.outcome.trim().toLowerCase() || (plan.venue === "hyperliquid" && /^#\d+$/.test(got.outcome));
  if (!outcomeOk) refuse(`outcome changed to ${got.outcome}`);
  const sessionBound = plan.venue === "predictfun" && want.timeInForce === "GTC" && got.timeInForce === "GTD" && !!got.expiresAt;
  if (got.timeInForce !== want.timeInForce && !sessionBound) refuse(`timeInForce changed to ${got.timeInForce}`);
  if (want.expiresAt) {
    if (!got.expiresAt || Date.parse(got.expiresAt) > Date.parse(want.expiresAt)) refuse("expiresAt is later than requested");
  } else if (got.expiresAt && !sessionBound) refuse("an expiry was added");
  if (Date.parse(plan.tradeSubmitBefore) > Date.parse(body.tradeSubmitBefore)) refuse("tradeSubmitBefore is later than requested");
  if (!(Date.parse(plan.executeBefore) <= Date.parse(plan.tradeSubmitBefore))) refuse("executeBefore is after tradeSubmitBefore");

  const b = plan.tradeBudget;
  const notional = BigInt(b.notionalRaw);
  const fee = BigInt(b.maxCollateralFeeRaw);
  const debit = BigInt(b.maxDebitRaw);
  if (notional <= 0n || notional + fee > debit || b.maxPlatformFeeBps < 0 || b.maxPlatformFeeBps > 1000) refuse("its budget is inconsistent");
  if (notional > units(String(mulDecimal(got.price, got.size)), b.decimals)) refuse("its notional exceeds price times size");
  if (opts.maxDebitRaw !== undefined && debit > BigInt(opts.maxDebitRaw)) refuse(`it could debit ${b.maxDebitRaw}, over maxDebitRaw ${String(opts.maxDebitRaw)}`);

  const pf = plan.funding;
  const rf = body.funding;
  if (!rf && pf) refuse("it adds funding that was not requested");
  if (rf && pf) {
    if (pf.sourceChainId !== rf.sourceChainId || !same(pf.sourceToken, rf.sourceToken)) refuse("funding source changed");
    if (BigInt(pf.amountInRaw) > BigInt(rf.maxAmountRaw)) refuse("funding exceeds maxAmountRaw");
    if (BigInt(pf.maxGasCostRaw) > BigInt(rf.maxGasCostRaw) || pf.slippageBps > rf.slippageBps) refuse("funding exceeds the requested limits");
    if (!same(pf.recipient, plan.tradingWallet) || !same(pf.refundRecipient, body.wallet)) refuse("funding pays or refunds another address");
  }
  const deps = (plan.ctfDependencies ?? []).map((d) => d.intent.intentId);
  if (JSON.stringify(deps) !== JSON.stringify(body.ctfDependencies ?? [])) refuse("its on-chain prerequisites differ");

  // Every request is bound into planHash and the plan authorization; recompute both rather than trust them.
  for (const req of plan.requests) {
    const signer = req.request.method === "personal_sign" ? req.request.params[1] : req.request.params[0];
    if (!same(req.signer, body.wallet) || !same(String(signer ?? ""), body.wallet)) refuse(`request ${req.id} is for another signer`);
    if (req.externalSubmission) refuse(`request ${req.id} is client-submitted`);
    if (req.request.method !== "eth_signTypedData_v4") refuse(`request ${req.id} asks for ${req.request.method}`);
    let hash: string | undefined;
    try {
      hash = requestHash(req.request);
    } catch {
      refuse(`request ${req.id} is malformed`);
    }
    if (hash !== req.requestHash) refuse(`request ${req.id} does not match its requestHash`);
    const doc = typedDoc(req.request);
    if (!doc || uintValue(doc.domain?.chainId) === undefined || uintValue(doc.domain?.chainId) !== uintValue(req.chainId)) refuse(`request ${req.id} signs for another chain`);
  }
  if (tradePlanHash(plan) !== plan.planHash) refuse("its planHash does not match the plan");
  const consents = plan.requests.filter((r) => r.purpose === "plan");
  const trades = plan.requests.filter((r) => r.purpose === "trade");
  if (consents.length !== 1 || trades.length !== 1) refuse("it needs exactly one plan authorization and one trade");
  const tradeChain = uintValue(trades[0].chainId);
  if (tradeChain === undefined || !VENUE_CHAINS[plan.venue]?.includes(tradeChain)) refuse("the trade signs on another chain");
  if (uintValue(consents[0].chainId) !== tradeChain) refuse("the plan authorization signs on another chain");
  if (!sameRequest(consents[0].request, tradePlanAuthorization(plan, tradeChain!))) refuse("its authorization does not name this plan");
  checkTrade(plan, typedDoc(trades[0].request)!, refuse);
  for (const req of plan.requests.filter((r) => r.purpose === "funding")) {
    if (!pf) refuse("it asks for a funding signature without funding");
    checkFunding(plan, req, refuse);
  }
}

/** The venue order the trade request signs must be this plan's buy. */
function checkTrade(plan: TradePlan, doc: TypedDoc, refuse: (why: string) => never): void {
  const o = plan.order;
  const m = doc.message ?? {};
  if (plan.venue === "hyperliquid") {
    const ok =
      doc.primaryType === "PlaceOrder" &&
      doc.domain?.name === "Kairos" &&
      sameHex(m.wallet, plan.wallet) &&
      typeof m.market === "string" &&
      m.market.toLowerCase() === o.market.toLowerCase() &&
      m.outcome === o.outcome &&
      m.side === "buy" &&
      m.price === o.price &&
      m.size === o.size &&
      m.timeInForce === o.timeInForce &&
      m.postOnly === o.postOnly &&
      m.action === plan.id &&
      uintValue(m.expiresAt) === BigInt(unixSeconds(plan.tradeSubmitBefore));
    if (!ok) refuse("the trade signs a different order");
    return;
  }
  const order = (plan.venue === "polymarket" ? m.contents : m) as Record<string, unknown> | undefined;
  const makers = plan.venue === "polymarket" ? [plan.tradingWallet] : [plan.wallet, plan.tradingWallet];
  const wrapped =
    plan.venue !== "polymarket" ||
    (doc.primaryType === "TypedDataSign" && m.name === "DepositWallet" && uintValue(m.chainId) === 137n && sameHex(m.verifyingContract, plan.tradingWallet) && POLYMARKET_EXCHANGES.includes(String(doc.domain?.verifyingContract).toLowerCase()));
  const ok =
    wrapped &&
    (plan.venue === "polymarket" || doc.primaryType === "Order") &&
    !!order &&
    makers.some((a) => sameHex(order.maker, a)) &&
    [plan.wallet, plan.tradingWallet].some((a) => sameHex(order.signer, a)) &&
    uintValue(order.side) === 0n &&
    uintValue(order.takerAmount) === units(o.size, SHARE_DECIMALS[plan.venue]!) &&
    uintValue(order.makerAmount) === BigInt(plan.tradeBudget.notionalRaw) &&
    (order.taker === undefined || uintValue(order.taker) === 0n) &&
    (!o.expiresAt || order.expiration === undefined || uintValue(order.expiration) === BigInt(unixSeconds(o.expiresAt)));
  if (!ok) refuse("the trade signs a different order");
}

/** A funding signature may move only the quoted amount of the source token, from the wallet, to the bridge. */
function checkFunding(plan: TradePlan, req: TradePlanWalletRequest, refuse: (why: string) => never): void {
  const f = plan.funding!;
  const doc = typedDoc(req.request)!;
  const m = doc.message ?? {};
  const chain = BigInt(f.sourceChainId);
  const amount = BigInt(f.amountInRaw);
  const until = BigInt(unixSeconds(plan.tradeSubmitBefore));
  const before = (v: unknown) => {
    const t = uintValue(v);
    return t !== undefined && t <= until;
  };
  if (uintValue(req.chainId) !== chain || uintValue(doc.domain?.chainId) !== chain) refuse(`funding request ${req.id} signs on another chain`);
  if (doc.primaryType === "ReceiveWithAuthorization") {
    const ok =
      sameHex(doc.domain?.verifyingContract, f.sourceToken) &&
      sameHex(m.from, plan.wallet) &&
      sameHex(m.to, RELAY_APPROVAL_PROXY) &&
      uintValue(m.value) === amount &&
      before(m.validBefore);
    if (!ok) refuse(`funding request ${req.id} moves something else`);
    return;
  }
  if (doc.primaryType === "MulticallAuthorization") {
    const funding = Array.isArray(m.funding) && m.funding.length === 1 ? (m.funding[0] as Record<string, unknown>) : undefined;
    const ok =
      sameHex(doc.domain?.verifyingContract, RELAY_APPROVAL_PROXY) &&
      sameHex(m.from, plan.wallet) &&
      sameHex(m.refundTo, plan.wallet) &&
      uintValue(m.msgValue) === 0n &&
      !!funding &&
      sameHex(funding.token, f.sourceToken) &&
      sameHex(funding.from, plan.wallet) &&
      uintValue(funding.value) === amount &&
      before(funding.validBefore);
    if (!ok) refuse(`funding request ${req.id} moves something else`);
    return;
  }
  refuse(`funding request ${req.id} signs an unknown ${String(doc.primaryType)}`);
}

/** Exact product of two canonical decimals, as a decimal string. */
function mulDecimal(a: string, b: string): string {
  const scale = (s: string) => (s.split(".")[1] ?? "").length;
  const digits = (BigInt(a.replace(".", "")) * BigInt(b.replace(".", ""))).toString();
  const n = scale(a) + scale(b);
  if (n === 0) return digits;
  const padded = digits.padStart(n + 1, "0");
  return `${padded.slice(0, -n)}.${padded.slice(-n)}`;
}

function planPath(id: string): string {
  return `/v3/trade-plans/${encodeURIComponent(id)}`;
}
