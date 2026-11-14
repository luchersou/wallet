import { Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { AuthenticationRequiredError } from './auth.errors';
import { ProviderIdentityPort } from './provider-identity.port';
import { IS_PUBLIC } from './public.decorator';

/** Global guard: requires a valid identity on every route not marked with @Public(). */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identities: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest<Request>();
    const identity = await this.identities.resolve(req.header('authorization'));
    if (!identity) throw new AuthenticationRequiredError();

    req.identity = identity;
    return true;
  }
}