// Trade plans (/v3/trade-plans), preview: one buy or sell, signed up front in one batch with a fee ceiling and deadlines.
// When the venue account is short, a plan can first bridge exactly the shortfall from the wallet's USDC on Polygon or Arbitrum.

import {
  SafetyCheckError,
  WaitTimeoutError,
  canonicalDecimal,
  canonicalJson,
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
import type { Side, TimeInForce, Venue, WalletContext } from "./wallets.ts";
import {
  CTF_EXCHANGE_V1_LOWER,
  CTF_EXCHANGE_V2_LOWER,
  EXCHANGE_V3_LOWER,
  NEG_RISK_CTF_EXCHANGE_V1_LOWER,
  NEG_RISK_CTF_EXCHANGE_V2_LOWER,
  PUSD_LOWER,
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
  side: Side;
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
    /** A venue market ref, or market metadata to also pin the selected outcome's token. */
    market: string | (Omit<Exclude<MarketRef, string>, "condition_id"> & {
      condition_id?: string | null;
      outcomes?: readonly { outcome: string; normalized_outcome?: string; token_id: string }[];
    });
    outcome: string;
    /** Defaults to buy. Sell plans are available on Polymarket and Predict.fun. */
    side?: Side;
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
  /** Buys only. Omit when the collateral is already at the venue. */
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

/** Cost and fee bounds in collateral base units. */
export interface TradeBudget {
  collateral: Collateral;
  decimals: number;
  /** Buy collateral before fees, or maximum gross sell proceeds (one unit per share). */
  notionalRaw: string;
  /** Gross proceeds at the sell limit price. Absent for buys. */
  minProceedsRaw?: string;
  /** Platform fee bound, plus the venue fee bound for buys. */
  maxCollateralFeeRaw: string;
  /** Kairos and partner fee ceiling together, at most 1000 (10%). */
  maxPlatformFeeBps: number;
  /** Most collateral the buy can debit, or "0" for sells. */
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
  /** Pin the ERC-1155 outcome token when supplying a string market reference. */
  outcomeTokenId?: string | bigint;
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
    const tokenId = expectedOutcomeToken(input, body.order, opts.outcomeTokenId);
    let plan = await this.send(body, opts.idempotencyKey ?? idempotencyKey(), { signal });
    if (TERMINAL.has(plan.status)) return plan;
    if (plan.execution.committed) return this.wait(plan.id, body.wallet, opts, plan);
    checkPrepared(plan, body, opts, tokenId);

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
  const side = o.side ?? "buy";
  if (side !== "buy" && side !== "sell") throw new Error("side must be buy or sell");
  const market = typeof o.market === "string"
    ? o.market
    : marketRef({ ...o.market, condition_id: o.market.condition_id ?? undefined });
  const price = canonicalDecimal(o.price, "price");
  if (!price.startsWith("0.")) throw new Error("price must be between 0 and 1");
  const timeInForce = o.timeInForce ?? "GTC";
  const postOnly = o.postOnly ?? false;
  if (postOnly && timeInForce !== "GTC" && timeInForce !== "GTD") throw new Error("postOnly needs timeInForce GTC or GTD");
  if ((timeInForce === "GTD") !== (o.expiresAt !== undefined)) throw new Error("expiresAt is required with GTD and only with GTD");
  const clientOrderId = o.clientOrderId ?? randomClientOrderId();
  if (!/^[\x21-\x7e]{1,128}$/.test(clientOrderId)) throw new Error("clientOrderId must be 1–128 visible ASCII characters");
  const order: TradePlanOrder = {
    market: side === "sell" && !market.includes(":") ? `polymarket:${market}` : market,
    outcome: o.outcome,
    side,
    price,
    size: canonicalDecimal(o.size, "size"),
    timeInForce,
    postOnly,
    clientOrderId,
    ...(o.expiresAt !== undefined ? { expiresAt: rfc3339(o.expiresAt) } : {}),
  };
  const f = input.funding;
  if (side === "sell") validateSellInput(order, input);
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

function validateSellInput(order: TradePlanOrder, input: TradePlanInput): void {
  const venue = order.market.split(":")[0];
  if (!isSellVenue(venue)) throw new Error("sell plans are available only on Polymarket and Predict.fun");
  if (input.funding || input.ctfDependencies?.length) throw new Error("sell plans do not accept funding or on-chain prerequisites");
  const pattern = venue === "polymarket" ? /^polymarket:0x[0-9a-fA-F]{64}$/ : /^predictfun:[0-9]{1,20}$/;
  if (!pattern.test(order.market)) throw new Error("sell plan market must use a Polymarket condition id or Predict.fun market id");
  const decimals = SHARE_DECIMALS[venue];
  if (exactUnits(order.size, decimals) === undefined) throw new Error("sell size must align with the venue share precision");
  if (exactUnits(mulDecimal(order.price, order.size), decimals) === undefined) {
    throw new Error("sell size times price must align with the venue collateral precision");
  }
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

const PLAN_PURPOSES = new Set(["plan", "trade", "funding"]);
const VENUE_CHAINS: Record<Venue, readonly bigint[]> = { polymarket: [137n], predictfun: [56n], hyperliquid: [42161n, 421614n] };
const POLYMARKET_EXCHANGES = [CTF_EXCHANGE_V2_LOWER, NEG_RISK_CTF_EXCHANGE_V2_LOWER, CTF_EXCHANGE_V1_LOWER, NEG_RISK_CTF_EXCHANGE_V1_LOWER];
const SHARE_DECIMALS = { polymarket: 6, predictfun: 18 } as const;
type SellVenue = keyof typeof SHARE_DECIMALS;
const PREDICTFUN_USDT = "0x55d398326f99059ff775485246999027b3197955";
const PREDICTFUN_EXCHANGES = [
  "0x8bc070bedab741406f4b1eb65a72bee27894b689",
  "0x365fb81bd4a24d6303cd2f19c349de6894d8d58a",
  "0x6beb5a40c032afc305961162d8204cda16decfa5",
  "0x8a289d458f5a134ba40015085a8f50ffb681b41d",
];
const UINT256_LIMIT = 1n << 256n;
const ZERO_BYTES32 = "0x" + "00".repeat(32);
const EIP712_DOMAIN = [
  ["name", "string"], ["version", "string"], ["chainId", "uint256"], ["verifyingContract", "address"],
];
const ORDER_PREFIX = [["salt", "uint256"], ["maker", "address"], ["signer", "address"]];
const ORDER_AMOUNTS = [["tokenId", "uint256"], ["makerAmount", "uint256"], ["takerAmount", "uint256"]];
const ORDER_SIDE = [["side", "uint8"], ["signatureType", "uint8"]];
const SELL_TYPES = {
  polymarket: {
    EIP712Domain: EIP712_DOMAIN,
    TypedDataSign: [["contents", "Order"], ...EIP712_DOMAIN, ["salt", "bytes32"]],
    Order: [...ORDER_PREFIX, ...ORDER_AMOUNTS, ...ORDER_SIDE, ["timestamp", "uint256"], ["metadata", "bytes32"], ["builder", "bytes32"]],
  },
  predictfun: {
    EIP712Domain: EIP712_DOMAIN,
    Order: [
      ...ORDER_PREFIX, ["taker", "address"], ...ORDER_AMOUNTS,
      ["expiration", "uint256"], ["nonce", "uint256"], ["feeRateBps", "uint256"], ...ORDER_SIDE,
    ],
  },
};
function isSellVenue(venue: string): venue is SellVenue {
  return venue === "polymarket" || venue === "predictfun";
}

function expectedOutcomeToken(input: TradePlanInput, order: TradePlanOrder, explicit?: string | bigint): bigint | undefined {
  const venue = order.market.includes(":") ? order.market.split(":")[0].toLowerCase() : "polymarket";
  if (!isSellVenue(venue)) {
    if (explicit !== undefined) throw new Error("outcomeTokenId applies only to Polymarket and Predict.fun");
    return undefined;
  }
  const assetId = (value: string | bigint): bigint => {
    const parsed = uintValue(String(value));
    if (parsed === undefined || parsed <= 0n || parsed >= UINT256_LIMIT) throw new Error("outcomeTokenId must be a positive uint256");
    return parsed;
  };
  const requested = input.order.outcome.trim().toLowerCase();
  const market = input.order.market;
  const outcomes = typeof market === "string" ? undefined : market.outcomes;
  const tokens = outcomes?.filter((outcome) => [outcome.outcome, outcome.normalized_outcome].some((name) => name?.trim().toLowerCase() === requested))
    .map((outcome) => assetId(outcome.token_id)) ?? [];
  const pinned = explicit === undefined ? tokens[0] : assetId(explicit);
  if (tokens.some((token) => token !== pinned)) throw new Error("outcomeTokenId does not match an unambiguous market outcome");
  if (outcomes?.length && !tokens.length && explicit === undefined) throw new Error("requested outcome is absent from the market metadata");
  return pinned;
}
// Relay's approval proxy, the only contract a funding permit may pay.
const RELAY_APPROVAL_PROXY = "0x5567954cd026cebfe486062cb75848e0f1c12e58";

/** `value` (a canonical decimal) in base units, rounded up. */
function units(value: string, decimals: number): bigint {
  const [whole, frac = ""] = value.split(".");
  const scaled = BigInt(whole + (frac + "0".repeat(decimals)).slice(0, decimals));
  return frac.length > decimals && /[1-9]/.test(frac.slice(decimals)) ? scaled + 1n : scaled;
}

function exactUnits(value: string, decimals: number): bigint | undefined {
  const fraction = value.split(".")[1] ?? "";
  return /[1-9]/.test(fraction.slice(decimals)) ? undefined : units(value, decimals);
}

type Refuse = (why: string) => never;

/** Refuse a prepared plan that is not what was asked for. Throws before signing the plan. */
function checkPrepared(plan: TradePlan, body: PrepareBody, opts: RunTradePlanOptions, tokenId?: bigint): void {
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
  if (got.side !== want.side) refuse(`side changed to ${got.side}`);
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
  const debit = got.side === "sell" ? checkSellBudget(plan, refuse) : checkBuyBudget(plan, refuse);
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
    // Only the kinds checked below are ever signed: anything else could be an unrelated permit.
    if (req.kind !== "signature" || !PLAN_PURPOSES.has(req.purpose)) refuse(`request ${req.id} has unexpected purpose ${String(req.purpose)}`);
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
  if (got.side === "sell" && (plan.requests.length !== 2 || plan.requests.some((request) => request.kind !== "signature"))) {
    refuse("a sell needs only the plan authorization and trade signatures");
  }
  const tradeChain = uintValue(trades[0].chainId);
  if (tradeChain === undefined || !VENUE_CHAINS[plan.venue]?.includes(tradeChain)) refuse("the trade signs on another chain");
  if (uintValue(consents[0].chainId) !== tradeChain) refuse("the plan authorization signs on another chain");
  if (!sameRequest(consents[0].request, tradePlanAuthorization(plan, tradeChain!))) refuse("its authorization does not name this plan");
  checkTrade(plan, typedDoc(trades[0].request)!, refuse, tokenId);
  for (const req of plan.requests.filter((r) => r.purpose === "funding")) {
    if (!pf) refuse("it asks for a funding signature without funding");
    checkFunding(plan, req, refuse);
  }
}

function checkBuyBudget(plan: TradePlan, refuse: Refuse): bigint {
  const b = plan.tradeBudget;
  const notional = BigInt(b.notionalRaw);
  const fee = BigInt(b.maxCollateralFeeRaw);
  const debit = BigInt(b.maxDebitRaw);
  if (b.minProceedsRaw != null || notional <= 0n || notional + fee > debit || b.maxPlatformFeeBps < 0 || b.maxPlatformFeeBps > 1000) {
    refuse("its budget is inconsistent");
  }
  if (notional > units(mulDecimal(plan.order.price, plan.order.size), b.decimals)) refuse("its notional exceeds price times size");
  return debit;
}

function checkSellBudget(plan: TradePlan, refuse: Refuse): bigint {
  const { order, tradeBudget: b, venue } = plan;
  if (!isSellVenue(venue)) return refuse("its venue does not support sell plans");
  const decimals = SHARE_DECIMALS[venue];
  const chainId = venue === "polymarket" ? "137" : "56";
  const collateral = venue === "polymarket" ? PUSD_LOWER : PREDICTFUN_USDT;
  const notional = exactUnits(order.size, decimals);
  const proceeds = exactUnits(mulDecimal(order.price, order.size), decimals);
  if (b?.collateral?.kind !== "evm" || b.collateral.chainId !== chainId || !sameHex(b.collateral.token, collateral) || b.decimals !== decimals) {
    return refuse("its sell collateral is inconsistent with the venue");
  }
  if (notional === undefined || proceeds === undefined || proceeds <= 0n || notional >= UINT256_LIMIT ||
    b.notionalRaw !== String(notional) || b.minProceedsRaw !== String(proceeds) || b.maxDebitRaw !== "0" ||
    !Number.isInteger(b.maxPlatformFeeBps) || b.maxPlatformFeeBps < 0 || b.maxPlatformFeeBps > 1000) {
    return refuse("its sell budget is inconsistent");
  }
  const partnerFee = b.partnerFee?.maxBps;
  if (partnerFee !== undefined && (!Number.isInteger(partnerFee) || partnerFee < 0 || partnerFee > b.maxPlatformFeeBps)) {
    refuse("its partner fee exceeds the platform fee ceiling");
  }
  const maxFee = (notional * BigInt(b.maxPlatformFeeBps) + 9999n) / 10000n;
  if (b.maxCollateralFeeRaw !== String(maxFee)) refuse("its sell fee does not match the signed ceiling");
  return 0n;
}

/** The venue order the trade request signs must be this plan's order. */
function checkTrade(plan: TradePlan, doc: TypedDoc, refuse: Refuse, tokenId?: bigint): void {
  const o = plan.order;
  const m = doc.message ?? {};
  if (o.side === "sell") return checkSellTrade(plan, doc, refuse, tokenId);
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
  const exchange = String(doc.domain?.verifyingContract).toLowerCase();
  const isPolymarketExchange = POLYMARKET_EXCHANGES.includes(exchange) || (exchange === EXCHANGE_V3_LOWER && doc.domain?.version === "3");
  const wrapped = plan.venue !== "polymarket" ||
    (doc.primaryType === "TypedDataSign" && m.name === "DepositWallet" && uintValue(m.chainId) === 137n && sameHex(m.verifyingContract, plan.tradingWallet) && isPolymarketExchange);
  const ok =
    wrapped &&
    (plan.venue === "polymarket" || doc.primaryType === "Order") &&
    !!order &&
    makers.some((a) => sameHex(order.maker, a)) &&
    [plan.wallet, plan.tradingWallet].some((a) => sameHex(order.signer, a)) &&
    uintValue(order.side) === 0n &&
    (tokenId === undefined || uintValue(order.tokenId) === tokenId) &&
    uintValue(order.takerAmount) === units(o.size, SHARE_DECIMALS[plan.venue]) &&
    uintValue(order.makerAmount) === BigInt(plan.tradeBudget.notionalRaw) &&
    (order.taker === undefined || uintValue(order.taker) === 0n) &&
    (!o.expiresAt || order.expiration === undefined || uintValue(order.expiration) === BigInt(unixSeconds(o.expiresAt)));
  if (!ok) refuse("the trade signs a different order");
}

function checkSellTrade(plan: TradePlan, doc: TypedDoc, refuse: Refuse, expectedToken?: bigint): void {
  const { order: o, tradeBudget: b, venue } = plan;
  if (!isSellVenue(venue)) return refuse("its venue does not support sell plans");
  const expectedTypes = Object.fromEntries(Object.entries(SELL_TYPES[venue]).map(([name, fields]) => [
    name, fields.map(([name, type]) => ({ name, type })),
  ]));
  if (!doc.types || canonicalJson(doc.types) !== canonicalJson(expectedTypes)) refuse("the sell uses an unexpected signed order structure");
  const m = doc.message ?? {};
  const domain = doc.domain ?? {};
  const exchange = String(domain.verifyingContract).toLowerCase();
  const order = (venue === "polymarket" ? m.contents : m) as Record<string, unknown> | undefined;
  if (!order) return refuse("the sell has no signed order");
  const asset = uintValue(order.tokenId);
  const owner = venue === "polymarket" ? plan.tradingWallet : plan.wallet;
  if (asset === undefined || asset <= 0n || asset >= UINT256_LIMIT || (expectedToken !== undefined && asset !== expectedToken) ||
    !sameHex(order.maker, owner) || !sameHex(order.signer, owner) || uintValue(order.side) !== 1n ||
    uintValue(order.makerAmount) !== BigInt(b.notionalRaw) || uintValue(order.takerAmount) !== BigInt(b.minProceedsRaw!)) {
    refuse("the trade signs a different sell order or outcome token");
  }

  if (venue === "polymarket") {
    const knownExchange = domain.version === "3" ? exchange === EXCHANGE_V3_LOWER :
      domain.version === "2" && (exchange === CTF_EXCHANGE_V2_LOWER || exchange === NEG_RISK_CTF_EXCHANGE_V2_LOWER);
    if (doc.primaryType !== "TypedDataSign" || domain.name !== "Polymarket CTF Exchange" || !knownExchange ||
      m.name !== "DepositWallet" || m.version !== "1" || uintValue(m.chainId) !== 137n ||
      !sameHex(m.verifyingContract, owner) || !sameHex(m.salt, ZERO_BYTES32) || uintValue(order.signatureType) !== 3n) {
      refuse("the sell does not authorize this Polymarket deposit wallet and exchange");
    }
    return;
  }

  const fee = uintValue(order.feeRateBps);
  const expiration = uintValue(order.expiration);
  if (doc.primaryType !== "Order" || domain.name !== "predict.fun CTF Exchange" || domain.version !== "1" ||
    !PREDICTFUN_EXCHANGES.includes(exchange) || uintValue(order.signatureType) !== 0n || uintValue(order.taker) !== 0n ||
    !sameHex(plan.tradingWallet, plan.wallet) || fee === undefined || fee > 10000n || expiration === undefined ||
    (o.expiresAt !== undefined && expiration !== uintValue(unixSeconds(o.expiresAt)))) {
    refuse("the sell does not authorize this Predict.fun wallet and exchange");
  }
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
