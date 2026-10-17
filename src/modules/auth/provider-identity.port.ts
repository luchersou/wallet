import { ProviderForbiddenError } from './auth.errors';

/**
 * anonymous: autenticação desligada (AUTH_MODE=disabled).
 * client: token válido; providerId presente só para clients de provedor.
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
  /** undefined = credencial ausente ou inválida (401). Falha de infraestrutura lança erro transitório (503). */
  abstract resolve(authorizationHeader: string | undefined): Promise<AuthIdentity | undefined>;
}

/** Validação de domínio na borda HTTP: um client só age como o provedor do próprio token. */
export function assertProviderAccess(identity: AuthIdentity | undefined, providerId: string): void {
  if (!identity || identity.kind === 'anonymous') return;
  if (identity.providerId !== providerId) throw new ProviderForbiddenError(providerId);
}