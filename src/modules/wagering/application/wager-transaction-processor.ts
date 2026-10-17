import { Injectable } from '@nestjs/common';
import { FailureCode } from '../../../shared/domain/failure-code';
import type { EventContext, IntegrationEvent } from '../../../shared/domain/integration-event';
import { IdGenerator } from '../../../shared/application/ports/id-generator.port';
import { OutboxMessage } from '../../messaging/domain/outbox-message';
import { OutboxRepository } from '../../messaging/application/ports/outbox.repository';
import { LedgerDirection } from '../../wallet/domain/ledger-direction';
import { LedgerRepository } from '../../wallet/domain/ports/ledger.repository';
import { WalletRepository } from '../../wallet/domain/ports/wallet.repository';
import type { Wallet } from '../../wallet/domain/wallet';
import type { WalletLedgerEntry } from '../../wallet/domain/wallet-ledger-entry';
import { WagerTransactionPendingReference } from '../domain/events/wager-transaction-pending-reference.event';
import { WagerTransactionProcessed } from '../domain/events/wager-transaction-processed.event';
import { WagerTransactionRejected } from '../domain/events/wager-transaction-rejected.event';
import { WalletBalanceChanged } from '../domain/events/wallet-balance-changed.event';
import { WagerTransactionRepository } from '../domain/ports/wager-transaction.repository';
import { evaluateReference } from '../domain/reference-policy';
import { ReferenceRetryPolicy } from '../domain/reference-retry-policy';
import type { WagerTransaction } from '../domain/wager-transaction';
import { WagerTransactionStatus } from '../domain/wager-transaction-status';

type ReferenceDecision =
  | { outcome: 'accept'; reference?: WagerTransaction }
  | { outcome: 'wait' }
  | { outcome: 'reject'; code: FailureCode };

/**
 * Aplica as regras da seção 7 a uma transação com a wallet JÁ TRAVADA,
 * e persiste tudo na transação SQL corrente: transação → ledger → wallet → outbox.
 */
@Injectable()
export class WagerTransactionProcessor {
  constructor(
    private readonly txs: WagerTransactionRepository,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
    private readonly outbox: OutboxRepository,
    private readonly ids: IdGenerator,
    private readonly policy: ReferenceRetryPolicy,
  ) {}

  async applyAndPersist(
    tx: WagerTransaction,
    wallet: Wallet,
    options: { isNew: boolean; ctx: EventContext },
  ): Promise<WagerTransactionStatus> {
    const { ctx } = options;
    const now = ctx.occurredAt;
    const events: IntegrationEvent<unknown>[] = [];
    let entry: WalletLedgerEntry | undefined;

    const decision = await this.resolveReference(tx);

    if (decision.outcome === 'wait') {
      if (tx.status === WagerTransactionStatus.Pending) {
        tx.markPendingReference(now, this.policy);
        events.push(WagerTransactionPendingReference.from(tx, ctx));
      } else if (tx.hasExhaustedReferenceRetries(this.policy)) {
        tx.reject(FailureCode.ReferenceNotFound, wallet.balance, now);
        events.push(WagerTransactionRejected.from(tx, ctx));
      } else {
        tx.scheduleReferenceRetry(now, this.policy);
      }
    } else if (decision.outcome === 'reject') {
      tx.reject(decision.code, wallet.balance, now);
      events.push(WagerTransactionRejected.from(tx, ctx));
    } else if (!tx.affectsBalance()) {
      // LOSS: registra o resultado sem mover saldo
      tx.markProcessed(decision.reference?.id, wallet.balance, now);
      events.push(WagerTransactionProcessed.from(tx, ctx));
    } else {
      const direction = tx.ledgerDirectionFor(decision.reference);

      if (direction === LedgerDirection.Debit && !wallet.canDebit(tx.money)) {
        // Reversão sem saldo é operacionalmente diferente de aposta sem saldo
        const code = tx.isReversal() ? FailureCode.ReversalWouldOverdraw : FailureCode.InsufficientFunds;
        tx.reject(code, wallet.balance, now);
        events.push(WagerTransactionRejected.from(tx, ctx));
      } else {
        const movement = {
          money: tx.money,
          transactionId: tx.id,
          ledgerEntryId: this.ids.next(),
          at: now,
        };
        entry = direction === LedgerDirection.Debit ? wallet.debit(movement) : wallet.credit(movement);
        tx.markProcessed(decision.reference?.id, wallet.balance, now);
        events.push(
          WagerTransactionProcessed.from(tx, ctx),
          WalletBalanceChanged.from(wallet, entry, ctx),
        );
      }
    }

    // Ordem das FKs: transação → ledger → wallet → outbox
    if (options.isNew) await this.txs.add(tx);
    else await this.txs.save(tx);

    if (entry) {
      await this.ledger.add(entry);
      await this.wallets.save(wallet);
    }

    for (const event of events) {
      await this.outbox.add(OutboxMessage.enqueue(event));
    }

    return tx.status;
  }

  private async resolveReference(tx: WagerTransaction): Promise<ReferenceDecision> {
    if (!tx.referenceExternalTransactionId) return { outcome: 'accept' };

    const reference = await this.txs.findByExternalId(tx.providerId, tx.referenceExternalTransactionId);
    const alreadyReversed =
      reference && tx.isReversal() ? await this.txs.hasProcessedReversal(reference.id) : false;

    const evaluation = evaluateReference(tx, reference, { alreadyReversed });
    return evaluation.outcome === 'accept' ? { outcome: 'accept', reference } : evaluation;
  }
}