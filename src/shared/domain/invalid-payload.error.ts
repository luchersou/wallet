import { DomainError } from './domain-error';
import { FailureCode } from './failure-code';

export class InvalidPayloadError extends DomainError {
  readonly code = FailureCode.InvalidPayload;

  constructor(reason: string) {
    super(reason);
  }
}