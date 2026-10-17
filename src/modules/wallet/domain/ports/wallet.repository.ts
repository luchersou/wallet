import type { Wallet } from '../wallet';

export abstract class WalletRepository {
  abstract findById(id: string): Promise<Wallet | undefined>;
  /** SELECT ... FOR UPDATE — exige transação aberta. */
  abstract findByIdForUpdate(id: string): Promise<Wallet | undefined>;
  abstract add(wallet: Wallet): Promise<void>;
  abstract save(wallet: Wallet): Promise<void>;
}