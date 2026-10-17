import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import type { WagerTransaction } from '../../domain/wager-transaction';
import { WagerTransactionRepository } from '../../domain/ports/wager-transaction.repository';
import { WagerTransactionMapper } from './wager-transaction.mapper';
import { WagerTransactionRecord } from './wager-transaction.schema';

@Injectable()
export class MikroOrmWagerTransactionRepository extends WagerTransactionRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async findById(id: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { id });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async findByIdempotencyKey(providerId: string, idempotencyKey: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { providerId, idempotencyKey });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async findByExternalId(providerId: string, externalTransactionId: string): Promise<WagerTransaction | undefined> {
    const record = await this.em.findOne(WagerTransactionRecord, { providerId, externalTransactionId });
    return record ? WagerTransactionMapper.toDomain(record) : undefined;
  }

  async hasProcessedReversal(referenceTransactionId: string): Promise<boolean> {
    const count = await this.em.count(WagerTransactionRecord, {
      referenceTransactionId,
      status: 'PROCESSED',
      kind: { $in: ['REFUND', 'ROLLBACK'] },
    });
    return count > 0;
  }

  async findDuePendingReferenceIds(now: Date, limit: number): Promise<string[]> {
    const rows = (await this.em.execute(
      `select id from wager_transactions
        where status = 'PENDING_REFERENCE' and next_reference_attempt_at <= ?
        order by next_reference_attempt_at
        limit ?`,
      [now, limit],
    )) as { id: string }[];
    return rows.map((r) => r.id);
  }

  async add(tx: WagerTransaction): Promise<void> {
    this.em.persist(WagerTransactionMapper.toNewRecord(tx));
    await this.em.flush();
  }

  async save(tx: WagerTransaction): Promise<void> {
    const record = await this.em.findOneOrFail(WagerTransactionRecord, { id: tx.id });
    WagerTransactionMapper.apply(tx, record);
    await this.em.flush();
  }
}