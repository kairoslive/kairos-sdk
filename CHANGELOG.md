# Changelog

## 0.6.0

### Added

- `kairos.perps` (`PerpsClient`): Hyperliquid perps, Polymarket Perps and Kalshi Margin over the Order Execution API with an API key. Reads: `account` (margin and balance), `positions`, `orders`, `order` (by client order id), `fills`, `fillHistory`, `orderHistory`, `fundingPayments`, `instrumentRules`, `leverage` and `kalshiAccounts`; `allFills`, `allOrders` and `allFundingPayments` follow the cursor. Writes: `placeOrder`, `cancelOrder`, `cancelAll` and `reconcile`. Hosts default to staging (`PERPS_HOSTS`); pass `environment: 'production'` or individual URLs.
- `kairos.perps.markets` (`PerpsMarketsClient`), public: `venues`, `instruments`, `snapshot`, `currentFunding`, and stored `funding`, `trades`, `candles`, `state` and `liquidations` with `all*` iterators that pin the range across pages.
- `newClientOrderId()`, `exactDecimal()`, `isPerpError()`, `PerpHistoryIncompleteError`, and the `Perp*` types. They are generated from the perps paths of Kairos' OpenAPI specs by `scripts/generate-perps-openapi.mjs`. Where a handler differs from the spec, the type follows the handler: order flags and `account` are optional, positions carry `leverage`, `margin_mode` and `isolated_margin`, and `/perps/instruments` and `/perps/leverage` are typed by hand.
- `pnpm test:live:perps`: an opt-in live suite (`KAIROS_SDK_LIVE=1`), read-only unless `KAIROS_SDK_LIVE_ORDERS=1` is also set.
- `kairos.wallet.comboQuote`, `kairos.wallet.combo` and `kairos.wallet.combos`: quote, buy and cash out Polymarket combos (parlays) with the wallet's own signature, and list the trading wallet's combos. A quote that lapses before the signature is refreshed under the same limits and signed again. Redeem a won combo with `kairos.wallet.onchain.redeem(wallet, combo.market, sharesRaw, { outcome: 0 })`. Adds `ComboInput`, `ComboResult`, `WalletCombo`, the `combo` and `comboQuote` actions, and the error codes `NO_QUOTES`, `SIZE_TOO_LARGE` and `PRICE_LIMIT`.

### Changed

- `KairosError.code` also reads the Market Data API's nested `error.code` (for example `rate_limited`).
- `KairosError.outcomeUnknown` is also true for `PERP_OUTCOME_UNKNOWN`.

## 0.5.0

### Added

- `apiKey: { clientId, apiKey, apiSecret }` as an alternative to `partnerId` (server-side only). Pass exactly one.
- `kairos.wallet.routedOrder` (preview, staging only): one buy split across every venue the market is linked on, with `RoutedOrderInput`, `RoutedOrderResult`, `RoutePlan` and `Step.route`/`Step.leg` types. `Action` takes `routedOrder`, and `Step.type` is `StepType` (a routed order's steps are `routed_order`).
- `kairos.wallet.fees` (preview, staging only): `summary`, `createSettlement`, `getSettlement`, `answerSettlement`, `settle`, `settleAll`, `wait`.
- `kairos.wallet.tradePlans` (preview, staging only): `prepare`, `get`, `answer`, `execute`, `report`, `wait`, and `run`, which checks the prepared plan against your request before anything is signed.
- `kairos.wallet.onchain` (preview, staging only): `prepare`, `get`, `execute`, `report`, `wait`, and `split`, `merge`, `redeem`.
- `FeeSettlementRequiredError` (code `FEE_SETTLEMENT_REQUIRED`), `SafetyCheckError`, `WaitTimeoutError`.
- `ordersPage` and `positionsPage`: the same reads plus `venueDetail`, which names any venue that could not be read.
- `signal` (an `AbortSignal`) on the client and on each call.
- `KairosError.code`, `ActionFailedError.errorCode` and `ActionFailedError.outcomeUnknown`.
- Arbitrum One and Arbitrum Sepolia in the chains the SDK can add, so Hyperliquid steps work on wallets that don't know Arbitrum.
- Types for every field the API returns: `Step.expiresAtMs`, `holdUntilMs` and `errorCode`; the full order result (`filledSize`, `avgPrice`, `final`, `success` and the rest); status `asOf` and `venueDetail` keys; setup, order and position fields.

### Changed

- Polling waits until `holdUntilMs` for a held order (at least 250 ms), otherwise `pollIntervalMs`.
- The default `timeoutMs` is now 15 minutes, the life of an action.
- When the server answers `409` "this action is busy", the SDK reads the action and sends the same answer again, without asking the wallet a second time.
- `KairosError.outcomeUnknown` is now true only for `500`, `502`, `504` and `408`, or for a body coded `ORDER_OUTCOME_UNKNOWN` or `CANCEL_OUTCOME_UNKNOWN`. A `503` means the request was refused before it reached a venue.
- Error bodies that are plain text keep the text as the message.
- `fees.settle` throws `SafetyCheckError` before the wallet is asked when the settlement's request is anything but one transfer of the owed amount to the treasury.
- Wallet prompts on one provider run one at a time, so a concurrent call cannot switch chain between another call's switch and its signature. An aborted call waiting its turn never prompts.
- Reads while waiting retry network drops, `408`, `429`, `502`, `503` and `504` until the timeout. An action answer or a plan or intent `execute` that gets no clean reply is read back or sent again (both are idempotent) instead of failing.
- An order or cancel still working when `timeoutMs` runs out throws `ActionFailedError` with `outcomeUnknown` true.
- `Step.chainId` and `Step.venue` are always present (nullable).
