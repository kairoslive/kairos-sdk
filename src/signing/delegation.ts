// EIP-712 partner-delegation grants (KAI-858).
//
// A user signs a `Delegation` authorizing a partner app to act for them. The
// digest is cross-checked against the Rust implementation's pinned golden value.

import { keccak256, concat, toHex } from "./keccak.ts";
import { hashStruct } from "./eip712.ts";

export interface Delegation {
  user: string;
  delegate: string;
  /** Comma-separated granted scopes. */
  scopes: string;
  issuedAt: bigint;
  expiresAt: bigint;
  /** bytes32 replay nonce. */
  nonce: string;
}

export const DELEGATION_DOMAIN_NAME = "Kairos Partner Delegation";
export const DELEGATION_DOMAIN_VERSION = "1";
export const DELEGATION_CHAIN_ID = 137;

const DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
];
const DELEGATION_FIELDS = [
  { name: "user", type: "address" },
  { name: "delegate", type: "address" },
  { name: "scopes", type: "string" },
  { name: "issuedAt", type: "uint256" },
  { name: "expiresAt", type: "uint256" },
  { name: "nonce", type: "bytes32" },
];

/** The 32-byte digest a user signs for a delegation. */
export function delegationDigest(d: Delegation): string {
  const domainHash = hashStruct("EIP712Domain", DOMAIN_FIELDS, {
    name: DELEGATION_DOMAIN_NAME,
    version: DELEGATION_DOMAIN_VERSION,
    chainId: DELEGATION_CHAIN_ID,
  });
  const structHash = hashStruct(
    "Delegation",
    DELEGATION_FIELDS,
    d as unknown as Record<string, unknown>,
  );
  return toHex(keccak256(concat(new Uint8Array([0x19, 0x01]), domainHash, structHash)));
}

/** The typed-data object to hand to `eth_signTypedData_v4`. */
export function delegationTypedData(d: Delegation): {
  domain: { name: string; version: string; chainId: number };
  primaryType: string;
  types: Record<string, unknown>;
  message: Record<string, unknown>;
} {
  return {
    domain: {
      name: DELEGATION_DOMAIN_NAME,
      version: DELEGATION_DOMAIN_VERSION,
      chainId: DELEGATION_CHAIN_ID,
    },
    primaryType: "Delegation",
    types: { EIP712Domain: DOMAIN_FIELDS, Delegation: DELEGATION_FIELDS },
    message: {
      user: d.user,
      delegate: d.delegate,
      scopes: d.scopes,
      issuedAt: d.issuedAt.toString(),
      expiresAt: d.expiresAt.toString(),
      nonce: d.nonce,
    },
  };
}
