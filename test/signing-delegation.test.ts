import { test } from "node:test";
import assert from "node:assert/strict";

import { delegationDigest, delegationTypedData, type Delegation } from "../src/signing/delegation.ts";

// Pinned by `delegation_digest_golden_is_stable_for_ts_crosscheck` in the Rust
// implementation. A mismatch means the TS and Rust wire shapes diverged.
const GOLDEN = "0xa4be3ff282490027a8a9e5fd00bb962dede0c57be83637390068226c98e9fdc9";

function fixture(): Delegation {
  return {
    user: "0x1111111111111111111111111111111111111111",
    delegate: "0x2222222222222222222222222222222222222222",
    scopes: "trade:execute",
    issuedAt: 1700000000n,
    expiresAt: 1700003600n,
    nonce: "0x" + "11".repeat(32),
  };
}

test("delegation digest matches the pinned Rust golden value", () => {
  assert.equal(delegationDigest(fixture()), GOLDEN);
});

test("typed data is wallet-consumable and omits verifyingContract", () => {
  const td = delegationTypedData(fixture());
  assert.equal(td.primaryType, "Delegation");
  assert.equal(td.domain.chainId, 137);
  assert.ok(!("verifyingContract" in td.domain), "Rust domain has no verifyingContract");
  assert.equal((td.types.Delegation as unknown[]).length, 6);
  assert.equal(td.message.issuedAt, "1700000000");
  assert.equal(td.message.nonce, "0x" + "11".repeat(32));
});

test("tampering the delegate changes the digest", () => {
  const d = fixture();
  d.delegate = "0x3333333333333333333333333333333333333333";
  assert.notEqual(delegationDigest(d), GOLDEN);
});
