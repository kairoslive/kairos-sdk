import { test } from "node:test";
import assert from "node:assert/strict";

import { canonicalJson, isTransient, requestHash, retryTransient, uintValue } from "../src/common.ts";
import { KairosError } from "../src/index.ts";

test("canonicalJson: sorts keys by UTF-16 code units, no whitespace, and refuses what the server refuses", () => {
  assert.equal(canonicalJson({ b: [1, { z: null, a: true }], a: "é\n", "\u{1F600}": 0, "￿": 1 }), '{"a":"é\\n","b":[1,{"a":true,"z":null}],"\u{1F600}":0,"￿":1}');
  assert.throws(() => canonicalJson({ n: 1.5 }), /safe integers/);
  assert.throws(() => canonicalJson({ n: 2 ** 53 }), /safe integers/);
  assert.throws(() => canonicalJson({ n: undefined }), /not JSON/);
});

test("requestHash: typed data is canonicalized inside the request, so key order and spacing do not matter", () => {
  const a = { method: "eth_signTypedData_v4", params: ["0xab", '{"message":{"b":1,"a":2},"domain":{}}'] };
  const b = { method: "eth_signTypedData_v4", params: ["0xab", '{ "domain": {}, "message": { "a": 2, "b": 1 } }'] };
  assert.equal(requestHash(a), requestHash(b));
  assert.notEqual(requestHash(a), requestHash({ ...a, params: ["0xac", a.params[1]] }));
});

test("uintValue: numbers, decimal and hex strings; nothing else", () => {
  assert.equal(uintValue(137), 137n);
  assert.equal(uintValue("137"), 137n);
  assert.equal(uintValue("0x89"), 137n);
  for (const bad of ["", "01", "-1", "1.0", 1.5, -1, null, "0x"]) assert.equal(uintValue(bad), undefined, String(bad));
});

test("retryTransient: repeats network drops and gateway errors until the deadline, never a definitive answer", async () => {
  assert.ok(isTransient(new TypeError("fetch failed")) && isTransient(new KairosError(503, "x", {})) && !isTransient(new KairosError(409, "x", {})) && !isTransient(new KairosError(500, "x", {})));
  let n = 0;
  assert.equal(await retryTransient(async () => (++n < 3 ? Promise.reject(new KairosError(429, "slow", {})) : "ok"), Date.now() + 5000, 1), "ok");
  n = 0;
  await assert.rejects(retryTransient(async () => (++n, Promise.reject(new KairosError(400, "bad", {}))), Date.now() + 5000, 1), /bad/);
  assert.equal(n, 1);
  await assert.rejects(retryTransient(() => Promise.reject(new TypeError("down")), Date.now() + 50, 1), /down/);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error("stop")), 20);
  await assert.rejects(retryTransient(() => Promise.reject(new TypeError("down")), Date.now() + 60_000, 1000, controller.signal), /stop/);
});
