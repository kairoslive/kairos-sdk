// Helpers shared by the wallet API modules: EIP-1193 calls, chain switching, waits, and the value rules the server enforces.

import { keccak256, toHex, utf8 } from "./signing/keccak.ts";

/** Anything with an EIP-1193 `request`, e.g. `window.ethereum`, a WalletConnect provider, or a viem/ethers adapter. */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export interface Eip1193Request {
  method: string;
  params: unknown[];
}

/** A market from the market data API, or its reference `venue:market_id` (a bare `0x…` condition id is Polymarket). */
export type MarketRef = string | { exchange_id: string; market_id?: string | number; condition_id?: string };

/** `venue:market_id` for a market object or reference. */
export function marketRef(market: MarketRef): string {
  if (typeof market === "string") return market;
  if (market.exchange_id === "polymarket" && market.condition_id) return `polymarket:${market.condition_id}`;
  if (market.market_id === undefined || market.market_id === "") throw new Error("market has no market_id");
  return `${market.exchange_id}:${market.market_id}`;
}

/** Per-call options for anything that waits or talks to the network. */
export interface CallOptions {
  /** Aborts the call: pending requests and waits reject with the signal's reason. */
  signal?: AbortSignal;
}

/** Thrown when a wait gives up while the server is still working. The work may still finish: read it again, never repeat it. */
export class WaitTimeoutError extends Error {
  /** The last state read before giving up. */
  readonly last: unknown;

  constructor(message: string, last: unknown) {
    super(message);
    this.name = "WaitTimeoutError";
    this.last = last;
  }
}

/** Thrown before anything is signed when what Kairos prepared differs from what you asked for. Nothing was signed or sent. */
export class SafetyCheckError extends Error {
  /** The prepared plan or intent that failed the check. */
  readonly prepared: unknown;

  constructor(message: string, prepared: unknown) {
    super(message);
    this.name = "SafetyCheckError";
    this.prepared = prepared;
  }
}

/** Chains a request may ask for, so a wallet that does not know one can add it. */
export const CHAINS: Record<string, unknown> = {
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
  "0xa4b1": {
    chainId: "0xa4b1",
    chainName: "Arbitrum One",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://arb1.arbitrum.io/rpc"],
    blockExplorerUrls: ["https://arbiscan.io"],
  },
  "0x66eee": {
    chainId: "0x66eee",
    chainName: "Arbitrum Sepolia",
    nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
    rpcUrls: ["https://sepolia-rollup.arbitrum.io/rpc"],
    blockExplorerUrls: ["https://sepolia.arbiscan.io"],
  },
};

/** Put the wallet on `chainId` (EIP-155 hex), adding the chain first if the wallet does not know it. */
export async function switchChain(provider: Eip1193Provider, chainId: string): Promise<void> {
  const current = await provider.request({ method: "eth_chainId", params: [] }).catch(() => null);
  if (typeof current === "string" && current.toLowerCase() === chainId.toLowerCase()) return;
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (e) {
    const params = CHAINS[chainId.toLowerCase()];
    if ((e as { code?: number })?.code !== 4902 || !params) throw e;
    await provider.request({ method: "wallet_addEthereumChain", params: [params] });
  }
}

/** Run a signing request and insist on a hex string back. */
export async function signWith(provider: Eip1193Provider, request: Eip1193Request): Promise<string> {
  const signature = await provider.request(request);
  if (typeof signature !== "string") throw new Error("wallet returned a non-string signature");
  return signature;
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** RFC 3339 UTC with whole seconds, the only timestamp form the plan and intent routes accept. */
export function rfc3339(at: Date | number | string): string {
  if (typeof at === "string") {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(at)) throw new Error(`timestamp must be RFC 3339 UTC with whole seconds: ${at}`);
    return at;
  }
  const ms = typeof at === "number" ? at * 1000 : at.getTime();
  if (!Number.isFinite(ms) || ms % 1000 !== 0) throw new Error("timestamp must be a whole second");
  return new Date(ms).toISOString().replace(".000Z", "Z");
}

/** Now plus `seconds`, floored to a whole second. */
export function secondsFromNow(seconds: number): string {
  return rfc3339(new Date(Math.floor(Date.now() / 1000 + seconds) * 1000));
}

export function idempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

