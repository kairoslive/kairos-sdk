import { test } from "node:test";
import assert from "node:assert/strict";

import { keccak256, toHex, utf8, uint256, addressWord, fromHex } from "../src/signing/keccak.ts";

test("keccak256 known-answer vectors", () => {
  assert.equal(
    toHex(keccak256(new Uint8Array())),
    "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
  );
  assert.equal(
    toHex(keccak256(utf8("abc"))),
    "0x4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45",
  );
  assert.equal(
    toHex(keccak256(utf8("The quick brown fox jumps over the lazy dog"))),
    "0x4d741b6f1eb29cb2a9b9911c82f56fa8d73b04959d3d9d222895df6c0b28aa15",
  );
});

test("keccak256 handles multi-block input (rate = 136 bytes)", () => {
  // 200 bytes crosses the 136-byte rate boundary, exercising the absorb loop.
  const input = new Uint8Array(200).fill(0x61);
  const digest = keccak256(input);
  assert.equal(digest.length, 32);
  // Deterministic and different from the empty digest.
  assert.notEqual(toHex(digest), toHex(keccak256(new Uint8Array())));
  assert.equal(toHex(digest), toHex(keccak256(input)));
});

test("uint256 pads to 32 bytes big-endian", () => {
  assert.equal(toHex(uint256(1n)), "0x" + "00".repeat(31) + "01");
  assert.equal(toHex(uint256(255n)), "0x" + "00".repeat(31) + "ff");
  assert.equal(toHex(uint256("256")), "0x" + "00".repeat(30) + "0100");
});

test("addressWord left-pads a 20-byte address", () => {
  const w = addressWord("0x1111111111111111111111111111111111111111");
  assert.equal(w.length, 32);
  assert.equal(toHex(w), "0x" + "00".repeat(12) + "11".repeat(20));
});

test("fromHex round-trips and rejects malformed input", () => {
  assert.equal(toHex(fromHex("0xdeadbeef")), "0xdeadbeef");
  assert.throws(() => fromHex("0xabc"));
});

test("fromHex rejects a valid nibble followed by garbage", () => {
  // `Number.parseInt("2g", 16)` is 2, so a per-byte NaN check would accept
  // these and silently hash the wrong bytes.
  for (const bad of ["0x2g", "0xzz", "0x0g", "2g", "0x12 34", "0x-1", "0x1.2"]) {
    assert.throws(() => fromHex(bad), /invalid hex|odd-length hex/, `should reject ${bad}`);
  }
  // Uppercase hex is still accepted.
  assert.equal(toHex(fromHex("0xDEADBEEF")), "0xdeadbeef");
  // Empty input is an empty byte array, not an error.
  assert.equal(fromHex("0x").length, 0);
});
