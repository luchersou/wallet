import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC } from './public.decorator';

/**
 * Guard global no-op. Com autenticação habilitada, aqui seria:
 *  1. resolver a identidade via ProviderIdentityPort (token OIDC do client credentials);
 *  2. exigir que body.providerId == identidade autenticada (mesma validação de domínio da fila).
 */
@Injectable()
export class NoopAuthGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;
    return true; // ponto de extensão
  }
}