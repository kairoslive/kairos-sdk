// OpenAPI-backed JSON transport for the Data, Market Data and Trading APIs.
import { Http, type RequestOptions, type FetchLike } from "./http.ts";
import type { ApiKeyCredentials } from "./wallets.ts";
import type { paths as DataPaths } from "./openapi/data.ts";
import type { paths as ExecutionPaths } from "./openapi/execution.ts";
import type { paths as MarketDataPaths } from "./openapi/market-data.ts";

export type { DataPaths, ExecutionPaths, MarketDataPaths };

export type RestAuth = { apiKey: ApiKeyCredentials; bearer?: never } | { bearer: string; apiKey?: never };

export interface RestOptions {
  baseUrl?: string;
  auth?: RestAuth;
  fetch?: FetchLike;
}

const methods = { GET: "get", POST: "post", DELETE: "delete", PATCH: "patch", PUT: "put" } as const;
type Method = keyof typeof methods;
type PathsFor<Paths, M extends Method> = {
  [P in keyof Paths]: Paths[P] extends Record<(typeof methods)[M], object> ? P : never;
}[keyof Paths] & string;
type Operation<Paths, M extends Method, P extends keyof Paths> = Paths[P][(typeof methods)[M] & keyof Paths[P]];
type Property<T, K extends PropertyKey> = K extends keyof T ? T[K] : never;
type ParametersOf<T, K extends string> = Property<Property<T, "parameters">, K>;
type Media<T> = T extends { "application/json": infer J } ? J : never;
type RequestBody<T> = Media<Property<NonNullable<Property<T, "requestBody">>, "content">>;
type Successful<T> = {
  [S in keyof T]: S extends number | string ? `${S}` extends `2${string}`
    ? T[S] extends { content: infer C } ? Media<C> : undefined
    : never : never;
}[keyof T];
type Input<K extends string, V> = [NonNullable<V>] extends [never] ? { [P in K]?: never }
  : undefined extends V ? { [P in K]?: NonNullable<V> } : { [P in K]: V };
type Options<T> = Input<"path", ParametersOf<T, "path">>
  & Input<"query", ParametersOf<T, "query">>
  & Input<"headers", ParametersOf<T, "header">>
  & Input<"body", RequestBody<T> | Extract<Property<T, "requestBody">, undefined>>
  & { signal?: AbortSignal };
type Args<T, Extra = unknown> = {} extends Options<T> ? [options?: Options<T> & Extra] : [options: Options<T> & Extra];

export class RestClient<Paths> {
  private readonly http: Http;

  constructor(options: RestOptions & { baseUrl: string }) {
    const fetchImpl = options.fetch ?? ((url, init) => fetch(url, init));
    this.http = new Http({
      baseUrl: options.baseUrl,
      headers: restAuthHeaders(options.auth),
      fetch: options.auth ? (url, init) => fetchImpl(url, { ...init, redirect: "error" }) : fetchImpl,
    });
  }

  /** Sends JSON. Template variables, query parameters, body and success response follow the published schema. */
  request<M extends Method, P extends PathsFor<Paths, M>>(
    method: M, path: P, ...[options]: Args<Operation<Paths, M, P>>
  ): Promise<Successful<Property<Operation<Paths, M, P>, "responses">>> {
    const input = resolveRequest(path, options);
    return this.http.request(method, input.path, input.options);
  }

  /** Returns the response before parsing. Set accept for endpoints that offer a binary representation. */
  response<M extends Method, P extends PathsFor<Paths, M>>(
    method: M, path: P, ...[options]: Args<Operation<Paths, M, P>, { accept?: string }>
  ): Promise<Response> {
    const input = resolveRequest(path, options);
    return this.http.requestResponse(method, input.path, input.options);
  }
}

function resolveRequest(path: string, options: unknown): { path: string; options?: RequestOptions } {
  // The public signatures enforce the operation-specific types. Here we only serialize them.
  const input = options as RequestOptions & { path?: Record<string, string | number>; accept?: string } | undefined;
  const expanded = path.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = input?.path?.[name];
    if (value === undefined) throw new TypeError(`Missing path parameter: ${name}`);
    return encodeURIComponent(value);
  });
  return { path: expanded, options: input?.accept ? { ...input, headers: { ...input.headers, accept: input.accept } } : input };
}

export function restAuthHeaders(auth?: RestAuth): Record<string, string> {
  const key = auth?.apiKey;
  if (key) return { "x-client-id": key.clientId, "x-api-key": key.apiKey, "x-api-secret": key.apiSecret };
  return auth?.bearer ? { authorization: `Bearer ${auth.bearer}` } : {};
}
