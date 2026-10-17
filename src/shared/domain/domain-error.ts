import type { FailureCode } from './failure-code';

export abstract class DomainError extends Error {
  abstract readonly code: FailureCode;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}