import { streamSchemas } from "./stream-schema.ts";

export const MARKET_STREAM_URL = "wss://stream.kairos.trade";
export const MARKET_STREAM_PUBLIC_PROTOCOL = "kairos.marketdata.public.v1";

const streamMessages = {
  0x02: "OrderbookSnapshot",
  0x03: "Candle",
  0x04: "TradeBatch",
  0x05: "PriceUpdate",
  0x06: "Volume",
  0x0f: "OrderbookDelta",
  0x13: "PongResponse",
  0x14: "SubscribedResponse",
  0x15: "UnsubscribedResponse",
  0x17: "ErrorResponse",
  0x1a: "Quote",
  0x1c: "TickSizeUpdate",
  0x1d: "MarketResolvedNotice",
  0x1e: "OrderbookDeltaBatch",
  0x20: "EnrichedTradeBatch",
  0x21: "TradePnLBatch",
  0x22: "MarketResolutionUpdate",
  0x23: "SportsGameUpdate",
  0x24: "SportsSnapshot",
  0x25: "SportsEventUpdate",
  0x50: "SyntheticSnapshot",
  0x52: "SyntheticDelta",
  0x53: "SyntheticQuote",
  0x54: "SyntheticTradeBatch",
} as const;

const rawMessages = {
  0x01: "Tick",
  0x08: "Analytics",
  0x09: "WalletGraph",
  0x0a: "DepositScanner",
  0x0b: "CapitalFlow",
  0x0c: "LeaderboardVelocity",
  0x1b: "TxOdds",
} as const;

type Schemas = typeof streamSchemas;
type MessageName = keyof Schemas;
type Scalar = "string" | "bytes" | "bool" | "int32" | "uint32" | "int64" | "uint64" | "double";
type FieldType = Scalar | MessageName;
type Field = readonly [string, FieldType, ("repeated" | "optional" | "map")?];
type FieldValue<F extends Field> =
  F[2] extends "map" ? Record<string, string> :
  F[2] extends "repeated" ? Value<F[1]>[] :
  Value<F[1]>;
type Value<T extends FieldType> =
  T extends MessageName ? MarketStreamMessage<T> :
  T extends "string" ? string :
  T extends "bytes" ? Uint8Array :
  T extends "bool" ? boolean :
  T extends "int64" | "uint64" ? bigint :
  number;
type Presence<F extends Field> = F[2] extends "optional" ? true :
  F[2] extends "repeated" | "map" ? false :
  F[1] extends MessageName ? true : false;
type Fields<Name extends MessageName> = Schemas[Name][keyof Schemas[Name]] & Field;

/** Decoded protobuf fields in camelCase. 64-bit fields retain their exact bigint values. */
export type MarketStreamMessage<Name extends MessageName> = {
  [F in Fields<Name> as Presence<F> extends false ? F[0] : never]: FieldValue<F>
} & {
  [F in Fields<Name> as Presence<F> extends true ? F[0] : never]?: FieldValue<F>
};

type StreamMessages = typeof streamMessages;
type RawMessages = typeof rawMessages;
export type MarketStreamFrame =
  | { [Tag in keyof StreamMessages]: { tag: Tag; type: StreamMessages[Tag]; data: MarketStreamMessage<StreamMessages[Tag]> } }[keyof StreamMessages]
  | { [Tag in keyof RawMessages]: { tag: Tag; type: RawMessages[Tag]; data: Uint8Array } }[keyof RawMessages];

const textDecoder = new TextDecoder("utf-8", { fatal: true });
const textEncoder = new TextEncoder();

class Reader {
  private position = 0;
  private readonly input: Uint8Array;

  constructor(input: Uint8Array) {
    this.input = input;
  }

  get done(): boolean {
    return this.position === this.input.length;
  }

  read(size: number): Uint8Array {
    if (!Number.isSafeInteger(size) || size < 0 || size > this.input.length - this.position) {
      throw new Error("Truncated market-stream protobuf field");
    }
    const bytes = this.input.subarray(this.position, this.position + size);
    this.position += size;
    return bytes;
  }

