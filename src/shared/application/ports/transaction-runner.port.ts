/** Runs the work in a single SQL transaction. Repositories take part automatically. */
export abstract class TransactionRunner {
  abstract run<T>(work: () => Promise<T>): Promise<T>;
}