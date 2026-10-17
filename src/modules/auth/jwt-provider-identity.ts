import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { TransientInfrastructureError } from '../../shared/application/errors';
import { ProviderIdentityPort, type AuthIdentity } from './provider-identity.port';

const BEARER = /^Bearer\s+(.+)$/i;

/** Valida tokens do Keycloak localmente: assinatura (JWKS com cache), iss, aud e exp. */
export class JwtProviderIdentity extends ProviderIdentityPort {
  private readonly jwks: ReturnType<typeof createRemoteJWKSet>;

  constructor(
    private readonly issuer: string,
    private readonly audience: string,
    jwksUrl: string,
  ) {
    super();
    this.jwks = createRemoteJWKSet(new URL(jwksUrl));
  }

  async resolve(authorizationHeader: string | undefined): Promise<AuthIdentity | undefined> {
    const token = authorizationHeader?.match(BEARER)?.[1];
    if (!token) return undefined;

    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.issuer,
        audience: this.audience,
        algorithms: ['RS256'],
      });
      return {
        kind: 'client',
        subject: String(payload.sub ?? ''),
        clientId: String(payload.azp ?? payload.client_id ?? ''),
        providerId: typeof payload.provider_id === 'string' ? payload.provider_id : undefined,
      };
    } catch (err) {
      // Token inválido (assinatura, expiração, iss, aud...) → 401.
      // Não conseguir buscar as chaves é falha de infraestrutura → 503.
      if (err instanceof errors.JWKSTimeout || !(err instanceof errors.JOSEError)) {
        throw new TransientInfrastructureError('Unable to fetch identity provider signing keys', err);
      }
      return undefined;
    }
  }
}