import { test } from "node:test";
import assert from "node:assert/strict";

import { ActionFailedError, WalletClient } from "../src/index.ts";
import { TOKEN, WALLET, fakeFetch, fakeWallet, loginRoutes, step } from "./helpers.ts";

const LEGS = ["1078074005957064877446010903918736856257842014237288812371245491856108159488", "1149090695757034302400438834666963468845649076254647140902232654553204916480"];
const order = (n: number) => ({ method: "eth_signTypedData_v4", params: [WALLET, `{"quote":${n}}`] });

test("combo: sends amounts and limits as strings, and signs a refreshed quote under the same action", async () => {
  const fill = { side: "buy", price: "0.5", shares: "2", rfqId: "rfq-2", status: "CONFIRMED", transactionHash: "0xab" };
  let answers = 0;
  const { impl, calls } = fakeFetch([
    (c) => (c.method === "POST" && c.path === "/v3/actions" ? [200, step({ id: "c1", type: "combo", status: "needs_signature", request: order(1), chainId: "0x89" })] : undefined),
    (c) =>
      c.method === "POST" && c.path === "/v3/actions/c1"
        ? [200, ++answers === 1 ? step({ id: "c1", type: "combo", status: "needs_signature", request: order(2), chainId: "0x89", description: "fresh quote" }) : step({ id: "c1", type: "combo", status: "done", result: fill })]
        : undefined,
  ]);
  const wallet = fakeWallet();
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: wallet.provider, fetch: impl, pollIntervalMs: 1 });
  const out = await client.combo(WALLET, { legs: LEGS, side: "buy", amount: 10, maxPrice: 0.55 });
  assert.deepEqual(calls[0].body, { wallet: WALLET, action: { type: "combo", legs: LEGS, side: "buy", amount: "10", maxPrice: "0.55" } });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.path}`), ["POST /v3/actions", "POST /v3/actions/c1", "POST /v3/actions/c1"]);
  assert.equal(wallet.methods().filter((m) => m === "eth_signTypedData_v4").length, 2, "the refreshed quote is signed again");
  assert.deepEqual(out, fill);
});

test("combo: a cash-out sends minProceeds and never maxPrice", async () => {
  const { impl, calls } = fakeFetch([() => [200, step({ id: "c1", type: "combo", status: "done", result: { side: "sell" } })]]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl });
  await client.combo(WALLET, { legs: LEGS, side: "sell", amount: "1.932381", minProceeds: "1.5" });
  assert.deepEqual(calls[0].body, { wallet: WALLET, action: { type: "combo", legs: LEGS, side: "sell", amount: "1.932381", minProceeds: "1.5" } });
});

test("combo: every quote lapsing surfaces SIGNATURE_EXPIRED as ActionFailedError", async () => {
  const { impl } = fakeFetch([
    (c) => (c.path === "/v3/actions" ? [200, step({ id: "c1", type: "combo", status: "needs_signature", request: order(1), chainId: "0x89" })] : undefined),
    () => [200, step({ id: "c1", type: "combo", status: "failed", error: "each quote expired", errorCode: "SIGNATURE_EXPIRED" })],
  ]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl });
  await assert.rejects(client.combo(WALLET, { legs: LEGS, side: "buy", amount: 1 }), (e: unknown) => e instanceof ActionFailedError && e.step.errorCode === "SIGNATURE_EXPIRED");
});

test("comboQuote: one action, nothing signed", async () => {
  const quote = { side: "buy", price: "0.5", cost: "1", kairosFee: "0.01", totalCost: "1.01" };
  const { impl, calls } = fakeFetch([() => [200, step({ id: "q1", type: "comboQuote", status: "done", result: quote })]]);
  const wallet = fakeWallet();
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: wallet.provider, fetch: impl });
  assert.deepEqual(await client.comboQuote(WALLET, { legs: LEGS, side: "buy", amount: 1 }), quote);
  assert.deepEqual(calls[0].body, { wallet: WALLET, action: { type: "comboQuote", legs: LEGS, side: "buy", amount: "1" } });
  assert.equal(wallet.requests.length, 0);
});

test("combos: logs in, then reads the wallet's combos with the token", async () => {
  const combos = [{ market: "polymarket:0x03ab00", comboConditionId: "0x03ab", comboPositionId: "1", sharesBalance: "2", totalCostUsdc: "1", status: "OPEN", redeemable: false, legsPending: 2, legs: [] }];
  const { impl, calls } = fakeFetch([...loginRoutes(), (c) => (c.method === "GET" && c.path === `/v3/wallets/${WALLET}/combos` ? [200, { tradingWallet: "0x1d3e", combos }] : undefined)]);
  const client = new WalletClient({ baseUrl: "https://exec.test", partnerId: "acme", provider: fakeWallet().provider, fetch: impl });
  assert.deepEqual(await client.combos(WALLET), combos);
  const read = calls.find((c) => c.path.endsWith("/combos"))!;
  assert.equal(read.headers.authorization, `SIWE ${TOKEN.token}`);
});
