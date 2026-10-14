// Minimal REST client for the Kairos external-signing lane.
//
// Transport only: it does not sign. Pair it with `polymarketOrderDigest` /
// `polymarketTypedData` and your wallet of choice.

import type {
  IntentRequest,
  IntentResponse,
  ProviderCapability,
  SiweChallengeResponse,
  SiweCredential,
  SubmitResponse,
  WalletRevokeResponse,
} from "./types.ts";

export interface KairosAuth {
  /** Session JWT, sent as `Authorization: Bearer`. */
  bearer?: string;
  /** Kairos API-key triple, sent as `X-Client-Id`/`X-Api-Key`/`X-Api-Secret`. */
  apiKey?: { clientId: string; apiKey: string; apiSecret: string };
}

export interface ClientOptions {
  /** Cell/region base URL, e.g. `https://eu-west-1.exec.kairos.trade`. */
  baseUrl: string;
  auth?: KairosAuth;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

export class KairosExternalSigningClient {
  private readonly baseUrl: string;
  private readonly auth: KairosAuth;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.auth = opts.auth ?? {};
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.auth.bearer) h["authorization"] = `Bearer ${this.auth.bearer}`;
    if (this.auth.apiKey) {
      h["x-client-id"] = this.auth.apiKey.clientId;
      h["x-api-key"] = this.auth.apiKey.apiKey;
      h["x-api-secret"] = this.auth.apiKey.apiSecret;
    }
    return h;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: this.headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : {};
    if (!res.ok) {
      const message = (json && (json.error as string)) || `HTTP ${res.status}`;
      throw new Error(message);
    }
    return json as T;
  }

  /** `POST /v2/orders/intent` */
  createIntent(req: IntentRequest): Promise<IntentResponse> {
    return this.request<IntentResponse>("POST", "/v2/orders/intent", req);
  }

  /** `POST /v2/orders/intent-batch` */
  createIntentBatch(orders: IntentRequest[]): Promise<unknown> {
    return this.request("POST", "/v2/orders/intent-batch", { orders });
  }

  /** `POST /v2/orders/submit` */
  submit(payloadId: string, signatureHex: string): Promise<SubmitResponse> {
    return this.request<SubmitResponse>("POST", "/v2/orders/submit", {
      payload_id: payloadId,
      signature_hex: signatureHex,
    });
  }

  /** `POST /v2/orders/submit-batch` */
  submitBatch(items: { payload_id: string; signature_hex: string }[]): Promise<unknown> {
    return this.request("POST", "/v2/orders/submit-batch", { orders: items });
  }

  /** `POST /v2/orders/{order_id}/cancel` */
  cancelOrder(orderId: string): Promise<unknown> {
    return this.request("POST", `/v2/orders/${orderId}/cancel`);
  }

  /** `GET /v2/providers` */
  providers(): Promise<{ providers: ProviderCapability[] }> {
    return this.request("GET", "/v2/providers");
  }

  /** `GET /v2/onboarding/status` */
  onboardingStatus(): Promise<unknown> {
    return this.request("GET", "/v2/onboarding/status");
  }

  /** `GET /v2/wallets/balances` */
  balances(): Promise<unknown> {
    return this.request("GET", "/v2/wallets/balances");
  }

  /** `GET /v2/regions` */
  regions(): Promise<unknown> {
    return this.request("GET", "/v2/regions");
  }

  /** `GET /v2/health` */
  laneHealth(): Promise<unknown> {
    return this.request("GET", "/v2/health");
  }

  /**
   * `POST /v2/auth/siwe/challenge` — get the SIWE message to sign for
   * wallet-based login (KAI-857). The wallet must already be linked to a
   * Kairos account in the web app ("Link signing wallet").
   */
  siweChallenge(address: string): Promise<SiweChallengeResponse> {
    return this.request("POST", "/v2/auth/siwe/challenge", { address });
  }

  /**
   * `POST /v2/auth/siwe/verify` — exchange the signed SIWE message for a scoped
   * Kairos API key that expires at `expires_at`. Minting revokes every other
   * SIWE key bound to the same wallet. Use the returned triple as `auth.apiKey`.
   */
  siweVerify(message: string, signatureHex: string): Promise<SiweCredential> {
    return this.request("POST", "/v2/auth/siwe/verify", {
      message,
      signature_hex: signatureHex,
    });
  }

  /**
   * Challenge, sign and verify in one call. `signMessage` is an EIP-191
   * `personal_sign` over the exact message (e.g. `wallet.signMessage`).
   */
  async siweLogin(
    address: string,
    signMessage: (message: string) => Promise<string>,
  ): Promise<SiweCredential> {
    const challenge = await this.siweChallenge(address);
    const signature = await signMessage(challenge.message);
    return this.siweVerify(challenge.message, signature);
  }

  /**
   * `POST /v2/wallets/revoke` — unlink a signing wallet. Callable with a
   * `trade:execute` API key; also revokes every SIWE key bound to the wallet.
   * Linking is a web-app step and has no API-key route.
   */
  revokeWallet(address: string, provider?: string): Promise<WalletRevokeResponse> {
    return this.request("POST", "/v2/wallets/revoke", {
      address,
      ...(provider === undefined ? {} : { provider }),
    });
  }

  /** `POST /v2/partner/delegation/verify` — validate a user-signed delegation. */
  verifyDelegation(body: {
    delegation: {
      user: string;
      delegate: string;
      scopes: string;
      issued_at: number;
      expires_at: number;
      nonce: string;
    };
    signature_hex: string;
  }): Promise<{ user_id: string; delegate: string; scopes: string[]; expires_at: number }> {
    return this.request("POST", "/v2/partner/delegation/verify", body);
  }
}

/** Default refresh margin: re-run SIWE once less than this remains. */
export const SIWE_REFRESH_MARGIN_MS = 60 * 60 * 1000;

/** Expiry of a SIWE-minted key, in epoch milliseconds. */
export function siweExpiresAtMs(credential: Pick<SiweCredential, "expires_at">): number {
  const ms = Date.parse(credential.expires_at);
  if (Number.isNaN(ms)) {
    throw new Error(`invalid SIWE expires_at: ${credential.expires_at}`);
  }
  return ms;
}

/**
 * True when the key expires within `marginMs` (default 1h). Re-run `siweLogin`
 * and switch to the new triple; the old key is revoked once the new one is minted.
 */
export function siweNeedsRefresh(
  credential: Pick<SiweCredential, "expires_at">,
  nowMs: number = Date.now(),
  marginMs: number = SIWE_REFRESH_MARGIN_MS,
): boolean {
  return siweExpiresAtMs(credential) - nowMs <= marginMs;
}
