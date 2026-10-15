// Set up a fresh wallet, place an order, cancel it. Every signature goes through `provider.request`.
//
//   KAIROS_URL=https://<your-node> KAIROS_PARTNER_ID=<id> PRIVATE_KEY=0x... \
//   MARKET=<condition id> OUTCOME=Yes PRICE=0.01 SIZE=5 node examples/wallet.mjs
//
// In a browser app pass `window.ethereum` as the provider. Here ethers v6 stands in for it.
import { Wallet, getBytes } from 'ethers'
import { createKairos } from '@kairos.trade/sdk'

const signer = process.env.PRIVATE_KEY ? new Wallet(process.env.PRIVATE_KEY) : Wallet.createRandom()
const provider = {
  async request({ method, params }) {
    if (method === 'personal_sign') return signer.signMessage(getBytes(params[0])) // sign-in for reads
    if (method !== 'eth_signTypedData_v4') throw new Error(`unsupported wallet method ${method}`)
    const { domain, types, message } = JSON.parse(params[1])
    const { EIP712Domain, ...structTypes } = types
    return signer.signTypedData(domain, structTypes, message)
  },
}

const kairos = createKairos({
  wallet: {
    baseUrl: process.env.KAIROS_URL ?? 'http://localhost:8003',
    partnerId: process.env.KAIROS_PARTNER_ID ?? 'demo',
    provider,
    onStep: (step) => console.log(`  sign: ${step.description}`),
  },
})
const wallet = signer.address

console.log(`wallet ${wallet}`)
console.log('setup', await kairos.wallet.setup(wallet))
console.log('status', await kairos.wallet.status(wallet))
if (process.env.MARKET) {
  const order = await kairos.wallet.order(wallet, {
    market: process.env.MARKET,
    outcome: process.env.OUTCOME ?? 'Yes',
    side: 'buy',
    price: process.env.PRICE ?? '0.01',
    size: process.env.SIZE ?? '5',
    postOnly: true,
  })
  console.log('order', order)
  console.log('open orders', (await kairos.wallet.orders(wallet, { open: true })).length) // first read signs in once
  console.log('cancel', await kairos.wallet.cancel(wallet, [order.orderId]))
}
