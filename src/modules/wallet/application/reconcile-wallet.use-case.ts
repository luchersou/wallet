import { Injectable, Logger } from '@nestjs/common';
import { TransactionRunner } from '../../../shared/application/ports/transaction-runner.port';
import type { MoneyProps } from '../../../shared/domain/money';
import { LedgerRepository } from '../domain/ports/ledger.repository';
import { WalletRepository } from '../domain/ports/wallet.repository';
import { WalletNotFoundError } from '../domain/wallet.errors';
import { Metrics } from '../../../shared/application/ports/metrics.port';

export interface ReconciliationView {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWallet {
  private readonly logger = new Logger(ReconcileWallet.name);

  constructor(
    private readonly runner: TransactionRunner,
    private readonly wallets: WalletRepository,
    private readonly ledger: LedgerRepository,
    private readonly metrics: Metrics,
  ) {}

  async execute(walletId: string): Promise<ReconciliationView> {
    // Lock breve: saldo e soma do ledger lidos no mesmo instante lógico
    const { wallet, totals } = await this.runner.run(async () => {
      const wallet = await this.wallets.findByIdForUpdate(walletId);
      if (!wallet) throw new WalletNotFoundError(walletId);
      return { wallet, totals: await this.ledger.totalsByWallet(walletId, wallet.currency) };
    });

    const difference = wallet.balance.subtract(totals.calculatedBalance);
    const consistent = difference.isZero();

    if (!consistent) {
      // Nunca corrigido silenciosamente: logado, contabilizado em métrica e sinalizado na resposta
      this.metrics.reconciliationDivergence();
      this.logger.error({
        msg: 'wallet_reconciliation_divergence',
        walletId,
        difference: difference.amount,
        checkedEntries: totals.entries,
      });
    }

    return {
      walletId,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: totals.calculatedBalance.toJSON(),
      difference: difference.toJSON(),
      consistent,
      checkedEntries: totals.entries,
    };
  }
}