// EIP-712 hashing for Polymarket CTF Exchange V2 orders.
//
// Mirrors `services/order_execution/crates/order_execution_polymarket/src/
// polymarket/external_signing.rs` byte-for-byte. The digest is cross-checked
// against a pinned Rust golden value in the tests, so a wire-shape change on
// either side fails loudly.

import { keccak256, toHex, utf8, uint256, addressWord, fromHex, concat } from "./keccak.ts";
import { CTF_EXCHANGE_V2, NEG_RISK_CTF_EXCHANGE_V2 } from "./polymarket-contracts.generated.ts";
import type { Eip712Domain, IntentResponse, PolymarketOrder } from "./types.ts";

export const POLYMARKET_CHAIN_ID = 137;
export const POLYMARKET_CTF_EXCHANGE = CTF_EXCHANGE_V2;
export const POLYMARKET_NEG_RISK_CTF_EXCHANGE = NEG_RISK_CTF_EXCHANGE_V2;

export const DOMAIN_NAME = "Polymarket CTF Exchange";
export const DOMAIN_VERSION = "2";

/** The deposit wallet's own EIP-712 domain (ERC-7739 `TypedDataSign`). */
export const DEPOSIT_WALLET_DOMAIN_NAME = "DepositWallet";
export const DEPOSIT_WALLET_DOMAIN_VERSION = "1";

interface Field {
  name: string;
  type: string;
}

const ORDER_FIELDS: Field[] = [
  { name: "salt", type: "uint256" },
  { name: "maker", type: "address" },
  { name: "signer", type: "address" },
  { name: "tokenId", type: "uint256" },
  { name: "makerAmount", type: "uint256" },
  { name: "takerAmount", type: "uint256" },
  { name: "side", type: "uint8" },
  { name: "signatureType", type: "uint8" },
  { name: "timestamp", type: "uint256" },
  { name: "metadata", type: "bytes32" },
  { name: "builder", type: "bytes32" },
];

const DOMAIN_FIELDS: Field[] = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

/** `encodeType` for a struct with no referenced struct types. */
export function encodeType(primaryType: string, fields: Field[]): string {
  const inner = fields.map((f) => `${f.type} ${f.name}`).join(",");
  return `${primaryType}(${inner})`;
}

export function typeHash(primaryType: string, fields: Field[]): Uint8Array {
  return keccak256(utf8(encodeType(primaryType, fields)));
}

function encodeField(type: string, value: unknown): Uint8Array {
  if (type === "string") return keccak256(utf8(String(value)));
  if (type === "bytes32") {
    const bytes = fromHex(String(value));
    if (bytes.length !== 32) throw new Error(`bytes32 must be 32 bytes, got ${bytes.length}`);
    return bytes;
  }
  if (type === "address") return addressWord(String(value));
  if (type === "bool") return uint256(value ? 1 : 0);
  if (type.startsWith("uint") || type.startsWith("int")) return uint256(value as bigint);
  throw new Error(`unsupported EIP-712 type ${type}`);
}

/** EIP-712 `hashStruct`: keccak256(typeHash ‖ encodeData). */
export function hashStruct(
  primaryType: string,
  fields: Field[],
  message: Record<string, unknown>,
): Uint8Array {
  const parts: Uint8Array[] = [typeHash(primaryType, fields)];
  for (const f of fields) {
    if (!(f.name in message)) throw new Error(`missing EIP-712 field ${f.name}`);
    parts.push(encodeField(f.type, message[f.name]));
  }
  return keccak256(concat(...parts));
}

export function domainSeparator(domain: Eip712Domain): Uint8Array {
  return hashStruct("EIP712Domain", DOMAIN_FIELDS, domain as unknown as Record<string, unknown>);
}

/** The 32-byte digest a Polymarket owner signs for an order. */
export function polymarketOrderDigest(order: PolymarketOrder, negRisk = false): string {
  const domain: Eip712Domain = {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: POLYMARKET_CHAIN_ID,
    verifyingContract: negRisk ? POLYMARKET_NEG_RISK_CTF_EXCHANGE : POLYMARKET_CTF_EXCHANGE,
  };
  const structHash = hashStruct(
    "Order",
    ORDER_FIELDS,
    order as unknown as Record<string, unknown>,
  );
  const digest = keccak256(
    concat(new Uint8Array([0x19, 0x01]), domainSeparator(domain), structHash),
  );
  return toHex(digest);
}

