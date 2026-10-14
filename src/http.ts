// Shared HTTP transport: JSON in, JSON out, one error type.

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A non-2xx response. `status` is the HTTP status; `body` is the parsed JSON, if any. */
export class KairosError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "KairosError";
    this.status = status;
    this.body = body;
  }

  /** True when an order's outcome is unknown and it may still be live: check open orders before retrying. */
  get outcomeUnknown(): boolean {
    return this.status >= 500;
  }
}

export interface HttpOptions {
  baseUrl: string;
  headers?: Record<string, string>;
  fetch?: FetchLike;
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

  async request<T>(method: "GET" | "POST", path: string, opts: { query?: Query; body?: unknown } = {}): Promise<T> {
    const url = this.baseUrl + path + queryString(opts.query);
    const headers: Record<string, string> = { accept: "application/json", ...this.headers };
    if (opts.body !== undefined) headers["content-type"] = "application/json";
    const res = await this.fetchImpl(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
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
    if (!res.ok) {
      throw new KairosError(res.status, errorMessage(json) ?? `${method} ${path} failed with ${res.status}`, json);
    }
    return json as T;
  }

  get<T>(path: string, query?: Query): Promise<T> {
    return this.request<T>("GET", path, { query });
  }

  post<T>(path: string, body?: unknown, query?: Query): Promise<T> {
    return this.request<T>("POST", path, { body, query });
  }
}

export type Query = Record<string, string | number | boolean | undefined | null>;

function queryString(query?: Query): string {
  if (!query) return "";
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== null) params.set(key, String(value));
  }
  const s = params.toString();
  return s ? `?${s}` : "";
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
  return typeof body === "string" && body ? body : undefined;
}
