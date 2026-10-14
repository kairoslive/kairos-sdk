# Kairos SDK

One TypeScript package for Kairos: market data, wallet trading, and external signing. No runtime dependencies, works in browsers and Node 20+.

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

const open = await kairos.wallet.orders(wallet, { open: true })
const positions = await kairos.wallet.positions(wallet)

await kairos.wallet.cancel(wallet, [orderId])
await kairos.wallet.cancelAll(wallet)
```

Each call asks the wallet for one `eth_signTypedData_v4` signature per step and returns the action's result.

| Error | Means |
|---|---|
| `ActionFailedError` | The action failed. `error.message` says why. Start a new one to retry |
| `KairosError` with `status` | The request was refused (`400` bad input, `403` unknown partner or disabled wallet, `409` not set up or linked to a Kairos account, `429` slow down) |
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
