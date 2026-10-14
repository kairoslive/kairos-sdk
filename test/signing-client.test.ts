import { test } from "node:test";
import assert from "node:assert/strict";

import {
  KairosExternalSigningClient,
  SIWE_REFRESH_MARGIN_MS,
  siweExpiresAtMs,
  siweNeedsRefresh,
} from "../src/signing/client.ts";

test("client sends the expected request shape and auth headers", async () => {
  const calls: Array<{ url: string; init: any }> = [];
  const fakeFetch = async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(
      JSON.stringify({
        payload_id: "p1",
        eip712_digest_hex: "0x",
        unsigned_payload: {},
        expires_at_us: 0,
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  const client = new KairosExternalSigningClient({
    baseUrl: "https://cell.example/",
    auth: { bearer: "jwt" },
    fetchImpl: fakeFetch as unknown as typeof fetch,
  });
  const res = await client.createIntent({
    intent: {
      side: "buy",
      price: "0.5",
      size: "1",
      time_in_force: "GTC",
      neg_risk: false,
      owner_address: "0x1111111111111111111111111111111111111111",
    },
    market_id: "m",
    outcome: "Yes",
  });
  assert.equal(res.payload_id, "p1");
  assert.equal(calls[0]!.url, "https://cell.example/v2/orders/intent");
  assert.equal(calls[0]!.init.method, "POST");
  assert.equal(calls[0]!.init.headers.authorization, "Bearer jwt");
  const body = JSON.parse(calls[0]!.init.body);
  assert.equal(body.intent.side, "buy");
});

test("client surfaces server error messages", async () => {
  const fakeFetch = async () =>
    new Response(JSON.stringify({ error: "not allow-listed" }), { status: 403 });
  const client = new KairosExternalSigningClient({
    baseUrl: "https://cell.example",
    fetchImpl: fakeFetch as unknown as typeof fetch,
  });
  await assert.rejects(() => client.providers(), /not allow-listed/);
});

test("API-key triple is sent when configured", async () => {
  const calls: Array<{ url: string; init: any }> = [];
  const fakeFetch = async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ providers: [] }), { status: 200 });
  };
  const client = new KairosExternalSigningClient({
    baseUrl: "https://cell.example",
    auth: { apiKey: { clientId: "c", apiKey: "k", apiSecret: "s" } },
    fetchImpl: fakeFetch as unknown as typeof fetch,
  });
  await client.providers();
  assert.equal(calls[0]!.init.headers["x-client-id"], "c");
  assert.equal(calls[0]!.init.headers["x-api-key"], "k");
  assert.equal(calls[0]!.init.headers["x-api-secret"], "s");
});

test("SIWE challenge/verify hit the right routes", async () => {
  const calls: Array<{ url: string; init: any }> = [];
  const fakeFetch = async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  const client = new KairosExternalSigningClient({
    baseUrl: "https://cell.example",
    fetchImpl: fakeFetch as unknown as typeof fetch,
  });
  await client.siweChallenge("0xabc");
  await client.siweVerify("msg", "0xsig");
  assert.equal(calls[0]!.url, "https://cell.example/v2/auth/siwe/challenge");
  assert.equal(JSON.parse(calls[0]!.init.body).address, "0xabc");
  assert.equal(calls[1]!.url, "https://cell.example/v2/auth/siwe/verify");
  assert.equal(JSON.parse(calls[1]!.init.body).signature_hex, "0xsig");
});

test("SIWE verify exposes expires_at and siweLogin signs the challenge message", async () => {
  const calls: Array<{ url: string; init: any }> = [];
  const fakeFetch = async (url: string, init: any) => {
    calls.push({ url, init });
    const body = url.endsWith("/challenge")
      ? { nonce: "n1", message: "sign me", expires_at_us: 1 }
      : {
          client_id: "kairos_ck_x",
          api_key: "k",
          api_secret: "s",
          scopes: ["trade:execute"],
          address: "0xabc",
          expires_at: "2026-10-02T12:00:00Z",
        };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const client = new KairosExternalSigningClient({
    baseUrl: "https://cell.example",
    fetchImpl: fakeFetch as unknown as typeof fetch,
  });
  const signed: string[] = [];
  const cred = await client.siweLogin("0xabc", async (message) => {
    signed.push(message);
    return "0xsig";
  });
  assert.deepEqual(signed, ["sign me"]);
  assert.equal(JSON.parse(calls[1]!.init.body).message, "sign me");
  assert.equal(cred.expires_at, "2026-10-02T12:00:00Z");
  assert.equal(siweExpiresAtMs(cred), Date.parse("2026-10-02T12:00:00Z"));
});

test("siweNeedsRefresh fires inside the margin and rejects a bad timestamp", () => {
  const cred = { expires_at: "2026-10-02T12:00:00Z" };
  const expiry = Date.parse(cred.expires_at);
  assert.equal(siweNeedsRefresh(cred, expiry - 2 * SIWE_REFRESH_MARGIN_MS), false);
  assert.equal(siweNeedsRefresh(cred, expiry - SIWE_REFRESH_MARGIN_MS), true);
  assert.equal(siweNeedsRefresh(cred, expiry + 1), true);
  assert.equal(siweNeedsRefresh(cred, expiry - 10_000, 5_000), false);
  assert.throws(() => siweNeedsRefresh({ expires_at: "soon" }), /invalid SIWE expires_at/);
});

test("revokeWallet posts to the revoke route and there is no API-key link route", async () => {
  const calls: Array<{ url: string; init: any }> = [];
  const fakeFetch = async (url: string, init: any) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ revoked: true, revoked_api_keys: 1 }), { status: 200 });
  };
  const client = new KairosExternalSigningClient({
    baseUrl: "https://cell.example",
    auth: { apiKey: { clientId: "c", apiKey: "k", apiSecret: "s" } },
    fetchImpl: fakeFetch as unknown as typeof fetch,
  });
  const res = await client.revokeWallet("0xabc", "polymarket");
  assert.equal(res.revoked, true);
  assert.equal(res.revoked_api_keys, 1);
  assert.equal(calls[0]!.url, "https://cell.example/v2/wallets/revoke");
  assert.deepEqual(JSON.parse(calls[0]!.init.body), { address: "0xabc", provider: "polymarket" });
  const methods = Object.getOwnPropertyNames(KairosExternalSigningClient.prototype);
  assert.ok(!methods.some((m) => /register|walletChallenge/i.test(m)), methods.join(","));
});
