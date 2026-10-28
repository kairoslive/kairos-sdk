// Fakes shared by the wallet API tests: a routed fetch and an EIP-1193 provider that records what it was asked.

import type { Eip1193Provider } from "../src/index.ts";

export type Call = { method: string; url: string; path: string; headers: Record<string, string>; body: unknown; signal?: AbortSignal };
export type Reply = [number, unknown] | [number, string, "text"];
export type Route = (c: Call) => Reply | undefined;

/** A fake server: each route gets the call and returns [status, body], or [status, text, "text"] for a non-JSON body. */
export function fakeFetch(routes: Route[]) {
  const calls: Call[] = [];
  const impl = async (url: string, init?: RequestInit) => {
    const u = new URL(url);
    const call: Call = {
      method: init?.method ?? "GET",
      url,
      path: u.pathname,
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      signal: init?.signal ?? undefined,
    };
    calls.push(call);
    for (const route of routes) {
      const hit = route(call);
      if (hit) return new Response(hit[2] === "text" ? (hit[1] as string) : JSON.stringify(hit[1]), { status: hit[0] });
    }
    return new Response(JSON.stringify({ error: `no route for ${call.method} ${url}` }), { status: 404 });
  };
  return { impl, calls };
}

export const SIG = "0x" + "11".repeat(65);

/** A wallet that answers every signing request with `SIG`, and records the calls. `answers` overrides per method. */
export function fakeWallet(answers: Record<string, (params: unknown[]) => unknown> = {}) {
  const requests: { method: string; params?: unknown[] }[] = [];
  const provider: Eip1193Provider = {
    async request(args) {
      requests.push(args);
      const handler = answers[args.method];
      if (handler) return handler(args.params ?? []);
      if (args.method === "eth_chainId") return "0x1";
      if (args.method === "wallet_switchEthereumChain") return null;
      return SIG;
    },
  };
  return { provider, requests, methods: () => requests.map((r) => r.method) };
}

export const WALLET = "0x00000000000000000000000000000000000000aa";
export const CHECKSUMMED = "0xAbCdEf0000000000000000000000000000000001";
export const TOKEN = { token: "tok1", expiresAt: "2999-01-01T00:00:00Z" };

/** The login action: one personal_sign step, then the token. */
export function loginRoutes(token = TOKEN): Route[] {
  return [
    (c) =>
      c.method === "POST" && c.path === "/v3/actions" && (c.body as { action: { type: string } }).action.type === "login"
        ? [200, { id: "login1", type: "login", status: "needs_signature", request: { method: "personal_sign", params: ["0x68", WALLET] }, chainId: null, venue: null, description: "Sign in", result: null, error: null }]
        : undefined,
    (c) => (c.method === "POST" && c.path === "/v3/actions/login1" ? [200, { id: "login1", type: "login", status: "done", request: null, chainId: null, venue: null, description: null, result: token, error: null }] : undefined),
  ];
}

export function step(fields: Record<string, unknown>) {
  return { id: "a1", type: "order", status: "working", request: null, description: null, chainId: null, venue: null, result: null, error: null, ...fields };
}
