import { Injectable, Logger } from '@nestjs/common';
import { UniqueConstraintConflictError } from '../../../shared/application/errors';
import { Clock } from '../../../shared/application/ports/clock.port';
import { IdGenerator } from '../../../shared/application/ports/id-generator.port';
import { TransactionRunner } from '../../../shared/application/ports/transaction-runner.port';
import { Money } from '../../../shared/domain/money';
import { CurrencyMismatchError } from '../../../shared/domain/money.errors';
import { InboxMessage } from '../../messaging/domain/inbox-message';
import { InboxRepository } from '../../messaging/application/ports/inbox.repository';
import { WalletRepository } from '../../wallet/domain/ports/wallet.repository';
import { WalletNotFoundError, WalletPlayerMismatchError } from '../../wallet/domain/wallet.errors';
import { WagerTransactionRepository } from '../domain/ports/wager-transaction.repository';
import { SYSTEM_PROVIDER_ID, WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionKind } from '../domain/wager-transaction-kind';
import { IdempotencyConflictError, InvalidWagerTransactionError } from '../domain/wagering.errors';
import { wagerPayloadHash, type SubmitWagerCommand } from './submit-wager.command';
import { toWagerResult, type WagerResult } from './wager-result';
import { WagerTransactionProcessor } from './wager-transaction-processor';
import { Metrics } from '../../../shared/application/ports/metrics.port';
import { LogContext } from '../../../shared/observability/log-context';

const SUBMITTABLE_KINDS = new Set<string>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Loss,
  WagerTransactionKind.Refund,
  WagerTransactionKind.Rollback,
]);

@Injectable()
export class ProcessWagerTransaction {
  private readonly logger = new Logger(ProcessWagerTransaction.name);

  constructor(
    private readonly runner: TransactionRunner,
    private readonly wallets: WalletRepository,
    private readonly txs: WagerTransactionRepository,
    private readonly inbox: InboxRepository,
    private readonly processor: WagerTransactionProcessor,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
  ) {}

    async execute(cmd: SubmitWagerCommand): Promise<WagerResult> {
      LogContext.assign({
        correlationId: cmd.correlationId,
        providerId: cmd.providerId,
        walletId: cmd.walletId,
      });

      // Contract validated outside the transaction: an invalid payload never opens a transaction
      const hash = this.validate(cmd);

      let result: WagerResult;
      try {
        result = await this.runner.run(() => this.handle(cmd, hash));
      } catch (err) {
        if (!(err instanceof UniqueConstraintConflictError)) throw err;
        // Rare race (same key on different wallets): the 2nd attempt becomes a replay or a conflict
        this.metrics.lockConflict('unique_race');
        result = await this.runner.run(() => this.handle(cmd, hash));
      }

      LogContext.assign({ transactionId: result.transactionId });
      this.logger.log({
        msg: 'wager_transaction_completed',
        kind: cmd.kind,
        status: result.status,
        failureCode: result.failureCode,
        idempotentReplay: result.idempotentReplay,
      });
    return result;
  }

  private validate(cmd: SubmitWagerCommand): string {
    if (!cmd.idempotencyKey?.trim()) {
      throw new InvalidWagerTransactionError('Idempotency-Key is required');
    }
    if (!SUBMITTABLE_KINDS.has(cmd.kind)) {
      throw new InvalidWagerTransactionError(`kind "${cmd.kind}" cannot be submitted`);
    }
    if (cmd.providerId === SYSTEM_PROVIDER_ID) {
      throw new InvalidWagerTransactionError('providerId is reserved');
    }
    const hash = wagerPayloadHash(cmd);
    this.buildTransaction(cmd, hash, this.clock.now()); // validates the creation rules
    return hash;
  }

  private async handle(cmd: SubmitWagerCommand, hash: string): Promise<WagerResult> {
    const now = this.clock.now();

    if (cmd.source.type === 'sqs') {
      const message = InboxMessage.receive({
        messageId: cmd.source.messageId,
        consumerName: cmd.source.consumerName,
        payloadHash: hash,
        receivedAt: now,
      });
      message.markProcessed(now);

      const registered = await this.inbox.tryRegister(message);
      if (!registered) {
        // Same messageId already processed: it is only a replay if the content is identical
        const previous = await this.inbox.find(cmd.source.consumerName, cmd.source.messageId);
        if (previous && previous.payloadHash !== hash) {
          throw new IdempotencyConflictError(
            cmd.idempotencyKey,
            `arrived in message "${cmd.source.messageId}", already used with a different payload`,
          );
        }

        const existing = await this.txs.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey);
        if (existing) {
          if (!existing.matchesPayload(hash)) throw new IdempotencyConflictError(cmd.idempotencyKey);
          const wallet = await this.wallets.findById(existing.walletId);
          return toWagerResult(existing, wallet?.balance ?? Money.zero(existing.money.currency), true);
        }
      }
    }

    const lockStartedAt = performance.now();
    const wallet = await this.wallets.findByIdForUpdate(cmd.walletId);
    this.metrics.lockWait((performance.now() - lockStartedAt) / 1000);
    if (!wallet) throw new WalletNotFoundError(cmd.walletId);

    const existing =
      (await this.txs.findByIdempotencyKey(cmd.providerId, cmd.idempotencyKey)) ??
      (await this.txs.findByExternalId(cmd.providerId, cmd.externalTransactionId));

    if (existing) {
      if (existing.idempotencyKey !== cmd.idempotencyKey || !existing.matchesPayload(hash)) {
        throw new IdempotencyConflictError(cmd.idempotencyKey);
      }
      return toWagerResult(existing, wallet.balance, true);
    }

    if (wallet.playerId !== cmd.playerId) throw new WalletPlayerMismatchError(wallet.id);
    if (wallet.currency !== cmd.money.currency) {
      throw new CurrencyMismatchError(wallet.currency, cmd.money.currency);
    }

    const tx = this.buildTransaction(cmd, hash, now);
    await this.processor.applyAndPersist(tx, wallet, {
      isNew: true,
      ctx: {
        correlationId: cmd.correlationId,
        causationId: cmd.source.type === 'sqs' ? cmd.source.messageId : cmd.idempotencyKey,
        occurredAt: now,
        nextId: () => this.ids.next(),
      },
    });

    return toWagerResult(tx, wallet.balance, false);
  }

  private buildTransaction(cmd: SubmitWagerCommand, hash: string, now: Date): WagerTransaction {
    return WagerTransaction.create({
      id: this.ids.next(),
      providerId: cmd.providerId,
      externalTransactionId: cmd.externalTransactionId,
      idempotencyKey: cmd.idempotencyKey,
      payloadHash: hash,
      walletId: cmd.walletId,
      playerId: cmd.playerId,
      roundId: cmd.roundId,
      gameId: cmd.gameId,
      kind: cmd.kind as WagerTransactionKind,
      money: Money.from(cmd.money),
      referenceExternalTransactionId: cmd.referenceExternalTransactionId,
      at: now,
    });
  }
}