/**
 * Programming error: the code tried to produce an impossible state.
 * It is not a business path and carries no failureCode.
 */
export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolationError';
  }
}