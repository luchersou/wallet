import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import type { MikroORM as CoreMikroORM } from '@mikro-orm/core';
import { assertGlobalLedgerInvariant } from '../helpers/invariants';
import { CheckConstraintViolationException } from '@mikro-orm/core';
import type { MikroORM } from '@mikro-orm/postgresql';
import { Money } from '../../src/shared/domain/money';
import { MikroOrmTransactionRunner } from '../../src/shared/infrastructure/persistence/mikro-orm-transaction-runner';
import { Wallet } from '../../src/modules/wallet/domain/wallet';
import { MikroOrmWalletRepository } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-wallet.repository';
import { MikroOrmLedgerRepository } from '../../src/modules/wallet/infrastructure/persistence/mikro-orm-ledger.repository';
import { WagerTransaction } from '../../src/modules/wagering/domain/wager-transaction';
import { WagerTransactionKind } from '../../src/modules/wagering/domain/wager-transaction-kind';
import { WagerTransactionStatus } from '../../src/modules/wagering/domain/wager-transaction-status';
import { MikroOrmWagerTransactionRepository } from '../../src/modules/wagering/infrastructure/persistence/mikro-orm-wager-transaction.repository';
import { createTestOrm, resetDatabase } from '../helpers/orm/orm';
import { UniqueConstraintConflictError } from '../../src/shared/application/errors';

const brl = (amount: string) => Money.from({ amount, currency: 'BRL' });
const uuid = () => Bun.randomUUIDv7();
const HASH = 'a'.repeat(64);

let orm: MikroORM;
let runner: MikroOrmTransactionRunner;
let wallets: MikroOrmWalletRepository;
let ledger: MikroOrmLedgerRepository;
let txs: MikroOrmWagerTransactionRepository;

beforeAll(async () => {
  orm = await createTestOrm();
  runner = new MikroOrmTransactionRunner(orm.em);
  wallets = new MikroOrmWalletRepository(orm.em);
  ledger = new MikroOrmLedgerRepository(orm.em);
  txs = new MikroOrmWagerTransactionRepository(orm.em);
});

afterAll(async () => {
  await orm.close(true);
});

beforeEach(async () => {
  await resetDatabase(orm);
});

afterEach(async () => {
  await assertGlobalLedgerInvariant(orm as unknown as CoreMikroORM);
});

async function seedWallet(initial: string) {
  const walletId = uuid();
  const playerId = uuid();
  const openingTxId = uuid();
  const at = new Date();

  const { wallet, openingEntry } = Wallet.open({
    id: walletId,
    playerId,
    initialBalance: brl(initial),
    openingTransactionId: openingTxId,
    openingLedgerEntryId: uuid(),
    at,
  });

  await runner.run(async () => {
    await wallets.add(wallet);
    if (openingEntry) {
      await txs.add(
        WagerTransaction.createOpening({
          id: openingTxId, walletId, playerId, money: brl(initial), payloadHash: HASH, at,
        }),
      );
      await ledger.add(openingEntry);
    }
  });

  return { walletId, playerId };
}

const exec = (sql: string, params: unknown[] = []) =>
  runner.run(() => orm.em.execute(sql, params));

