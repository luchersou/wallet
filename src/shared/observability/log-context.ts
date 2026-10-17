import { AsyncLocalStorage } from 'node:async_hooks';

/** Campos de correlação anexados automaticamente a toda linha de log. */
export interface LogFields {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
}

const storage = new AsyncLocalStorage<LogFields>();

export const LogContext = {
  /** Abre um escopo herdando os campos do escopo atual. */
  run<T>(fields: LogFields, fn: () => T): T {
    return storage.run({ ...storage.getStore(), ...fields }, fn);
  },

  /** Enriquece o escopo atual (ex.: transactionId conhecido no meio do fluxo). */
  assign(fields: LogFields): void {
    const store = storage.getStore();
    if (store) Object.assign(store, fields);
  },

  get(): LogFields {
    return storage.getStore() ?? {};
  },
};