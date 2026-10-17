import { DomainError } from '../../shared/domain/domain-error';
import { FailureCode } from '../../shared/domain/failure-code';

export class AuthenticationRequiredError extends DomainError {
  readonly code = FailureCode.Unauthenticated;

  constructor() {
    super('A valid bearer token is required');
  }
}

export class ProviderForbiddenError extends DomainError {
  readonly code = FailureCode.Forbidden;

  constructor(providerId: string) {
    super(`The authenticated client is not allowed to act as provider "${providerId}"`);
  }
}