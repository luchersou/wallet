import type { WagerTransaction } from '../wager-transaction';

export abstract class WagerTransactionRepository {
  abstract findById(id: string): Promise<WagerTransaction | undefined>;
  abstract findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined>;
  abstract findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined>;
  abstract hasProcessedReversal(referenceTransactionId: string): Promise<boolean>;
  /** Sem lock: cada id é reprocessado na própria transação, travando a wallet. */
  abstract findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]>;
  abstract add(tx: WagerTransaction): Promise<void>;
  abstract save(tx: WagerTransaction): Promise<void>;
}