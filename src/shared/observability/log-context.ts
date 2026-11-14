import { AsyncLocalStorage } from 'node:async_hooks';

/** Correlation fields automatically attached to every log line. */
export interface LogFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogFields>();

export const LogContext = {
  /** Opens a scope inheriting the fields of the current scope. */
  run<T>(fields: LogFields, fn: () => T): T {
    return storage.run({ ...storage.getStore(), ...fields }, fn);
  },

  /** Enriches the current scope (e.g. transactionId known mid-flow). */
  assign(fields: LogFields): void {
    const store = storage.getStore();
    if (store) Object.assign(store, fields);
  },

  get(): LogFields {
    return storage.getStore() ?? {};
  },
};