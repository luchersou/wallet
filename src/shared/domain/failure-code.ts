/**
 * Taxonomia estável de falhas, legível por máquina.
 * A classificação (retentável, corrigível, terminal) e o mapeamento HTTP
 * ficam na camada de aplicação/infra — aqui só os códigos.
 */
export enum FailureCode {
  // Contrato / payload
  InvalidMoney = 'INVALID_MONEY',
  InvalidPayload = 'INVALID_PAYLOAD',
  CurrencyMismatch = 'CURRENCY_MISMATCH',

  // Idempotência
  IdempotencyConflict = 'IDEMPOTENCY_CONFLICT',

  // Wallet
  WalletNotFound = 'WALLET_NOT_FOUND',
  WalletAlreadyExists = 'WALLET_ALREADY_EXISTS',
  WalletPlayerMismatch = 'WALLET_PLAYER_MISMATCH',
  InsufficientFunds = 'INSUFFICIENT_FUNDS',

  // Reversões (REFUND / ROLLBACK)
  ReversalWouldOverdraw = 'REVERSAL_WOULD_OVERDRAW',
  ReferenceNotFound = 'REFERENCE_NOT_FOUND',
  ReferenceMismatch = 'REFERENCE_MISMATCH',
  ReferenceKindNotAllowed = 'REFERENCE_KIND_NOT_ALLOWED',
  ReferenceNotProcessed = 'REFERENCE_NOT_PROCESSED',
  ReferenceAlreadyReversed = 'REFERENCE_ALREADY_REVERSED',
  ReversalAmountMismatch = 'REVERSAL_AMOUNT_MISMATCH',

  // Infra permanente (status FAILED)
  PermanentInfrastructureError = 'PERMANENT_INFRASTRUCTURE_ERROR',

  // Consultas / transporte
  TransactionNotFound = 'TRANSACTION_NOT_FOUND',
  TransientInfrastructureError = 'TRANSIENT_INFRASTRUCTURE_ERROR',
  InternalError = 'INTERNAL_ERROR',

  // Autenticação / autorização
  Unauthenticated = 'UNAUTHENTICATED',
  Forbidden = 'FORBIDDEN',
}