export enum WagerTransactionKind {
  Opening = 'OPENING', // internal: wallet opening credit
  Bet = 'BET',
  Win = 'WIN',
  Loss = 'LOSS',
  Refund = 'REFUND',
  Rollback = 'ROLLBACK',
}