export type WebhookType =
  | "order.created" | "order.partially_filled" | "order.filled" | "order.cancelled" | "order.rejected"
  | "trade.executed" | "position.settled" | "ctf.split" | "ctf.merge" | "ctf.redeem"
  | "wallet.created" | "deposit.completed" | "withdrawal.requested" | "withdrawal.completed" | "withdrawal.failed"
  | "fee.accrued" | "payout.sent" | "usage.threshold_reached";

export interface WebhookEvent {
  id: string;
  type: WebhookType | (string & {});
  createdAt: string;
  orgId: string;
  test: boolean;
  data: Record<string, unknown>;
}

export interface WebhookVerifyOptions {
  /** Maximum allowed difference between the signature timestamp and the current time. Default 300. */
  toleranceSeconds?: number;
  /** Current time in Unix milliseconds. Default Date.now(). */
  now?: number;
}

const utf8 = new TextEncoder();
const MAX_BODY = 256 * 1024;

/** Verify Kairos-Signature against the exact bytes received by your server. */
export async function verifyWebhookSignature(
  rawBody: string | Uint8Array, header: string | null | undefined, secret: string, options: WebhookVerifyOptions = {},
): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(",").map(part => part.trim());
  const times = parts.filter(part => part.startsWith("t="));
  const signatures = parts.filter(part => part.startsWith("v1="));
  if (times.length !== 1 || signatures.length !== 1 || !/^t=[1-9]\d{0,15}$/.test(times[0]) ||
      !/^v1=[0-9a-f]{64}$/i.test(signatures[0])) return false;
  const timestamp = times[0].slice(2);
  const signature = Uint8Array.from(signatures[0].slice(3).match(/../g)!, byte => parseInt(byte, 16));
  const tolerance = options.toleranceSeconds ?? 300;
  const now = options.now ?? Date.now();
  if (!Number.isSafeInteger(Number(timestamp)) || !Number.isFinite(now) || !Number.isFinite(tolerance) ||
      tolerance < 0 || Math.abs(now / 1000 - Number(timestamp)) > tolerance) return false;
  const body = typeof rawBody === "string" ? utf8.encode(rawBody) : rawBody;
  if (body.byteLength > MAX_BODY) return false;
  const prefix = utf8.encode(`${timestamp}.`);
  const payload = new Uint8Array(prefix.length + body.length);
  payload.set(prefix);
  payload.set(body, prefix.length);
  const key = await crypto.subtle.importKey("raw", utf8.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  return crypto.subtle.verify("HMAC", key, signature, payload);
}

/** Verify first, then parse and validate the common webhook envelope. */
export async function readWebhook(
  rawBody: string | Uint8Array, header: string | null | undefined, secret: string, options?: WebhookVerifyOptions,
): Promise<WebhookEvent> {
  const body = typeof rawBody === "string" ? rawBody : new Uint8Array(rawBody);
  if (!(await verifyWebhookSignature(body, header, secret, options))) throw new Error("Invalid Kairos webhook signature");
  const event = JSON.parse(typeof body === "string" ? body : new TextDecoder("utf-8", { fatal: true }).decode(body)) as Partial<WebhookEvent> | null;
  if (!event || typeof event.id !== "string" || !event.id || typeof event.type !== "string" || !event.type ||
      typeof event.createdAt !== "string" || !Number.isFinite(Date.parse(event.createdAt)) || typeof event.orgId !== "string" ||
      typeof event.test !== "boolean" || !event.data || typeof event.data !== "object" || Array.isArray(event.data)) {
    throw new Error("Invalid Kairos webhook envelope");
  }
  return event as WebhookEvent;
}
