# Kairos SDK

One TypeScript package for Kairos market data, Discover, streaming, trading, self-custody wallets, and external signing. No runtime dependencies, works in browsers and Node 20+.

```bash
npm install @kairos.trade/sdk
```

## Market data

Public, no key.

```ts
import { createKairos } from '@kairos.trade/sdk'

const kairos = createKairos()

const { markets, next_cursor } = await kairos.markets.list('polymarket', { limit: 20 })
const market = await kairos.markets.get('polymarket', markets[0].market_id)
const candles = await kairos.markets.candles({
  provider: 'polymarket',
  contractId: market.condition_id!,
  timeframeSeconds: 3600,
  start: new Date(Date.now() - 86_400_000),
  end: new Date(),
})

for await (const m of kairos.markets.all('kalshi')) {
  // every market, page by page
}
```

Market data prices are on a 0–100 scale. Orders use 0–1.

## Discover and matched events

```ts
const all = await kairos.data.discover({ category: 'sports', limit: 25 })
const matched = await kairos.markets.events.list({
  status: ['upcoming', 'live'],
  executableVenue: ['polymarket', 'predictfun'],
  sort: 'start_time',
})

const market = matched.events[0]?.markets?.[0]
if (market) {
  const detail = await kairos.markets.events.market(market.id)
  console.log(detail.market.outcomes.yes, detail.market.route.market)
}
```

`data.discover` includes single-venue listings. `markets.events` groups linked markets by event and supplies canonical outcomes, routing references and synthetic book IDs. Market-level executable venues depend on Kairos' catalogue, and wallet readiness depends on `wallet.status`. Use `markets.events.all()` to follow cursors or `markets.events.lookup(['predictfun:…'])` to find a match and its canonical side.

## Live market data

```ts
const stream = kairos.stream({
  onOpen: (live) => live.subscribe({
    provider: 'synthetic',
    contractId: market.books.yes,
    topics: ['synthetic.quote'],
  }),
  onFrame: (frame) => {
    if (frame.type === 'SyntheticQuote') console.log(frame.data.bestAsk, frame.data.priceUnitExponent)
  },
})
// Close the connection when the UI no longer needs it.
stream.close()
```

The stream handles anonymous, bearer-token and server API-key access. Frames retain 64-bit values as `bigint`. Reopen after a disconnect and build order books from fresh snapshots before applying deltas.

## Trading API