  varint(): bigint {
    let value = 0n;
    for (let i = 0; i < 10; i++) {
      const byte = this.read(1)[0];
      if (i === 9 && byte > 1) throw new Error("Invalid market-stream protobuf varint");
      value |= BigInt(byte & 0x7f) << BigInt(i * 7);
      if (byte < 0x80) return value;
    }
    throw new Error("Invalid market-stream protobuf varint");
  }

  bytes(): Uint8Array {
    return this.read(Number(this.varint()));
  }

  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.read(8);
    else if (wire === 2) this.bytes();
    else if (wire === 5) this.read(4);
    else throw new Error("Unsupported market-stream protobuf wire type");
  }
}

function wireType(type: FieldType): number {
  if (type === "double") return 1;
  if (type === "string" || type === "bytes" || type in streamSchemas) return 2;
  return 0;
}

function readValue(reader: Reader, type: FieldType): unknown {
  if (type === "string") return textDecoder.decode(reader.bytes());
  if (type === "bytes") return reader.bytes();
  if (type === "double") {
    const value = reader.read(8);
    return new DataView(value.buffer, value.byteOffset, value.byteLength).getFloat64(0, true);
  }
  if (type in streamSchemas) return decodeMessage(type as MessageName, reader.bytes());

  const value = reader.varint();
  if (type === "int64") return BigInt.asIntN(64, value);
  if (type === "uint64") return value;
  if (type === "bool") return value !== 0n;
  if (type === "int32") return Number(BigInt.asIntN(32, value));
  return Number(BigInt.asUintN(32, value));
}

function initialValue([, type, cardinality]: Field): unknown {
  if (cardinality === "repeated") return [];
  if (cardinality === "map") return Object.create(null);
  if (cardinality === "optional" || type in streamSchemas) return undefined;
  if (type === "string") return "";
  if (type === "bytes") return new Uint8Array();
  if (type === "bool") return false;
  if (type === "uint64" || type === "int64") return 0n;
  return 0;
}

function decodeMessage(name: MessageName, payload: Uint8Array): Record<string, unknown> {
  const schema = streamSchemas[name] as Readonly<Partial<Record<number, Field>>>;
  const result: Record<string, unknown> = {};
  for (const definition of Object.values(schema)) {
    if (!definition) continue;
    const initial = initialValue(definition);
    if (initial !== undefined) result[definition[0]] = initial;
  }

  const reader = new Reader(payload);
  while (!reader.done) {
    const key = reader.varint();
    if (key < 8n || key > 0xffffffffn) throw new Error("Invalid market-stream protobuf field");
    const field = schema[Number(key >> 3n)];
    const wire = Number(key & 7n);
    if (!field) {
      reader.skip(wire);
      continue;
    }

    const [property, type, cardinality] = field;
    const expected = wireType(type);
    if (wire === 2 && expected !== 2 && cardinality === "repeated") {
      const packed = new Reader(reader.bytes());
      const values = result[property] as unknown[];
      while (!packed.done) values.push(readValue(packed, type));
      continue;
    }
    if (wire !== expected) throw new Error("Wrong market-stream protobuf wire type");

    const value = readValue(reader, type);
    if (cardinality === "map") {
      const entry = value as { key: string; value: string };
      (result[property] as Record<string, string>)[entry.key] = entry.value;
    } else if (cardinality === "repeated") {
      (result[property] as unknown[]).push(value);
    } else {
      result[property] = value;
    }
  }
  return result;
}

/** Decode a WebSocket frame. Unknown tags and unsupported synthetic versions are ignored. */
export function decodeMarketStreamFrame(input: ArrayBuffer | Uint8Array): MarketStreamFrame | undefined {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const tag = bytes[0];
  const type = streamMessages[tag as keyof StreamMessages];
  if (!type) {
    const rawType = rawMessages[tag as keyof RawMessages];
    return rawType ? { tag, type: rawType, data: bytes.subarray(1) } as MarketStreamFrame : undefined;
  }

  const versioned = tag === 0x50 || tag === 0x52 || tag === 0x53;
  if (versioned && bytes[1] !== 1) return undefined;
  return { tag, type, data: decodeMessage(type, bytes.subarray(versioned ? 2 : 1)) } as MarketStreamFrame;
}

