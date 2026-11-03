import { Inject, Injectable } from '@nestjs/common';
import { createRemoteJWKSet, jwtVerify, JWTPayload } from 'jose';
import { ROLES, Role } from '@aegisops/shared-types';
import { APP_ENV, AppEnv } from '../config/env';

export interface VerifiedToken {
  sub: string;
  username: string;
  email?: string;
  roles: Role[];
}

@Injectable()
export class TokenVerifier {
  private readonly jwks;

  constructor(@Inject(APP_ENV) private readonly env: AppEnv) {
    this.jwks = createRemoteJWKSet(new URL(env.keycloakJwksUri));
  }

  /** Throws on any invalid signature, issuer, audience, or expiry. */
  async verify(token: string): Promise<VerifiedToken> {
    const { payload } = await jwtVerify(token, this.jwks, {
      issuer: this.env.keycloakIssuer,
      audience: this.env.keycloakAudience,
      algorithms: ['RS256'],
      clockTolerance: 5,
    });
    return this.toVerified(payload);
  }

  private toVerified(p: JWTPayload): VerifiedToken {
    if (!p.sub) throw new Error('token has no subject');
    const claimed = Array.isArray(p['roles']) ? (p['roles'] as unknown[]) : [];
    const roles = claimed.filter((r): r is Role => (ROLES as readonly unknown[]).includes(r));
    return {
      sub: p.sub,
      username: String(p['preferred_username'] ?? p.sub),
      email: typeof p['email'] === 'string' ? p['email'] : undefined,
      roles,
    };
  }
}
