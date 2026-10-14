// Wire types for the Kairos external-signing lane.

export type Side = "buy" | "sell";
export type TimeInForce = "GTC" | "GTD" | "FOK" | "FAK" | "IOC";

/** Signature schemes accepted on the external lane. */
export const SIGNATURE_TYPE_EOA = 0;
export const SIGNATURE_TYPE_POLY1271 = 3;

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

/** The exact EIP-712 `Order` struct Polymarket signs (CTF Exchange V2). */
export interface PolymarketOrder {
  salt: bigint;
  maker: string;
  signer: string;
  tokenId: bigint;
  makerAmount: bigint;
  takerAmount: bigint;
  side: number; // 0 = buy, 1 = sell
  signatureType: number; // 0 = EOA, 3 = Poly1271
  timestamp: bigint;
  metadata: string; // bytes32
  builder: string; // bytes32
}

/** Caller-supplied order intent (mirrors the server's `OrderIntent`). */
export interface OrderIntent {
  token_id?: string;
  side: Side;
  price: string;
  size: string;
  time_in_force: TimeInForce;
  post_only?: boolean;
  expiration_unix_secs?: number;
  neg_risk: boolean;
  owner_address: string;
  signer_address?: string;
  signature_type?: number;
  salt?: string;
  timestamp_ms?: string;
}

export interface IntentRequest {
  provider?: "polymarket" | "predictfun";
  intent: OrderIntent;
  market_id?: string;
  outcome?: string;
  client_order_id?: string;
  expiration_minutes?: number;
  replace_order_id?: string;
  bot_id?: string;
}

export interface UnsignedPayload {
  domain: Eip712Domain;
  primary_type: string;
  types: Record<string, unknown>;
  message: Record<string, unknown>;
  eip712_digest_hex: string;
  /**
   * Present only for `signature_type: 3` (Poly1271 / deposit wallet): the
   * ERC-7739 `TypedDataSign` digest the owner EOA signs. Kairos can wrap the
   * plain 65-byte signature for current beacon wallets; pre-linked legacy
   * wallets must submit the complete envelope.
   */
  erc7739_digest_hex?: string;
}

export interface IntentResponse {
  payload_id: string;
  unsigned_payload: UnsignedPayload;
  eip712_digest_hex: string;
  expires_at_us: number;
}

export interface SubmitResponse {
  order_id: string;
  exchange_order_id: string | null;
  status: string;
}

export interface ProviderCapability {
  id: string;
  display_name: string;
  account_enabled: boolean;
  signature_schemes: string[];
  orders: { rest_two_rtt: boolean; wss_one_rtt: boolean; batch_submit: boolean };
  [key: string]: unknown;
}

export interface SiweChallengeResponse {
  nonce: string;
  message: string;
  expires_at_us: number;
}

/** A SIWE-minted API key. `expires_at` is RFC3339 UTC; the key is dead after it. */
export interface SiweCredential {
  client_id: string;
  api_key: string;
  api_secret: string;
  scopes: string[];
  address: string;
  expires_at: string;
}

export interface WalletRevokeResponse {
  revoked: boolean;
  /** SIWE keys bound to this wallet that were revoked with it. */
  revoked_api_keys: number;
}
