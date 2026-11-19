import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MARKET_STREAM_PUBLIC_PROTOCOL,
  MARKET_STREAM_URL,
  MarketStream,
  decodeMarketStreamFrame,
  encodeMarketStreamRequest,
  type MarketStreamFrame,
  type MarketStreamSocket,
  type MarketStreamSocketEvents,
  type MarketStreamSocketOptions,
} from "../src/stream.ts";

test("encodes documented control tags and protobuf fields", () => {
  const contract = { contractId: "m", provider: "p" };
  assert.deepEqual([...encodeMarketStreamRequest({
    type: "subscribe", ...contract, topics: ["x"], candleTimeframes: [60, 3600],
  })], [0x10, 10, 1, 109, 18, 1, 112, 26, 1, 120, 34, 3, 60, 144, 28]);
  assert.deepEqual([...encodeMarketStreamRequest({ type: "unsubscribe", ...contract, topics: ["x"] })],
    [0x11, 10, 1, 109, 18, 1, 112, 34, 1, 120]);
  assert.deepEqual([...encodeMarketStreamRequest({ type: "fetch", ...contract })], [0x16, 10, 1, 109, 18, 1, 112]);
  assert.deepEqual([...encodeMarketStreamRequest({ type: "ping", timestampMs: 500 })], [0x12, 8, 244, 3]);
  assert.throws(() => encodeMarketStreamRequest({ type: "subscribe", ...contract, candleTimeframes: [0] }), RangeError);
  assert.throws(() => encodeMarketStreamRequest({ type: "unsubscribe", ...contract, topics: Array(17).fill("x") }), RangeError);
});

test("decodes sequenced books and preserves 64-bit sizes", () => {
  const snapshot = decodeMarketStreamFrame(Uint8Array.of(
    0x02, 8, 2, 18, 1, 109, 34, 1, 116, 42, 3, 89, 101, 115,
    50, 15, 10, 13, 10, 11, 8, 5, 16, 129, 128, 128, 128, 128, 128, 128, 16,
    56, 10, 64, 20,
  ));
  assert.equal(snapshot?.type, "OrderbookSnapshot");
  assert.equal(snapshot.data.provider, 2);
  assert.deepEqual(snapshot.data.outcomeNames, ["Yes"]);
  assert.deepEqual(snapshot.data.tokenIds, ["t"]);
  assert.equal(snapshot.data.seq, 10n);
  assert.equal(snapshot.data.epoch, 20n);
  assert.deepEqual(snapshot.data.outcomes[0].bids?.levels, [{ price: 5, sizeScaled: 9007199254740993n }]);

  const batch = decodeMarketStreamFrame(Uint8Array.of(
    0x1e, 10, 9, 10, 1, 109, 32, 11, 40, 10, 48, 20,
  ));
  assert.equal(batch?.type, "OrderbookDeltaBatch");
  assert.equal(batch.data.deltas[0].contractId, "m");
  assert.equal(batch.data.deltas[0].snapshotSeq, 10n);
  assert.equal(batch.data.deltas[0].seq, 11n);
});

test("handles synthetic frame versions and nested venue trades", () => {
  const quote = decodeMarketStreamFrame(Uint8Array.of(0x53, 1, 10, 1, 115, 16, 2, 32, 1, 50, 4, 8, 5, 16, 7, 64, 9, 72, 9));
  assert.equal(quote?.type, "SyntheticQuote");
  assert.equal(quote.data.syntheticId, "s");
  assert.equal(quote.data.priceUnitExponent, 9);
  assert.deepEqual(quote.data.bestAsk, { priceNano: 5n, qtyNano: 7n, recipes: [] });
  assert.equal(quote.data.bestBid, undefined);

  const trades = decodeMarketStreamFrame(Uint8Array.of(0x54, 10, 1, 115, 18, 10, 10, 1, 112, 18, 1, 109, 24, 1, 34, 0));
  assert.equal(trades?.type, "SyntheticTradeBatch");
  assert.deepEqual(trades.data.trades[0], { venue: "p", contractId: "m", side: 1, trade: new Uint8Array() });
  assert.equal(decodeMarketStreamFrame(Uint8Array.of(0x53, 2, 0)), undefined);
  assert.equal(decodeMarketStreamFrame(Uint8Array.of(0xff, 0)), undefined);
});

