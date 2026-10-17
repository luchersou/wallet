export interface ProviderIdentity {
  providerId: string;
}

/**
 * Ponto de extensão para autenticação de provedores via IdP externo (OIDC — Keycloak/Zitadel).
 * Não implementado por decisão de escopo: ver ARCHITECTURE.md.
 */
export abstract class ProviderIdentityPort {
  abstract resolve(authorizationHeader: string | undefined): Promise<ProviderIdentity | undefined>;
}