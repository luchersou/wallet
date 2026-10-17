import { Injectable } from '@nestjs/common';
import { LockMode } from '@mikro-orm/core';
import { EntityManager } from '@mikro-orm/postgresql';
import type { Wallet } from '../../domain/wallet';
import { WalletRepository } from '../../domain/ports/wallet.repository';
import { WalletMapper } from './wallet.mapper';
import { WalletRecord } from './wallet.schema';

@Injectable()
export class MikroOrmWalletRepository extends WalletRepository {
  constructor(private readonly em: EntityManager) {
    super();
  }

  async findById(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(WalletRecord, { id });
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async findByIdForUpdate(id: string): Promise<Wallet | undefined> {
    const record = await this.em.findOne(
      WalletRecord,
      { id },
      { lockMode: LockMode.PESSIMISTIC_WRITE, refresh: true },
    );
    return record ? WalletMapper.toDomain(record) : undefined;
  }

  async add(wallet: Wallet): Promise<void> {
    this.em.persist(WalletMapper.toNewRecord(wallet));
    await this.em.flush();
  }

  async save(wallet: Wallet): Promise<void> {
    // Já está no identity map após o findByIdForUpdate: não gera novo SELECT.
    const record = await this.em.findOneOrFail(WalletRecord, { id: wallet.id });
    WalletMapper.apply(wallet, record);
    await this.em.flush();
  }
}