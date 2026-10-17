/** Executa o trabalho numa única transação SQL. Repositórios participam automaticamente. */
export abstract class TransactionRunner {
  abstract run<T>(work: () => Promise<T>): Promise<T>;
}