/**
 * Stable, machine-readable failure taxonomy.
 * The classification (retryable, correctable, terminal) and the HTTP mapping
 * live in the application/infra layer — only the codes are here.
 */
export enum FailureCode {
  // Contract / payload
  InvalidMoney = 'INVALID_MONEY',
  InvalidPayload = 'INVALID_PAYLOAD',
  CurrencyMismatch = 'CURRENCY_MISMATCH',

  // Idempotency
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',

  // Wallet
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletAlreadyExists = 'WALLET_ALREADY_EXISTS',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  InsufficientFunds = 'INSUFFICIENT_FUNDS',

  // Reversals (REFUND / ROLLBACK)
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',

  // Permanent infra (status FAILED)
  PermanentInfrastructureError = 'PERMANENT_INFRASTRUCTURE_ERROR',

  // Queries / transport
  TransactionNotFound = 'TRANSACTION_NOT_FOUND',
  TransientInfrastructureError = 'TRANSIENT_INFRASTRUCTURE_ERROR',
  InternalError = 'INTERNAL_ERROR',

  // Authentication / authorization
  Unauthenticated = 'UNAUTHENTICATED',
  Forbidden = 'FORBIDDEN',
}