function polymarketDomain(negRisk: boolean): Eip712Domain {
  return {
    name: DOMAIN_NAME,
    version: DOMAIN_VERSION,
    chainId: POLYMARKET_CHAIN_ID,
    verifyingContract: negRisk ? POLYMARKET_NEG_RISK_CTF_EXCHANGE : POLYMARKET_CTF_EXCHANGE,
  };
}

/**
 * The 32-byte digest the OWNER EOA signs for a deposit-wallet order
 * (`signatureType: 3`). This is the ERC-7739 `TypedDataSign` digest: the
 * order is re-bound to the deposit wallet's own domain (`DepositWallet` / `1`,
 * Polygon, `verifyingContract` = `order.maker` = the deposit wallet, whose
 * `isValidSignature` validates it). `order.signer` is the owner EOA that holds
 * the L2 API key. Post the plain 65-byte signature; Kairos wraps it into the
 * ERC-7739 envelope. Mirrors `erc7739_material` in the Rust implementation.
 */
export function polymarketDepositWalletDigest(order: PolymarketOrder, negRisk = false): string {
  const contentsHash = hashStruct(
    "Order",
    ORDER_FIELDS,
    order as unknown as Record<string, unknown>,
  );
  const typedDataSignType =
    "TypedDataSign(Order contents,string name,string version,uint256 chainId," +
    "address verifyingContract,bytes32 salt)" +
    encodeType("Order", ORDER_FIELDS);
  const structHash = keccak256(
    concat(
      keccak256(utf8(typedDataSignType)),
      contentsHash,
      keccak256(utf8(DEPOSIT_WALLET_DOMAIN_NAME)),
      keccak256(utf8(DEPOSIT_WALLET_DOMAIN_VERSION)),
      uint256(POLYMARKET_CHAIN_ID),
      addressWord(order.maker),
      new Uint8Array(32),
    ),
  );
  const digest = keccak256(
    concat(new Uint8Array([0x19, 0x01]), domainSeparator(polymarketDomain(negRisk)), structHash),
  );
  return toHex(digest);
}

/**
 * The digest to sign for an intent Kairos built, keyed on the signed order's
 * `signatureType`: the ERC-7739 digest for a deposit-wallet (`3`) order, the
 * bare order digest for an EOA (`0`) order. A type-3 intent without
 * `erc7739_digest_hex` is an error, never a silent fallback — signing the
 * bare digest with the owner EOA would fail `isValidSignature` anyway.
 */
export function digestToSign(intent: IntentResponse): string {
  const payload = intent.unsigned_payload;
  const signatureType = Number(payload.message.signatureType);
  if (signatureType === 3) {
    if (!payload.erc7739_digest_hex) {
      throw new Error(
        "signature_type 3 intent has no erc7739_digest_hex; the cell must supply it",
      );
    }
    return payload.erc7739_digest_hex;
  }
  if (signatureType === 0) return intent.eip712_digest_hex;
  throw new Error(`unsupported signatureType ${payload.message.signatureType} in intent`);
}

/** The typed-data object to hand to `eth_signTypedData_v4` / EIP-1193 wallets. */
export function polymarketTypedData(order: PolymarketOrder, negRisk = false): {
  domain: Eip712Domain;
  primaryType: string;
  types: Record<string, unknown>;
  message: Record<string, unknown>;
} {
  return {
    domain: {
      name: DOMAIN_NAME,
      version: DOMAIN_VERSION,
      chainId: POLYMARKET_CHAIN_ID,
      verifyingContract: negRisk ? POLYMARKET_NEG_RISK_CTF_EXCHANGE : POLYMARKET_CTF_EXCHANGE,
    },
    primaryType: "Order",
    types: {
      EIP712Domain: DOMAIN_FIELDS,
      Order: ORDER_FIELDS,
    },
    message: {
      salt: order.salt.toString(),
      maker: order.maker,
      signer: order.signer,
      tokenId: order.tokenId.toString(),
      makerAmount: order.makerAmount.toString(),
      takerAmount: order.takerAmount.toString(),
      side: order.side,
      signatureType: order.signatureType,
      timestamp: order.timestamp.toString(),
      metadata: order.metadata,
      builder: order.builder,
    },
  };
}
