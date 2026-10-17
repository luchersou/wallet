import { EntitySchema } from '@mikro-orm/core';

export class LedgerEntryRecord {
  id!: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  amount!: string;
  currency!: string;
  balanceBefore!: string;
  balanceAfter!: string;
  walletVersion!: number;
  createdAt!: Date;
}

export const LedgerEntrySchema = new EntitySchema<LedgerEntryRecord>({
  class: LedgerEntryRecord,
  tableName: 'wallet_ledger_entries',
  properties: {
    id: { type: 'uuid', primary: true },
    walletId: { type: 'uuid' },
    transactionId: { type: 'uuid' },
    direction: { type: 'string' },
    amount: { type: 'decimal', columnType: 'numeric(19,2)' },
    currency: { type: 'string', columnType: 'char(3)' },
    balanceBefore: { type: 'decimal', columnType: 'numeric(19,2)' },
    balanceAfter: { type: 'decimal', columnType: 'numeric(19,2)' },
    walletVersion: { type: 'integer' },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
  },
});