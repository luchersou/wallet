/** Unique constraint violation in the database — usually a race between concurrent requests. */
export class UniqueConstraintConflictError extends Error {
  constructor(cause: unknown) {
    super('Unique constraint conflict', { cause });
    this.name = 'UniqueConstraintConflictError';
  }
}

/** Temporary infrastructure failure: can be retried. */
export class TransientInfrastructureError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = 'TransientInfrastructureError';
  }
}