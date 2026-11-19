import { createHmac } from "node:crypto";
import assert from "node:assert/strict";
import { test } from "node:test";
import { readWebhook, verifyWebhookSignature } from "../src/index.ts";

const secret = "whsec_example";
const ts = 1794225600;
const now = ts * 1000;
const text = '{"id":"event","type":"order.filled","createdAt":"2026-11-09T12:00:00.000Z","orgId":"org","test":false,"data":{"label":"é ☃"}}\n';
const body = new TextEncoder().encode(text);
const signed = (raw: Uint8Array) => `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.`).update(raw).digest("hex")}`;

test("webhook verification authenticates the raw bytes before parsing", async () => {
  const event = await readWebhook(body, signed(body), secret, { now });
  assert.equal(event.type, "order.filled");
  assert.deepEqual(event.data, { label: "é ☃" });
  assert.equal(await verifyWebhookSignature(text.trim(), signed(body), secret, { now }), false);
  assert.equal(await verifyWebhookSignature(body, signed(body), secret, { now: now + 301_000 }), false);
  assert.equal(await verifyWebhookSignature(body, `${signed(body)},t=${ts}`, secret, { now }), false);
  assert.equal(await verifyWebhookSignature(body, signed(body), "example", { now }), false);
});