test("decodes packed and unpacked payout numerators and skips unknown fields", () => {
  const resolution = decodeMarketStreamFrame(Uint8Array.of(0x22, 98, 2, 1, 0, 96, 2, 0xa0, 0x01, 0x01));
  assert.equal(resolution?.type, "MarketResolutionUpdate");
  assert.deepEqual(resolution.data.payoutNumerators, [1n, 0n, 2n]);
  assert.equal(resolution.data.proposedPrice, undefined);
  assert.throws(() => decodeMarketStreamFrame(Uint8Array.of(0x17, 10, 4, 1)), /Truncated/);
  assert.throws(() => decodeMarketStreamFrame(Uint8Array.of(0x17, 8, 1)), /wire type/);
});

class FakeSocket implements MarketStreamSocket {
  private events = new EventTarget();
  binaryType = "blob";
  readyState = 0;
  sent: Uint8Array[] = [];
  addEventListener<K extends keyof MarketStreamSocketEvents>(type: K, listener: (event: MarketStreamSocketEvents[K]) => void): void {
    this.events.addEventListener(type, listener as EventListener);
  }
  send(frame: Uint8Array): void { this.sent.push(frame); }
  close(): void { this.readyState = 3; }
  open(): void {
    this.readyState = 1;
    this.events.dispatchEvent(new Event("open"));
  }
  message(data: Uint8Array): void {
    this.events.dispatchEvent(new MessageEvent("message", { data }));
  }
}

test("opens a public stream, writes binary controls, and delivers parsed message and error frames", () => {
  const socket = new FakeSocket();
  const frames: MarketStreamFrame[] = [];
  const errors: Error[] = [];
  const contract = { provider: "polymarket", contractId: "m" };
  const stream = new MarketStream({
    webSocketFactory: (url, options) => {
      assert.equal(url, MARKET_STREAM_URL);
      assert.deepEqual(options, { protocols: [MARKET_STREAM_PUBLIC_PROTOCOL] });
      return socket;
    },
    onOpen: (connection) => connection.subscribe({ ...contract, topics: ["orderbook_slow"] }),
    onFrame: (frame) => frames.push(frame),
    onError: (error) => errors.push(error),
  });
  assert.equal(stream.ready, false);
  assert.throws(() => stream.ping(), /not open/);
  socket.open();
  assert.equal(socket.binaryType, "arraybuffer");
  assert.equal(stream.ready, true);
  stream.fetchSnapshot(contract);
  stream.unsubscribe(contract);
  stream.ping(100);
  assert.deepEqual(socket.sent.map((frame) => frame[0]), [0x10, 0x16, 0x11, 0x12]);
  socket.message(Uint8Array.of(0x14, 10, 1, 109));
  socket.message(Uint8Array.of(0x17, 10, 1, 101, 18, 1, 97));
  socket.message(Uint8Array.of(0x02, 10, 4));
  assert.deepEqual(frames, [
    { tag: 0x14, type: "SubscribedResponse", data: { contractId: "m" } },
    { tag: 0x17, type: "ErrorResponse", data: { message: "e", action: "a" } },
  ]);
  assert.match(errors[0].message, /wire type/);
  stream.close();
  assert.equal(stream.ready, false);
});

test("configures JWT subprotocols and server-only key headers", () => {
  const upgrades: MarketStreamSocketOptions[] = [];
  const webSocketFactory = (_url: string, options: MarketStreamSocketOptions) => {
    upgrades.push(options);
    return new FakeSocket();
  };
  new MarketStream({ auth: { type: "jwt", token: "sample" }, webSocketFactory });
  const auth = { type: "apiKey", clientId: "id", apiKey: "key", apiSecret: "secret" } as const;
  new MarketStream({ auth, webSocketFactory });
  assert.deepEqual(upgrades, [
    { protocols: ["authorization", "Bearer_c2FtcGxl"] },
    { protocols: [], headers: { "X-Client-Id": "id", "X-Api-Key": "key", "X-Api-Secret": "secret" } },
  ]);
  assert.throws(() => new MarketStream({ auth }), /factory that can set headers/);
});
