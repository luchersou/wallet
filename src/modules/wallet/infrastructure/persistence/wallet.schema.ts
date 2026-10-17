import { EntitySchema } from '@mikro-orm/core';

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balance!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: 'wallets',
  properties: {
    id: { type: 'uuid', primary: true },
    playerId: { type: 'uuid' },
    currency: { type: 'string', columnType: 'char(3)' },
    balance: { type: 'decimal', columnType: 'numeric(19,2)' },
    version: { type: 'integer' },
    createdAt: { type: 'datetime', columnType: 'timestamptz' },
    updatedAt: { type: 'datetime', columnType: 'timestamptz' },
  },
});