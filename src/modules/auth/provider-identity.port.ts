import { ProviderForbiddenError } from './auth.errors';

/**
 * anonymous: authentication disabled (AUTH_MODE=disabled).
 * client: valid token; providerId present only for provider clients.
 */
export type AuthIdentity =
  | { kind: 'anonymous' }
  | { kind: 'client'; subject: string; clientId: string; providerId?: string };

declare module 'express-serve-static-core' {
  interface Request {
    identity?: AuthIdentity;
  }
}

export abstract class ProviderIdentityPort {
  /** undefined = missing or invalid credential (401). Infrastructure failure throws a transient error (503). */
  abstract resolve(authorizationHeader: string | undefined): Promise<AuthIdentity | undefined>;
}

/** Domain validation at the HTTP edge: a client may only act as the provider of its own token. */
export function assertProviderAccess(identity: AuthIdentity | undefined, providerId: string): void {
  if (!identity || identity.kind === 'anonymous') return;
  if (identity.providerId !== providerId) throw new ProviderForbiddenError(providerId);
}