function writeVarint(output: number[], value: bigint): void {
  let remaining = value;
  while (remaining > 127n) {
    output.push(Number(remaining & 127n) | 128);
    remaining >>= 7n;
  }
  output.push(Number(remaining));
}

function writeBytes(output: number[], field: number, bytes: Uint8Array | number[]): void {
  output.push((field << 3) | 2);
  writeVarint(output, BigInt(bytes.length));
  for (const byte of bytes) output.push(byte);
}

export type MarketStreamTopic =
  | "orderbook" | "orderbook_slow" | "trades" | "candles" | "price" | "volume" | "ticks" | "quote"
  | "synthetic" | "synthetic.snapshot" | "synthetic.quote" | "synthetic.trades"
  | "trades.enriched" | "trades.enriched.pnl" | "sports" | "sports.events" | "analytics"
  | (string & {});

export interface MarketStreamContract {
  /** Provider's subscription namespace, e.g. polymarket, synthetic, or sports. */
  provider: string;
  /** Use the id for this topic: e.g. Polymarket condition id for a book, numeric id for trades. */
  contractId: string;
}

export interface MarketStreamSubscription extends MarketStreamContract {
  topics?: readonly MarketStreamTopic[];
  candleTimeframes?: readonly number[];
}

export type MarketStreamRequest =
  | ({ type: "subscribe" } & MarketStreamSubscription)
  | ({ type: "unsubscribe"; topics?: readonly MarketStreamTopic[] } & MarketStreamContract)
  | ({ type: "fetch" } & MarketStreamContract)
  | { type: "ping"; timestampMs?: number | bigint };

const controlTags = { subscribe: 0x10, unsubscribe: 0x11, ping: 0x12, fetch: 0x16 } as const;

/** Encode a control frame. An empty subscribe topic list selects the ordinary public topics. */
export function encodeMarketStreamRequest(request: MarketStreamRequest): Uint8Array<ArrayBuffer> {
  const output: number[] = [controlTags[request.type]];
  if (request.type === "ping") {
    const timestamp = BigInt(request.timestampMs ?? Date.now());
    if (timestamp < 0n || timestamp > 0x7fffffffffffffffn) throw new RangeError("Invalid ping timestamp");
    output.push(8);
    writeVarint(output, timestamp);
    return Uint8Array.from(output);
  }

  if (!request.contractId || !request.provider) throw new TypeError("Provide a contract id and provider");
  writeBytes(output, 1, textEncoder.encode(request.contractId));
  writeBytes(output, 2, textEncoder.encode(request.provider));

  if (request.type === "subscribe" || request.type === "unsubscribe") {
    const topics = request.topics ?? [];
    if (topics.length > 16) throw new RangeError("Kairos accepts at most 16 topics per request");
    for (const topic of topics) writeBytes(output, request.type === "subscribe" ? 3 : 4, textEncoder.encode(topic));
  }

  if (request.type === "subscribe" && request.candleTimeframes?.length) {
    const timeframes = request.candleTimeframes;
    if (timeframes.length > 16 || timeframes.some((value) => !Number.isInteger(value) || value < 1 || value > 604800)) {
      throw new RangeError("Use up to 16 integer candle intervals between 1 and 604800 seconds");
    }
    const packed: number[] = [];
    for (const value of timeframes) writeVarint(packed, BigInt(value));
    writeBytes(output, 4, packed);
  }

  if (output.length > 65536) throw new RangeError("Kairos accepts control frames up to 64 KiB");
  return Uint8Array.from(output);
}

export interface MarketStreamSocketEvents {
  open: Event;
  close: Pick<CloseEvent, "code" | "reason" | "wasClean">;
  error: Event;
  message: { data: unknown };
}

/** The browser WebSocket surface used by the SDK. Node can supply an equivalent adapter. */
export interface MarketStreamSocket {
  binaryType: string;
  readonly readyState: number;
  send(data: Uint8Array<ArrayBuffer>): void;
  close(): void;
  addEventListener<K extends keyof MarketStreamSocketEvents>(type: K, listener: (event: MarketStreamSocketEvents[K]) => void): void;
}

