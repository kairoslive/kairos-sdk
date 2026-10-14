import { test } from "node:test";
import assert from "node:assert/strict";

import {
  digestToSign,
  polymarketDepositWalletDigest,
  polymarketOrderDigest,
  polymarketTypedData,
} from "../src/signing/eip712.ts";
import type { PolymarketOrder } from "../src/signing/types.ts";

const ZERO32 = "0x" + "00".repeat(32);
// Pinned by `order_digest_golden_is_stable_for_ts_sdk_crosscheck` in the Rust
// implementation. If this fails, the TS and Rust wire shapes have diverged.
const GOLDEN = "0x93f052d1a9cbb868cacbc1c1fe9fc4cf5e021f506a658d5f5c4f3fabc744b9fc";

function goldenOrder(): PolymarketOrder {
  return {
    salt: 1n,
    maker: "0x1111111111111111111111111111111111111111",
    signer: "0x1111111111111111111111111111111111111111",
    tokenId: 1n,
    makerAmount: 500000n,
    takerAmount: 1000000n,
    side: 0,
    signatureType: 0,
    timestamp: 0n,
    metadata: ZERO32,
    builder: ZERO32,
  };
}

test("order digest matches the pinned Rust golden value", () => {
  assert.equal(polymarketOrderDigest(goldenOrder()), GOLDEN);
});

// Pinned by `erc7739_digest_golden_is_stable_for_ts_sdk_crosscheck` in the
// Rust implementation: the golden order with signatureType 3, signer = the
// deposit wallet. If this fails, the ERC-7739 construction has diverged.
const GOLDEN_ERC7739 = "0x9f6fbf0ef7173b522a98b6e5785be099edb4fb36a19d87f486a2c64e921eeed6";

test("deposit-wallet digest matches the pinned Rust golden value", () => {
  const order = { ...goldenOrder(), signatureType: 3 };
  assert.equal(polymarketDepositWalletDigest(order), GOLDEN_ERC7739);
  // It is a different digest from the bare order digest the wallet validates.
  assert.notEqual(polymarketDepositWalletDigest(order), polymarketOrderDigest(order));
  // Bound to the deposit wallet (maker): changing the maker moves it.
  const otherMaker = { ...order, maker: "0x2222222222222222222222222222222222222222" };
  assert.notEqual(polymarketDepositWalletDigest(otherMaker), GOLDEN_ERC7739);
  // The signer (owner EOA) is inside the order struct, so it also moves the
  // digest — but via contents, not the verifying contract.
  const otherSigner = { ...order, signer: "0x3333333333333333333333333333333333333333" };
  assert.notEqual(polymarketDepositWalletDigest(otherSigner), GOLDEN_ERC7739);
});

test("digestToSign keys on signatureType and never falls back", () => {
  const base = {
    payload_id: "p",
    eip712_digest_hex: "0xaa",
    expires_at_us: 0,
    unsigned_payload: {
      domain: { name: "", version: "", chainId: 137, verifyingContract: "0x" },
      primary_type: "Order",
      types: {},
      message: { signatureType: 0 },
      eip712_digest_hex: "0xaa",
    },
  };
  assert.equal(digestToSign(base), "0xaa");

  const dw = {
    ...base,
    unsigned_payload: {
      ...base.unsigned_payload,
      message: { signatureType: 3 },
      erc7739_digest_hex: "0xbb",
    },
  };
  assert.equal(digestToSign(dw), "0xbb");

  // A type-3 intent missing the field is an error, not a wrong-digest signature.
  const skewed = {
    ...base,
    unsigned_payload: { ...base.unsigned_payload, message: { signatureType: 3 } },
  };
  assert.throws(() => digestToSign(skewed), /erc7739_digest_hex/);
  const unknown = {
    ...base,
    unsigned_payload: { ...base.unsigned_payload, message: { signatureType: 1 } },
  };
  assert.throws(() => digestToSign(unknown), /unsupported signatureType/);
});

test("neg-risk selects a different verifying contract and digest", () => {
  assert.notEqual(polymarketOrderDigest(goldenOrder(), true), GOLDEN);
});

test("typed data shape is wallet-consumable", () => {
  const td = polymarketTypedData(goldenOrder());
  assert.equal(td.primaryType, "Order");
  assert.equal(td.domain.chainId, 137);
  assert.equal((td.types.Order as unknown[]).length, 11);
  assert.equal(td.message.salt, "1");
  assert.equal(td.message.makerAmount, "500000");
  assert.equal(td.message.takerAmount, "1000000");
});

test("a missing field is rejected rather than silently hashed", () => {
  const bad = goldenOrder() as unknown as Record<string, unknown>;
  delete bad.salt;
  assert.throws(() => polymarketOrderDigest(bad as unknown as PolymarketOrder), /missing EIP-712 field salt/);
});