/** `0x` + 32 lowercase hex: valid as a `clientOrderId` on every venue. */
export function randomClientOrderId(): string {
  return "0x" + globalThis.crypto.randomUUID().replace(/-/g, "");
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/** Lowercase `0x` address; the plan and intent routes compare addresses byte for byte. */
export function lowerAddress(address: string, name = "address"): string {
  const a = address.trim();
  if (!ADDRESS.test(a)) throw new Error(`${name} must be a 0x address`);
  return a.toLowerCase();
}

const DECIMAL = /^(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;
const RAW = /^(0|[1-9][0-9]{0,77})$/;

/** A canonical positive decimal string: `"0.5"`, not `"0.50"`, `".5"` or `"5e-1"`. */
export function canonicalDecimal(value: string | number, name: string): string {
  const s = String(value);
  if (!DECIMAL.test(s) || !/[1-9]/.test(s)) throw new Error(`${name} must be a canonical positive decimal string such as "0.5", got ${JSON.stringify(s)}`);
  return s;
}

/** A canonical base-10 integer string in token base units, no leading zeros, up to uint256. */
export function canonicalRaw(value: string | number | bigint, name: string, opts: { positive?: boolean } = {}): string {
  const s = typeof value === "string" ? value : typeof value === "bigint" ? value.toString() : Number.isSafeInteger(value) ? String(value) : "x";
  if (!RAW.test(s) || BigInt(s) >= 1n << 256n || (opts.positive && s === "0")) {
    throw new Error(`${name} must be a canonical integer string in base units, got ${JSON.stringify(String(value))}`);
  }
  return s;
}

/** The server's canonical JSON: keys sorted by UTF-16 code units, no whitespace, safe integers only. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
  }
  if (typeof value === "number" && !Number.isSafeInteger(value)) throw new Error("JSON numbers must be safe integers");
  if (value === undefined || typeof value === "function" || typeof value === "bigint") throw new Error(`${typeof value} is not JSON`);
  return JSON.stringify(value);
}

/** keccak256 of the canonical JSON, as the server hashes plans, requests and intents. */
export function valueHash(value: unknown): string {
  return toHex(keccak256(utf8(canonicalJson(value))));
}

/** The server's `requestHash`: `{method, params}` hashed with the typed-data document canonicalized in place. */
export function requestHash(request: Eip1193Request): string {
  const params = [...request.params];
  if (request.method === "eth_signTypedData_v4") {
    if (typeof params[1] !== "string") throw new Error("typed data must be a JSON string");
    params[1] = canonicalJson(JSON.parse(params[1]));
  }
  return valueHash({ method: request.method, params });
}

/** The typed-data request the server builds for `document`. */
export function typedDataRequest(signer: string, document: unknown): Eip1193Request {
  return { method: "eth_signTypedData_v4", params: [signer, canonicalJson(document)] };
}

/** True when two requests hash the same, i.e. the wallet would be asked to sign the same thing. */
export function sameRequest(a: Eip1193Request, b: Eip1193Request): boolean {
  try {
    return requestHash(a) === requestHash(b);
  } catch {
    return false;
  }
}

export interface TypedDoc {
  types?: Record<string, unknown>;
  primaryType?: string;
  domain?: Record<string, unknown>;
  message?: Record<string, unknown>;
}

/** The typed-data document of an `eth_signTypedData_v4` request, or undefined. */
export function typedDoc(request: Eip1193Request): TypedDoc | undefined {
  if (request.method !== "eth_signTypedData_v4" || typeof request.params[1] !== "string") return undefined;
  try {
    const doc = JSON.parse(request.params[1]);
    return doc && typeof doc === "object" && !Array.isArray(doc) ? (doc as TypedDoc) : undefined;
  } catch {
    return undefined;
  }
}

/** A chain id or uint given as a safe integer, decimal string or `0x` hex, as a bigint; undefined when malformed. */
export function uintValue(value: unknown): bigint | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(0x[0-9a-fA-F]+|0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  return undefined;
}

/** Unix seconds of an RFC 3339 timestamp, as a decimal string. */
export function unixSeconds(at: string): string {
  return String(Math.floor(Date.parse(at) / 1000));
}

/** Case-insensitive equality of two values that should be the same address or hex string. */
export function sameHex(a: unknown, b: unknown): boolean {
  return typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
}

// One wallet prompt at a time per provider, so a concurrent call cannot switch chain between a switch and its signature.
const walletLocks = new WeakMap<object, Promise<unknown>>();

/** Run `fn` once every earlier prompt on `provider` has settled. An abort while queued means `fn` never runs. */
export function withWallet<T>(provider: Eip1193Provider, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const prev = walletLocks.get(provider) ?? Promise.resolve();
  const next = prev.then(() => {
    signal?.throwIfAborted();
    return fn();
  });
  walletLocks.set(
    provider,
    next.catch(() => undefined),
  );
  return raceSignal(next, signal);
}

/** Switch to `chainId` (if given) and run `fn`, holding the provider so nothing else switches in between. */
export function onChain<T>(provider: Eip1193Provider, chainId: string | null | undefined, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return withWallet(
    provider,
    async () => {
      if (chainId) await switchChain(provider, chainId);
      return fn();
    },
    signal,
  );
}

/** A failure worth repeating for a read or an idempotent write: no response at all, rate limited, or gateway trouble. */
export function isTransient(e: unknown): boolean {
  if (e instanceof TypeError) return true;
  const status = (e as { status?: unknown })?.status;
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

/** Run an idempotent request, repeating it after transient failures (backing off) until `deadline`; then the last error is thrown. */
export async function retryTransient<T>(send: () => Promise<T>, deadline: number, intervalMs: number, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await send();
    } catch (e) {
      signal?.throwIfAborted();
      if (!isTransient(e) || Date.now() >= deadline) throw e;
      const backoff = Math.min(Math.max(intervalMs, 250) * 2 ** attempt, 30_000);
      await sleep(Math.min(backoff, Math.max(0, deadline - Date.now())), signal);
    }
  }
}

/** Settle with `promise`, or reject with the signal's reason when it aborts first. */
export function raceSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
