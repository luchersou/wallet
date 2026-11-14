import { z } from 'zod';

const AuthEnvSchema = z.object({
  AUTH_MODE: z.enum(['disabled', 'keycloak']).default('disabled'),
  OIDC_ISSUER: z.string().url().optional(),
  OIDC_AUDIENCE: z.string().min(1).default('wallet-api'),
  OIDC_JWKS_URL: z.string().url().optional(),
});

export type AuthConfig =
  | { mode: 'disabled' }
  | { mode: 'keycloak'; issuer: string; audience: string; jwksUrl: string };

/** Read at bootstrap (not at import): tests switch the mode per suite. */
export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  const parsed = AuthEnvSchema.parse(env);
  if (parsed.AUTH_MODE === 'disabled') return { mode: 'disabled' };
  if (!parsed.OIDC_ISSUER) throw new Error('OIDC_ISSUER is required when AUTH_MODE=keycloak');

  return {
    mode: 'keycloak',
    issuer: parsed.OIDC_ISSUER,
    audience: parsed.OIDC_AUDIENCE,
    jwksUrl: parsed.OIDC_JWKS_URL ?? `${parsed.OIDC_ISSUER}/protocol/openid-connect/certs`,
  };
}