// External-signing lane (/v2): build Polymarket order digests and submit signed orders yourself.
//
// Dependency-free: keccak-256 and EIP-712 are implemented in-repo so a wallet
// or dapp can consume the package without a bundler resolution step.

export {
  keccak256,
  toHex,
  fromHex,
  utf8,
  uint256,
  addressWord,
  concat,
} from "./keccak.ts";

export {
  POLYMARKET_CHAIN_ID,
  POLYMARKET_CTF_EXCHANGE,
  POLYMARKET_NEG_RISK_CTF_EXCHANGE,
  DOMAIN_NAME,
  DOMAIN_VERSION,
  encodeType,
  typeHash,
  hashStruct,
  domainSeparator,
  DEPOSIT_WALLET_DOMAIN_NAME,
  DEPOSIT_WALLET_DOMAIN_VERSION,
  polymarketOrderDigest,
  polymarketDepositWalletDigest,
  digestToSign,
  polymarketTypedData,
} from "./eip712.ts";

export {
  SIGNATURE_TYPE_EOA,
  SIGNATURE_TYPE_POLY1271,
  type Side,
  type TimeInForce,
  type Eip712Domain,
  type PolymarketOrder,
  type OrderIntent,
  type IntentRequest,
  type IntentResponse,
  type SubmitResponse,
  type UnsignedPayload,
  type ProviderCapability,
  type SiweChallengeResponse,
  type SiweCredential,
  type WalletRevokeResponse,
} from "./types.ts";

export {
  KairosExternalSigningClient,
  SIWE_REFRESH_MARGIN_MS,
  siweExpiresAtMs,
  siweNeedsRefresh,
  type ClientOptions,
  type KairosAuth,
} from "./client.ts";

export {
  submitSignedOrderOneShot,
  type WssOptions,
  type OneshotSignedOrder,
  type WebSocketLike,
  type WebSocketFactory,
} from "./wss.ts";

export {
  DELEGATION_DOMAIN_NAME,
  DELEGATION_DOMAIN_VERSION,
  DELEGATION_CHAIN_ID,
  delegationDigest,
  delegationTypedData,
  type Delegation,
} from "./delegation.ts";
