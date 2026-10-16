# Kairos SDK

One TypeScript package for Kairos: market data, trader stats, wallet trading, and external signing. No runtime dependencies, works in browsers and Node 20+.

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
| `ActionFailedError` | The action failed. `error.message` says why. Start a new one to retry |
| `KairosError` with `status` | The request was refused (`400` bad input, `401` missing or expired sign-in, `403` unknown partner or disabled wallet, `404` not the signed-in wallet, `409` not set up or linked to a Kairos account, `429` slow down) |
| `KairosError` with `outcomeUnknown` | A 5xx on an order: it may be live. Check `orders(wallet, { open: true })` before retrying |

Get your partner id and base URL from Kairos.

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
pnpm test:live     # against the public market data API
pnpm typecheck
pnpm build         # dist/ (ESM + .d.ts)
```

`examples/wallet.mjs` sets up a fresh wallet, places an order and cancels it against a Kairos node.
