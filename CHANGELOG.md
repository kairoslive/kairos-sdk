# Changelog

## 0.5.0

### Added

- `apiKey: { clientId, apiKey, apiSecret }` as an alternative to `partnerId` (server-side only). Pass exactly one.
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
- `Step.chainId` and `Step.venue` are always present (nullable).
