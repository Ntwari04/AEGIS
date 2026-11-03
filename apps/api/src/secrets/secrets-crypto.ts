import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/**
 * AES-256-GCM for environment secret values (PRD 8.3 / FR-SEC-5).
 * Stored form: base64(iv) . base64(tag) . base64(ciphertext). The row identity (environment id + name) is bound in
 * as AAD, so a ciphertext copied to another row or renamed fails authentication instead of decrypting.
 */
export class SecretsCrypto {
  private readonly key: Buffer;

  /** @param base64Key 32 random bytes, base64-encoded: `openssl rand -base64 32`. */
  constructor(base64Key: string) {
    const key = Buffer.from(base64Key, 'base64');
    if (key.length !== 32) throw new Error('SECRETS_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
    this.key = key;
  }

  static fromEnv(source: NodeJS.ProcessEnv = process.env): SecretsCrypto | null {
    const k = source.SECRETS_ENCRYPTION_KEY;
    return k ? new SecretsCrypto(k) : null;
  }

  encrypt(plaintext: string, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    c.setAAD(Buffer.from(aad, 'utf8'));
    const enc = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
  }

  decrypt(stored: string, aad: string): string {
    const parts = stored.split('.');
    if (parts.length !== 3) throw new Error('malformed secret');
    const [iv, tag, enc] = parts.map((p) => Buffer.from(p, 'base64'));
    const d = createDecipheriv('aes-256-gcm', this.key, iv);
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(tag);
    return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
  }
}

/** Names that are valid env var names and that the platform itself sets (a secret must never shadow them). */
export const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
export function isReservedSecretName(name: string): boolean {
  return name === 'PORT' || name.startsWith('AEGIS_');
}
