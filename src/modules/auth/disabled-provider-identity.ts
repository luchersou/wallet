import { ProviderIdentityPort, type AuthIdentity } from './provider-identity.port';

export class DisabledProviderIdentity extends ProviderIdentityPort {
  async resolve(): Promise<AuthIdentity> {
    return { kind: 'anonymous' };
  }
}