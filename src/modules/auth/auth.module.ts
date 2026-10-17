import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { readAuthConfig } from './auth.config';
import { AuthGuard } from './auth.guard';
import { DisabledProviderIdentity } from './disabled-provider-identity';
import { JwtProviderIdentity } from './jwt-provider-identity';
import { ProviderIdentityPort } from './provider-identity.port';

@Module({
  providers: [
    {
      provide: ProviderIdentityPort,
      useFactory: () => {
        const config = readAuthConfig();
        return config.mode === 'keycloak'
          ? new JwtProviderIdentity(config.issuer, config.audience, config.jwksUrl)
          : new DisabledProviderIdentity();
      },
    },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AuthModule {}