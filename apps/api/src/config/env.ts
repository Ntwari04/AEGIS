export interface AppEnv {
  nodeEnv: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  webOrigin: string;
  keycloakIssuer: string;
  keycloakJwksUri: string;
  keycloakAudience: string;
}

const REQUIRED = [
  'DATABASE_URL',
  'REDIS_URL',
  'WEB_ORIGIN',
  'KEYCLOAK_ISSUER',
  'KEYCLOAK_JWKS_URI',
  'KEYCLOAK_AUDIENCE',
] as const;

/** Fails fast at boot: a missing setting must stop the process, never fall back to an insecure default. */
export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const missing = REQUIRED.filter((k) => !source[k]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }
  if (source.WEB_ORIGIN === '*') {
    throw new Error('WEB_ORIGIN must be an explicit origin, not "*" (PRD 8.5)');
  }
  return {
    nodeEnv: source.NODE_ENV ?? 'development',
    port: Number(source.PORT ?? 4000),
    databaseUrl: source.DATABASE_URL!,
    redisUrl: source.REDIS_URL!,
    webOrigin: source.WEB_ORIGIN!,
    keycloakIssuer: source.KEYCLOAK_ISSUER!,
    keycloakJwksUri: source.KEYCLOAK_JWKS_URI!,
    keycloakAudience: source.KEYCLOAK_AUDIENCE!,
  };
}

export const APP_ENV = Symbol('APP_ENV');