export interface MarketStreamSocketOptions {
  protocols: string[];
  headers?: Record<string, string>;
}

export type MarketStreamSocketFactory = (url: string, options: MarketStreamSocketOptions) => MarketStreamSocket;

export type MarketStreamAuth =
  | { type: "public" }
  | { type: "jwt"; token: string }
  | { type: "apiKey"; clientId: string; apiKey: string; apiSecret: string };

export interface MarketStreamOptions {
  url?: string;
  auth?: MarketStreamAuth;
  /** Required for API-key headers or when the runtime has no standard WebSocket. */
  webSocketFactory?: MarketStreamSocketFactory;
  onOpen?: (stream: MarketStream) => void;
  onFrame?: (frame: MarketStreamFrame) => void;
  /** Transport/decoding errors. In-band server errors arrive as ErrorResponse frames. */
  onError?: (error: Error) => void;
  onClose?: (event: MarketStreamSocketEvents["close"]) => void;
}

function upgradeOptions(auth: MarketStreamAuth): MarketStreamSocketOptions {
  if (auth.type === "apiKey") {
    if (!auth.clientId || !auth.apiKey || !auth.apiSecret) throw new TypeError("Provide all three Kairos API-key fields");
    return {
      protocols: [],
      headers: { "X-Client-Id": auth.clientId, "X-Api-Key": auth.apiKey, "X-Api-Secret": auth.apiSecret },
    };
  }

  if (auth.type === "jwt") {
    if (!auth.token) throw new TypeError("Provide a Kairos session JWT");
    let binary = "";
    for (const byte of textEncoder.encode(auth.token)) binary += String.fromCharCode(byte);
    const encoded = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return { protocols: ["authorization", `Bearer_${encoded}`] };
  }
  return { protocols: [MARKET_STREAM_PUBLIC_PROTOCOL] };
}

function browserSocket(url: string, options: MarketStreamSocketOptions): MarketStreamSocket {
  if (options.headers) throw new Error("Market-stream API keys require a WebSocket factory that can set headers");
  if (typeof WebSocket === "undefined") throw new Error("No global WebSocket; pass a market-stream WebSocket factory");
  return new WebSocket(url, options.protocols);
}

/**
 * One market-data connection. Subscribe in onOpen. On disconnect, reconnect with backoff,
 * re-subscribe, and rebuild each local book from its next full snapshot.
 */
export class MarketStream {
  private readonly socket: MarketStreamSocket;

  constructor(options: MarketStreamOptions = {}) {
    const factory = options.webSocketFactory ?? browserSocket;
    this.socket = factory(options.url ?? MARKET_STREAM_URL, upgradeOptions(options.auth ?? { type: "public" }));
    this.socket.binaryType = "arraybuffer";
    this.socket.addEventListener("open", () => options.onOpen?.(this));
    this.socket.addEventListener("close", (event) => options.onClose?.(event));
    this.socket.addEventListener("error", () => options.onError?.(new Error("Market-stream WebSocket error")));
    this.socket.addEventListener("message", (event) => {
      if (!(event.data instanceof ArrayBuffer) && !(event.data instanceof Uint8Array)) return;
      let frame: MarketStreamFrame | undefined;
      try {
        frame = decodeMarketStreamFrame(event.data);
      } catch (error) {
        options.onError?.(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      if (frame) options.onFrame?.(frame);
    });
  }

  get ready(): boolean {
    return this.socket.readyState === 1;
  }

  subscribe(input: MarketStreamSubscription): void {
    this.send({ type: "subscribe", ...input });
  }

  unsubscribe(input: MarketStreamContract & { topics?: readonly MarketStreamTopic[] }): void {
    this.send({ type: "unsubscribe", ...input });
  }

  fetchSnapshot(input: MarketStreamContract): void {
    this.send({ type: "fetch", ...input });
  }

  ping(timestampMs?: number | bigint): void {
    this.send({ type: "ping", timestampMs });
  }

  close(): void {
    this.socket.close();
  }

  private send(request: MarketStreamRequest): void {
    if (!this.ready) throw new Error("Market stream is not open");
    this.socket.send(encodeMarketStreamRequest(request));
  }
}