The [Trading API](https://docs.kairos.trade/guides/cross-venue-routing) uses the authenticated account's own venue connections. Its route and combo calls are separate from self-custody wallet actions. Keep API-key secrets on the server.

```ts
const kairos = createKairos({
  execution: { auth: { apiKey: { clientId, apiKey, apiSecret } } },
})
const ref = { provider: 'polymarket', market_id: '0x…' }
const quote = await kairos.execution.routeQuote({ ...ref, side: 'yes', quantity: '50' })
// Review the quote before routeBuy, and track the parent with routes().
```

`execution` also exposes route fee checks, linked-market preview/confirmation, routed close, and combo quote, buy, cash-out and redeem. `data.request`, `markets.request` and `execution.request` accept the paths, methods and inputs from their published OpenAPI specs and infer JSON responses. Use `.response` for response headers or binary bodies.

## Partner webhooks

```ts
import { readWebhook } from '@kairos.trade/sdk'

const rawBody = new Uint8Array(await request.arrayBuffer())
const event = await readWebhook(rawBody, request.headers.get('Kairos-Signature'), endpointSecret)
// Deduplicate using event.id before applying it.
```

## Trader stats

Public, no key. Positions with realized and unrealized P&L, including closed ones, plus lifetime totals.

```ts
const { tradingWallet } = await kairos.wallet.status(wallet)

const { performance, open_positions, closed_positions } = await kairos.traders.positions(tradingWallet)
console.log(performance.total_realized_pnl, performance.win_rate)

for await (const p of kairos.traders.closedPositions(tradingWallet)) {
  // every closed position: entry_price, realized_pnl, closed_at…
}
```

Pass the **trading wallet**, not the signing wallet: that's the address that holds the shares. The wallet API's `positions` read drops a position's P&L once it closes; this keeps it. Rate limited to 30 requests a minute per IP.

## Wallet trading

For wallets and apps whose users sign with their own wallet. Kairos sends what to sign, the wallet signs it, the SDK sends it back. Users need no Kairos account.

```ts
const kairos = createKairos({
  wallet: {
    baseUrl: 'https://<your-kairos-node>',
    partnerId: '<your-partner-id>',
    provider: window.ethereum, // any EIP-1193 provider
    onStep: (step) => showToast(step.description), // optional
  },
})

const wallet = '0x…' // the connected address

await kairos.wallet.setup(wallet) // once per wallet; safe to repeat
const { tradingWallet, next } = await kairos.wallet.status(wallet) // next === 'fund' → send pUSD to tradingWallet

const { orderId } = await kairos.wallet.order(wallet, {
  market: market.condition_id!, // Polymarket condition id
  outcome: 'Yes',
  side: 'buy',
  price: '0.42',
  size: '10',
})

// Reads need a sign-in: the first read asks the wallet for one `personal_sign`.
const open = await kairos.wallet.orders(wallet, { open: true })
const { positions, resolved } = await kairos.wallet.positions(wallet)

await kairos.wallet.cancel(wallet, [orderId])
await kairos.wallet.cancelAll(wallet)
```

Each action asks the wallet for one `eth_signTypedData_v4` signature per step and returns the action's result.

`orders` and `positions` are private. The first read runs a `login` action: the wallet signs one Sign-In with Ethereum message (`personal_sign`), and the signed message becomes a read-only token sent as `Authorization: SIWE <token>`. Kairos checks it by signature alone and stores nothing, so a token cannot be revoked early; it just expires. The wallet must be set up first. The token lasts 24 hours; the SDK signs in again when it expires. To skip the prompt in a new session, keep the token from `onLogin` and pass it back with `useCredentials(wallet, token)`. It can only read, never trade.

| Error | Means |
|---|---|
| `ActionFailedError` | The action failed. `error.message` says why, and `errorCode` gives a code when there is one (`NO_MATCH`, `VENUE_REJECTED`, `SIGNATURE_EXPIRED`…). Start a new action to retry |
| `ActionFailedError` with `outcomeUnknown` | The order or cancel may still have happened (`ORDER_OUTCOME_UNKNOWN`, `CANCEL_OUTCOME_UNKNOWN`). Check `orders(wallet, { open: true })` before retrying |
| `KairosError` with `status` | The request was refused (`400` bad input, `401` missing or expired sign-in, `403` unknown partner or disabled wallet, `404` not the signed-in wallet, `409` not set up or linked to a Kairos account, `429` slow down, `503` unavailable right now). `code` gives a code when the server sent one |
| `KairosError` with `outcomeUnknown` | A `500`, `502`, `504` or `408`: the request may have taken effect. Check open orders before retrying |

Get your partner id and base URL from Kairos.

`orders` and `positions` return the rows from every venue Kairos could read. `ordersPage` and `positionsPage` also return `venueDetail`, which names any venue that failed. Every method takes `{ signal }` to abort it, and you can pass `signal` to the client too. A held order is polled again at its `holdUntilMs`.

### Best price across venues

When a market is linked on several venues, `routedOrder` buys at the best all-in price across them. The wallet signs one ordinary order per venue, cheapest first, switching chains as each venue needs.

```ts
const result = await kairos.wallet.routedOrder(wallet, {
  market: 'polymarket:0x…', // any linked venue's market
  outcome: 'Yes',
  size: '50', // shares to receive, across all venues
  maxPrice: '0.35', // optional: highest price per share, venue fees included
  clientOrderId: 'acme-route-41', // optional: the same id returns the same action (409 once it has expired)
}, {
  approveRoute: (plan) => showRouteConfirmation(plan), // resolves true to sign
})
// result.legs: [{ venue: 'predictfun', status: 'placed', orderId: '…' }, { venue: 'polymarket', status: 'failed', errorCode: 'NO_MATCH' }]
```

Buys only. To review in a separate screen, call `prepareRoutedOrder` and pass the returned step to `resumeAction` after confirmation. Use the matched catalog's `route.market` and canonical `Yes` or `No` when you start from `markets.events`. Each step carries the whole plan in `step.route` and its place in `step.leg` (`{ index, of }`, 1-based), so `onStep` can show it before each signature. One leg failing doesn't stop the others. If at least one leg is placed it returns the result: check each leg's `status`, and read the wallet's orders before buying again after an `unknown` leg. If none is placed it throws `ActionFailedError`; `e.step.result` still lists every leg, and `e.outcomeUnknown` is true when one may be live. A market that can't be routed throws `KairosError` (`422`; with code `ROUTE_UNAVAILABLE` when no venue can take a leg right now, and the plan's `notes` in `e.body.route`).

