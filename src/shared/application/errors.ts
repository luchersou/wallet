/** Violação de unicidade no banco — normalmente corrida entre requisições concorrentes. */
export class UniqueConstraintConflictError extends Error {
  constructor(cause: unknown) {
    super('Unique constraint conflict', { cause });
    this.name = 'UniqueConstraintConflictError';
  }
}

/** Falha temporária de infraestrutura: pode ser reenviada. */
export class TransientInfrastructureError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'TransientInfrastructureError';
  }
}