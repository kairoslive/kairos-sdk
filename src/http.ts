// Shared HTTP transport: JSON in, JSON out, one error type.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Server codes meaning a request may have taken effect even though it did not answer cleanly. */
const UNKNOWN_CODES = new Set(["ORDER_OUTCOME_UNKNOWN", "CANCEL_OUTCOME_UNKNOWN"]);

/** A non-2xx response. `status` is the HTTP status; `body` is the parsed JSON, or the raw text when it is not JSON. */
export class KairosError extends Error {
  readonly status: number;
  readonly body: unknown;
  /** The machine-readable code from the body (`code` or `errorCode`), when the server sent one. */
  readonly code: string | undefined;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "KairosError";
    this.status = status;
    this.body = body;
    this.code = bodyCode(body);
  }

  /**
   * True when the request may still have taken effect, so an order or cancel may be live: check open orders before retrying.
   * That is a `500`, `502`, `504` or `408` (the server stopped answering mid-request), or a body coded `ORDER_OUTCOME_UNKNOWN`
   * or `CANCEL_OUTCOME_UNKNOWN`. A `503` is false: it means the request was refused before reaching a venue.
   */
  get outcomeUnknown(): boolean {
    if (this.code && UNKNOWN_CODES.has(this.code)) return true;
    return this.status === 500 || this.status === 502 || this.status === 504 || this.status === 408;
  }
}

/**
 * `409` with code `FEE_SETTLEMENT_REQUIRED`: the wallet owes at least the settlement threshold in trading fees.
 * Pay with `wallet.fees.settle(wallet, venue)`, then retry. Amounts are integer strings in the asset's base units.
 */
export class FeeSettlementRequiredError extends KairosError {
  /** `evm:<chainId>:<token>`: the collateral the fees are owed in. */
  readonly assetKey: string;
  readonly owedRaw: string;
  readonly thresholdRaw: string;

  constructor(status: number, message: string, body: Record<string, unknown>) {
    super(status, message, body);
    this.name = "FeeSettlementRequiredError";
    this.assetKey = String(body.assetKey ?? "");
    this.owedRaw = String(body.owedRaw ?? "");
    this.thresholdRaw = String(body.thresholdRaw ?? "");
  }
}

export interface HttpOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
}

export interface RequestOptions {
  query?: Query;
  body?: unknown;
  headers?: Record<string, string>;
  /** Aborts the request. */
  signal?: AbortSignal;
}

export class Http {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  constructor(opts: HttpOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.headers = opts.headers ?? {};
    this.fetchImpl = opts.fetch ?? ((input, init) => fetch(input, init));
  }

  async request<T>(method: "GET" | "POST", path: string, opts: RequestOptions = {}): Promise<T> {
    opts.signal?.throwIfAborted();
    const url = this.baseUrl + path + queryString(opts.query);
    const headers: Record<string, string> = { accept: "application/json", ...this.headers, ...opts.headers };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
    const text = await res.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    if (!res.ok) throw httpError(res.status, errorMessage(json) ?? `${method} ${path} failed with ${res.status}`, json);
    return json as T;
  }

  get<T>(path: string, query?: Query, headers?: Record<string, string>, signal?: AbortSignal): Promise<T> {
    return this.request<T>("GET", path, { query, headers, signal });
  }

  post<T>(path: string, body?: unknown, query?: Query, signal?: AbortSignal): Promise<T> {
    return this.request<T>("POST", path, { body, query, signal });
  }
}

export type Query = Record<string, string | number | boolean | undefined | null>;

function httpError(status: number, message: string, body: unknown): KairosError {
  if (bodyCode(body) === "FEE_SETTLEMENT_REQUIRED") return new FeeSettlementRequiredError(status, message, body as Record<string, unknown>);
  return new KairosError(status, message, body);
}

function queryString(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
}

function bodyCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const b = body as Record<string, unknown>;
  if (typeof b.code === "string") return b.code;
  if (typeof b.errorCode === "string") return b.errorCode;
  return undefined;
}

function errorMessage(body: unknown): string | undefined {
  if (body && typeof body === "object") {
    const b = body as Record<string, unknown>;
    if (typeof b.error === "string") return b.error;
    if (b.error && typeof b.error === "object" && typeof (b.error as Record<string, unknown>).message === "string") {
      return (b.error as Record<string, unknown>).message as string;
    }
    if (typeof b.detail === "string") return b.detail;
    if (typeof b.message === "string") return b.message;
  }
  // Request-shape rejections come back as plain text.
  if (typeof body === "string" && body.trim()) return body.trim().slice(0, 500);
  return undefined;
}
