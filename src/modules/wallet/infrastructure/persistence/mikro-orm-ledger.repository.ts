import { Injectable } from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { toSignedMoney } from '../../../../shared/infrastructure/persistence/money.mapper';
import type { WalletLedgerEntry } from '../../domain/wallet-ledger-entry';
import { LedgerRepository, type LedgerTotals } from '../../domain/ports/ledger.repository';
import { LedgerEntryRecord } from './ledger-entry.schema';
import { LedgerEntryMapper } from './wallet.mapper';

@Injectable()
export class MikroOrmLedgerRepository extends LedgerRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async add(entry: WalletLedgerEntry): Promise<void> {
    this.em.persist(LedgerEntryMapper.toRecord(entry));
    await this.em.flush();
  }

  async listByWallet(
    walletId: string,
    { afterVersion, limit }: { afterVersion?: number; limit: number },
  ): Promise<WalletLedgerEntry[]> {
    const records = await this.em.find(
      LedgerEntryRecord,
      afterVersion === undefined
        ? { walletId }
        : { walletId, walletVersion: { $gt: afterVersion } },
      { orderBy: { walletVersion: 'asc' }, limit },
    );
    return records.map(LedgerEntryMapper.toDomain);
  }

  async totalsByWallet(walletId: string, currency: string): Promise<LedgerTotals> {
    const rows = (await this.em.execute(
      `select coalesce(sum(case when direction = 'CREDIT' then amount else -amount end), 0)::numeric(19,2)::text as total,
              count(*)::int as entries
         from wallet_ledger_entries
        where wallet_id = ?`,
      [walletId],
    )) as { total: string; entries: number }[];

    const row = rows[0] ?? { total: '0.00', entries: 0 };
    return { calculatedBalance: toSignedMoney(row.total, currency), entries: row.entries };
  }
}