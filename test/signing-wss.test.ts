import { test } from "node:test";
import assert from "node:assert/strict";

import { submitSignedOrderOneShot, type WebSocketLike } from "../src/signing/wss.ts";

class FakeWebSocket implements WebSocketLike {
  listeners: Record<string, Array<(event: any) => void>> = {};
  sent: string[] = [];
  closed = false;
  url: string;
  protocols?: string[];
  constructor(url: string, protocols?: string[]) {
    this.url = url;
    this.protocols = protocols;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
  }
  addEventListener(type: string, listener: (event: any) => void): void {
    (this.listeners[type] ??= []).push(listener);
  }
  emit(type: string, event: any): void {
    for (const l of this.listeners[type] ?? []) l(event);
  }
}

function order() {
  return {
    intent: {
      side: "buy" as const,
      price: "0.5",
      size: "1",
      time_in_force: "GTC" as const,
      neg_risk: false,
      owner_address: "0x1111111111111111111111111111111111111111",
      salt: "1",
      timestamp_ms: "1",
    },
    signature_hex: "0xdead",
    builder_code: "0x" + "00".repeat(32),
    market_id: "m",
    outcome: "Yes",
  };
}

test("one-shot sends the command and resolves the order_response", async () => {
  let fake: FakeWebSocket | undefined;
  const promise = submitSignedOrderOneShot(
    {
      url: "wss://cell.example/ws",
      bearer: "eyJhbGciOiJIUzI1NiJ9.a-b_c.signature",
      webSocketFactory: (url, protocols) => {
        fake = new FakeWebSocket(url, protocols);
        return fake;
      },
    },
    order(),
  );

  assert.ok(fake);
  assert.equal(fake.url, "wss://cell.example/ws");
  assert.deepEqual(fake.protocols, [
    "authorization",
    "Bearer_ZXlKaGJHY2lPaUpJVXpJMU5pSjkuYS1iX2Muc2lnbmF0dXJl",
  ]);

  fake.emit("open", {});
  const sent = JSON.parse(fake.sent[0]!);
  assert.equal(sent.type, "submit_signed_order");
  assert.ok(sent.request_id);
  assert.equal(sent.payload.market_id, "m");

  fake.emit("message", {
    data: JSON.stringify({
      type: "order_response",
      request_id: sent.request_id,
      result: { order_id: "o1", exchange_order_id: "0xabc", status: "live" },
    }),
  });

  const res = await promise;
  assert.equal(res.order_id, "o1");
  assert.equal(res.status, "live");
  assert.ok(fake.closed, "socket closed after the response");
});

test("one-shot rejects on order_error with the server message", async () => {
  let fake: FakeWebSocket | undefined;
  const promise = submitSignedOrderOneShot(
    {
      url: "wss://cell.example/ws",
      webSocketFactory: (url, protocols) => {
        fake = new FakeWebSocket(url, protocols);
        return fake;
      },
    },
    order(),
  );
  fake!.emit("open", {});
  const sent = JSON.parse(fake!.sent[0]!);
  fake!.emit("message", {
    data: JSON.stringify({
      type: "order_error",
      request_id: sent.request_id,
      error: "not allow-listed",
      status: 403,
    }),
  });
  await assert.rejects(() => promise, /not allow-listed/);
  assert.ok(fake!.closed);
});

test("one-shot ignores responses for other request ids", async () => {
  let fake: FakeWebSocket | undefined;
  const promise = submitSignedOrderOneShot(
    {
      url: "wss://cell.example/ws",
      timeoutMs: 50,
      webSocketFactory: (url, protocols) => {
        fake = new FakeWebSocket(url, protocols);
        return fake;
      },
    },
    order(),
  );
  fake!.emit("open", {});
  fake!.emit("message", {
    data: JSON.stringify({ type: "order_response", request_id: "someone-else", result: {} }),
  });
  await assert.rejects(() => promise, /timeout/);
});

test("one-shot ignores responses without a request id", async () => {
  let fake: FakeWebSocket | undefined;
  const promise = submitSignedOrderOneShot(
    {
      url: "wss://cell.example/ws",
      timeoutMs: 50,
      webSocketFactory: (url, protocols) => {
        fake = new FakeWebSocket(url, protocols);
        return fake;
      },
    },
    order(),
  );
  fake!.emit("open", {});
  fake!.emit("message", {
    data: JSON.stringify({ type: "order_response", result: { order_id: "wrong" } }),
  });
  await assert.rejects(() => promise, /timeout/);
});
