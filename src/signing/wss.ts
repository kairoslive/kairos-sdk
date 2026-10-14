// WebSocket one-RTT submit for the external-signing lane (`submit_signed_order`).
//
// The client builds and signs the order locally and sends it in one frame; the
// cell verifies and forwards it with zero server-side signing. Authentication
// rides the WebSocket subprotocol (`authorization`, `Bearer_{base64url(token)}`), which is
// what a browser can set.

import type { OrderIntent, SubmitResponse } from "./types.ts";

/** Minimal surface of a `WebSocket` the client uses (injectable for tests). */
export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

export type WebSocketFactory = (url: string, protocols?: string[]) => WebSocketLike;

export interface WssOptions {
  /** Cell WebSocket URL, e.g. `wss://<cell>.kairos.trade/ws`. */
  url: string;
  /** Session JWT, sent as the `Bearer_{base64url(token)}` subprotocol. */
  bearer?: string;
  /** Injectable for tests; defaults to the global `WebSocket`. */
  webSocketFactory?: WebSocketFactory;
  timeoutMs?: number;
}

/** Payload of the `submit_signed_order` command. */
export interface OneshotSignedOrder {
  intent: OrderIntent;
  /** 65-byte ECDSA sig (EOA) or the ERC-7739-wrapped blob (Poly1271). */
  signature_hex: string;
  builder_code: string;
  market_id?: string;
  outcome?: string;
  client_order_id?: string;
  replace_order_id?: string;
  bot_id?: string;
}

function defaultFactory(url: string, protocols?: string[]): WebSocketLike {
  const Ctor = (globalThis as { WebSocket?: new (u: string, p?: string[]) => unknown }).WebSocket;
  if (!Ctor) throw new Error("no global WebSocket; pass webSocketFactory");
  return new Ctor(url, protocols) as unknown as WebSocketLike;
}

function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `req-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function bearerProtocol(token: string): string {
  const bytes = new TextEncoder().encode(token);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `Bearer_${encoded}`;
}

/**
 * Open a WebSocket, send one `submit_signed_order` frame, and resolve with the
 * cell's `order_response` (or reject on `order_error` / timeout). Closes the
 * socket on completion.
 */
export function submitSignedOrderOneShot(
  opts: WssOptions,
  order: OneshotSignedOrder,
): Promise<SubmitResponse> {
  const factory = opts.webSocketFactory ?? defaultFactory;
  let protocols = ["authorization"];
  if (opts.bearer) protocols = ["authorization", bearerProtocol(opts.bearer)];
  const ws = factory(opts.url, protocols);
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const requestId = randomId();

  return new Promise<SubmitResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      fn();
    };
    const timer = setTimeout(() => finish(() => reject(new Error("websocket timeout"))), timeoutMs);

    ws.addEventListener("open", () => {
      ws.send(
        JSON.stringify({ type: "submit_signed_order", request_id: requestId, payload: order }),
      );
    });
    ws.addEventListener("message", (event: any) => {
      let msg: { type?: string; request_id?: string; result?: unknown; error?: string; status?: number };
      try {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      if (msg.request_id !== requestId) return;
      if (msg.type === "order_response") {
        finish(() => resolve(msg.result as SubmitResponse));
      } else if (msg.type === "order_error") {
        finish(() => reject(new Error(msg.error ?? `order_error (status ${msg.status ?? "?"})`)));
      }
    });
    ws.addEventListener("error", () => finish(() => reject(new Error("websocket error"))));
  });
}
