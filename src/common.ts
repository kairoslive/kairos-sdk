// Helpers shared by the wallet API modules: EIP-1193 calls, chain switching, waits, and the value rules the server enforces.

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