describe('persistence', () => {
  it('round-trips a wallet with its opening transaction and ledger', async () => {
    const { walletId } = await seedWallet('1000.00');

    const result = await runner.run(async () => ({
      wallet: await wallets.findById(walletId),
      entries: await ledger.listByWallet(walletId, { limit: 50 }),
      totals: await ledger.totalsByWallet(walletId, 'BRL'),
    }));

    expect(result.wallet?.balance.amount).toBe('1000.00');
    expect(result.wallet?.version).toBe(1);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]!.isBalanced()).toBe(true);
    expect(result.totals.calculatedBalance.equals(result.wallet!.balance)).toBe(true);
    expect(result.totals.entries).toBe(1);
  });

  it('opens a zero-balance wallet without ledger', async () => {
    const { walletId } = await seedWallet('0.00');
    const totals = await runner.run(() => ledger.totalsByWallet(walletId, 'BRL'));
    expect(totals.entries).toBe(0);
    expect(totals.calculatedBalance.amount).toBe('0.00');
  });

  it('debits under lock and keeps wallet and ledger consistent', async () => {
    const { walletId, playerId } = await seedWallet('1000.00');
    const at = new Date();
    const betId = uuid();

    await runner.run(async () => {
      const wallet = (await wallets.findByIdForUpdate(walletId))!;
      const bet = WagerTransaction.create({
        id: betId, providerId: 'provider-a', externalTransactionId: 'ext-1',
        idempotencyKey: 'provider-a:ext-1', payloadHash: HASH, walletId, playerId,
        roundId: 'round-1', gameId: 'game-1', kind: WagerTransactionKind.Bet,
        money: brl('80.00'), at,
      });
      const entry = wallet.debit({ money: bet.money, transactionId: bet.id, ledgerEntryId: uuid(), at });
      bet.markProcessed(undefined, wallet.balance, at);

      await txs.add(bet);
      await ledger.add(entry);
      await wallets.save(wallet);
    });

    const result = await runner.run(async () => ({
      wallet: await wallets.findById(walletId),
      totals: await ledger.totalsByWallet(walletId, 'BRL'),
      page: await ledger.listByWallet(walletId, { afterVersion: 1, limit: 50 }),
      bet: await txs.findByIdempotencyKey('provider-a', 'provider-a:ext-1'),
    }));

    expect(result.wallet?.balance.amount).toBe('920.00');
    expect(result.wallet?.version).toBe(2);
    expect(result.totals.calculatedBalance.amount).toBe('920.00');
    expect(result.page).toHaveLength(1);
    expect(result.bet?.status).toBe(WagerTransactionStatus.Processed);
    expect(result.bet?.observedBalance?.amount).toBe('920.00');
  });

  it('refuses FOR UPDATE outside a transaction context', async () => {
    const { walletId } = await seedWallet('10.00');
    await expect(wallets.findByIdForUpdate(walletId)).rejects.toThrow();
  });
});

describe('database constraints', () => {
  it('rejects negative balance', async () => {
    await expect(
      exec(`insert into wallets values (?, ?, 'BRL', -1.00, 1, now(), now())`, [uuid(), uuid()]),
    ).rejects.toThrow(CheckConstraintViolationException);
  });

  it('rejects a second wallet for the same player and currency', async () => {
    const { playerId } = await seedWallet('0.00');
    await expect(
      exec(`insert into wallets values (?, ?, 'BRL', 0, 1, now(), now())`, [uuid(), playerId]),
    ).rejects.toThrow(UniqueConstraintConflictError);
  });

  it('rejects a balance with no matching ledger entry at commit', async () => {
    await expect(
      exec(`insert into wallets values (?, ?, 'BRL', 100.00, 1, now(), now())`, [uuid(), uuid()]),
    ).rejects.toThrow(/does not match its ledger/);
  });

  it('rejects balance changes without ledger at commit', async () => {
    const { walletId } = await seedWallet('100.00');
    await expect(
      exec(`update wallets set balance = 50.00, version = 2 where id = ?`, [walletId]),
    ).rejects.toThrow(/does not match its ledger/);
  });

  it('keeps the ledger append-only', async () => {
    const { walletId } = await seedWallet('100.00');
    await expect(
      exec(`update wallet_ledger_entries set created_at = now() where wallet_id = ?`, [walletId]),
    ).rejects.toThrow(/append-only/);
    await expect(
      exec(`delete from wallet_ledger_entries where wallet_id = ?`, [walletId]),
    ).rejects.toThrow(/append-only/);
  });

  it('keeps terminal transactions immutable', async () => {
    const { walletId } = await seedWallet('100.00');
    await expect(
      exec(`update wager_transactions set status = 'PENDING' where wallet_id = ?`, [walletId]),
    ).rejects.toThrow(/is terminal/);
  });

  it('rejects a reused idempotency key', async () => {
    const { walletId, playerId } = await seedWallet('100.00');
    await expect(
      runner.run(() =>
        txs.add(
          WagerTransaction.createOpening({
            id: uuid(), walletId, playerId, money: brl('100.00'), payloadHash: HASH, at: new Date(),
          }),
        ),
      ),
    ).rejects.toThrow(UniqueConstraintConflictError);
  });
});