### Polymarket combos

The Partner API combo preview is available on staging. A combo (parlay) joins 2–10 Polymarket outcomes; it pays $1 a share only if every leg wins. Kairos gets a maker quote and the wallet signs the order that accepts it.

```ts
const quote = await kairos.wallet.comboQuote(wallet, { legs: [leg1, leg2], side: 'buy', amount: '10' }) // nothing signed
const fill = await kairos.wallet.combo(wallet, { legs: [leg1, leg2], side: 'buy', amount: '10', maxPrice: '0.55' })
const [combo] = await kairos.wallet.combos(wallet)
await kairos.wallet.combo(wallet, { legs: combo.legs.map((l) => l.legPositionId), side: 'sell', amount: combo.sharesBalance })
// once combo.redeemable: kairos.wallet.onchain.redeem(wallet, combo.market, sharesRaw, { outcome: 0 })
```

Quotes last about 5 seconds. A signature that arrives later gets a fresh quote under the same `maxPrice`/`minProceeds` and a new prompt, up to 3 times, then `SIGNATURE_EXPIRED`.

### Server-side: your API key instead of a partner id

```ts
const kairos = createKairos({
  wallet: { baseUrl, apiKey: { clientId, apiKey, apiSecret }, provider },
})
```

Pass `partnerId` or `apiKey`, not both. The key is sent as `X-Client-Id`, `X-Api-Key` and `X-Api-Secret`, so keep it on your server and never ship it to a browser or app. It needs the `trade:execute` scope, plus `trade:read` for fee reads.

## Fees

Trading fees on trade plans add up per wallet and venue, and you pay them in one settlement. When a wallet owes at least your threshold, its next trade plan is refused with `FeeSettlementRequiredError` (`assetKey`, `owedRaw`, `thresholdRaw`).

```ts
const { venues } = await kairos.wallet.fees.summary(wallet) // owedRaw per venue; negative is a credit

const settlement = await kairos.wallet.fees.settle(wallet, 'polymarket')
// settlement.status: 'confirmed' | 'failed' | 'expired'

await kairos.wallet.fees.settleAll(wallet) // every venue that owes anything
```

On Polymarket the wallet signs once, with no gas. On Predict.fun it sends one transfer on BNB Chain and pays the gas. `settle` switches chains, has the wallet sign or send, answers, and waits for a finalized block, which can take a few minutes. Fees from trades after the settlement was created are still owed, so check `summary` again afterwards. `createSettlement`, `answerSettlement` and `getSettlement` let you run the steps yourself.

## Trade plans

A trade plan is one buy or sell that the wallet signs in a single batch, with a fee ceiling and deadlines. If the venue account is short, it can first bridge exactly the shortfall from the wallet's USDC on Polygon or Arbitrum. Set the wallet up on the venue first.

```ts
const plan = await kairos.wallet.tradePlans.run(
  {
    wallet,
    order: { market: 'polymarket:0x…', outcome: 'Yes', price: '0.05', size: '10' },
    funding: { sourceChainId: '42161', sourceToken: '0xaf88d065e77c8cc2239327c5edb3a432268e5831', maxAmountRaw: '750000', slippageBps: 50 }, // optional
  },
  { maxDebitRaw: '600000' }, // optional: refuse a plan that could spend more
)
// plan.status: 'completed' (the venue accepted the order), or a failure such as 'funded_trade_failed'
```

