import { createRemoteJWKSet, errors, jwtVerify } from 'jose';
import { TransientInfrastructureError } from '../../shared/application/errors';
import { ProviderIdentityPort, type AuthIdentity } from './provider-identity.port';

const BEARER = /^Bearer\s+(.+)$/i;

/** Validates Keycloak tokens locally: signature (cached JWKS), iss, aud and exp. */
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
      // Invalid token (signature, expiration, iss, aud...) → 401.
      // Failing to fetch the keys is an infrastructure failure → 503.
      if (err instanceof errors.JWKSTimeout || !(err instanceof errors.JOSEError)) {
        throw new TransientInfrastructureError('Unable to fetch identity provider signing keys', err);
      }
      return undefined;
    }
  }
}