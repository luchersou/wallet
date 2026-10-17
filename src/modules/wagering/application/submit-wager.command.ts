import type { MoneyProps } from '../../../shared/domain/money';
import { payloadHash } from '../../../shared/infrastructure/crypto/payload-hash';

export type WagerSource =
  | { type: 'http' }
  | { type: 'sqs'; consumerName: string; messageId: string };

export interface SubmitWagerCommand {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  source: WagerSource;
}

/**
 * sha256 do JSON canônico (chaves ordenadas) apenas dos campos de negócio.
 * Fora do hash: Idempotency-Key, correlationId e metadados de transporte.
 */
export function wagerPayloadHash(cmd: SubmitWagerCommand): string {
  return payloadHash({
    providerId: cmd.providerId,
    externalTransactionId: cmd.externalTransactionId,
    playerId: cmd.playerId,
    walletId: cmd.walletId,
    roundId: cmd.roundId,
    gameId: cmd.gameId,
    kind: cmd.kind,
    money: { amount: cmd.money.amount, currency: cmd.money.currency },
    referenceExternalTransactionId: cmd.referenceExternalTransactionId,
  });
}