Sell plans support Polymarket and Predict.fun. Set `side: 'sell'` and review `tradeBudget.minProceedsRaw`; sells cannot use funding or on-chain dependencies. Pass `outcomeTokenId` when using a bare market reference if you have the venue token id.

Before anything is signed, `run` checks the plan against your request. It throws `SafetyCheckError` if the wallet, market, side, price, size, deadlines, funding or budget differ, or if what the wallet would sign does not match the plan: it recomputes `planHash` and every `requestHash`, rebuilds the plan authorization, and checks the venue order and the funding permits amount by amount. It accepts only two changes: the outcome's canonical name, and Predict.fun turning GTC into a GTD that ends with the venue session. Prices and sizes must be canonical decimal strings (`'0.5'`, not `'0.50'`). `run` fills in `clientOrderId`, the `Idempotency-Key` and a `tradeSubmitBefore` 4 minutes out. Pass your own `idempotencyKey` to resume the same plan after a crash. `prepare`, `answer`, `execute`, `report`, `get` and `wait` let you run the steps yourself, including client-submitted funding, which `run` refuses.

## On-chain intents

Split, merge or redeem a Polymarket binary market's position in the wallet's deposit wallet. Kairos builds the calls and the wallet signs twice, with no gas. Kairos then submits the batch and confirms it from a finalized block.

```ts
await kairos.wallet.onchain.split(wallet, 'polymarket:0x…', '1000000') // 1 pUSD → 1 Yes + 1 No
await kairos.wallet.onchain.merge(wallet, 'polymarket:0x…', '1000000')
await kairos.wallet.onchain.redeem(wallet, 'polymarket:0x…', '1000000', { outcome: 0 }) // a resolved market
```

Amounts are in base units (6 decimals). Redeem supports Polymarket Router markets and combos. A wallet that needs the older CTF redemption path can use the low-level intent methods with its own calldata verifier. The SDK finds the deposit wallet from `status` and sends lowercase addresses. It throws `SafetyCheckError` before signing if the intent does not debit what you asked, if `intentHash` or either signing request does not match the terms, or if the batch is anything but the approval and the operation you asked for. Never broadcast the batch from the wallet yourself: the wallet would pay gas and Kairos would never confirm the intent.

Fees, trade plans and on-chain intents need proof of who is calling. With a partner id, that is the wallet's sign-in token: the SDK signs in on first use, as it does for `orders`. With an API key, it is the key itself, and the key's account must own the wallet.

## External signing (`/v2`)

Lower level: build Polymarket order digests yourself, sign them with an EOA or smart account, and submit through Kairos.

```ts
import { signing } from '@kairos.trade/sdk'

const client = new signing.KairosExternalSigningClient({ baseUrl, auth: { bearer: jwt } })
const intent = await client.createIntent({ intent: { token_id, side: 'buy', price: '0.52', size: '100', time_in_force: 'GTC', neg_risk: false, owner_address, signature_type: 0 }, market_id, outcome: 'Yes' })
const signature = await wallet.signHash(signing.digestToSign(intent))
await client.submit(intent.payload_id, signature)
```

`signing` also exports keccak-256, EIP-712 helpers, the one-shot WebSocket submit and partner delegation. Digests are checked against the server's golden values in the tests.

## Develop

```bash
pnpm install
pnpm test          # unit tests, no network
pnpm test:live     # against production
KAIROS_ENV=staging pnpm test:live
pnpm typecheck
pnpm build         # dist/ (ESM + .d.ts)
pnpm generate:openapi
pnpm generate:stream
```

The live suite covers market data, Discover, WebSocket frames, trader positions, and the Trading API credential requirement. Set `KAIROS_PARTNER_ID` to also check wallet status and the setup prerequisite with an unfunded test address. Live checks never sign or submit an order. Use Node 22+ to include WebSocket checks. Set `KAIROS_TRADER_WALLET` to check a specific wallet and use `KAIROS_MARKET_DATA_URL`, `KAIROS_DATA_URL`, `KAIROS_EXECUTION_URL` or `KAIROS_STREAM_URL` to override individual hosts.

`examples/wallet.mjs` sets up a fresh wallet, places an order and cancels it against a Kairos node.
