import { randomBytes } from 'node:crypto';
import { SecretsCrypto, SECRET_NAME, isReservedSecretName } from './secrets-crypto';
import { SecretsService } from './secrets.service';

const key = () => randomBytes(32).toString('base64');

describe('SecretsCrypto', () => {
  it('round-trips and never stores the plaintext', () => {
    const c = new SecretsCrypto(key());
    const blob = c.encrypt('s3cr3t-value', 'env1:API_KEY');
    expect(blob).not.toContain('s3cr3t-value');
    expect(blob.split('.')).toHaveLength(3);
    expect(c.decrypt(blob, 'env1:API_KEY')).toBe('s3cr3t-value');
  });

  it('uses a fresh IV each time (same input, different ciphertext)', () => {
    const c = new SecretsCrypto(key());
    expect(c.encrypt('x', 'a:B')).not.toBe(c.encrypt('x', 'a:B'));
  });

  it('refuses a ciphertext moved to another row or renamed (AAD binding)', () => {
    const c = new SecretsCrypto(key());
    const blob = c.encrypt('v', 'env1:DB_PASSWORD');
    expect(() => c.decrypt(blob, 'env2:DB_PASSWORD')).toThrow();
    expect(() => c.decrypt(blob, 'env1:OTHER')).toThrow();
  });

  it('detects tampering and a different key', () => {
    const c = new SecretsCrypto(key());
    const [iv, tag, enc] = c.encrypt('value', 'e:N').split('.');
    const flipped = Buffer.from(enc, 'base64');
    flipped[0] ^= 1;
    expect(() => c.decrypt([iv, tag, flipped.toString('base64')].join('.'), 'e:N')).toThrow();
    expect(() => new SecretsCrypto(key()).decrypt([iv, tag, enc].join('.'), 'e:N')).toThrow();
    expect(() => c.decrypt('garbage', 'e:N')).toThrow('malformed');
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => new SecretsCrypto('')).toThrow();
    expect(() => new SecretsCrypto(Buffer.alloc(16).toString('base64'))).toThrow('32 bytes');
  });

  it('fromEnv is null when no key is set', () => {
    expect(SecretsCrypto.fromEnv({})).toBeNull();
    expect(SecretsCrypto.fromEnv({ SECRETS_ENCRYPTION_KEY: key() })).toBeInstanceOf(SecretsCrypto);
  });
});

describe('secret names', () => {
  it.each(['API_KEY', 'DB_URL', '_X', 'A1'])('accepts %s', (n) => expect(SECRET_NAME.test(n)).toBe(true));
  it.each(['api_key', '1ABC', 'HAS-DASH', 'HAS SPACE', '', 'A'.repeat(70), 'X\nY'])('rejects %j', (n) =>
    expect(SECRET_NAME.test(n)).toBe(false),
  );
  it('reserves platform variables', () => {
    expect(isReservedSecretName('PORT')).toBe(true);
    expect(isReservedSecretName('AEGIS_COMMIT')).toBe(true);
    expect(isReservedSecretName('MY_PORT')).toBe(false);
  });
});

describe('SecretsService', () => {
  function fakePrisma() {
    const rows = new Map<string, any>();
    return {
      rows,
      environmentSecret: {
        upsert: async ({ where, create, update }: any) => {
          const k = `${where.environmentId_name.environmentId}:${where.environmentId_name.name}`;
          const row = rows.has(k) ? { ...rows.get(k), ...update } : { ...create };
          rows.set(k, row);
          return { name: row.name, updatedAt: new Date() };
        },
        findMany: async ({ where }: any) =>
          [...rows.values()].filter((r) => r.environmentId === where.environmentId).sort((a, b) => a.name.localeCompare(b.name)),
        deleteMany: async ({ where }: any) => void rows.delete(`${where.environmentId}:${where.name}`),
      },
    } as any;
  }

  it('stores ciphertext only, and returns plaintext only through forEnvironment (deployer path)', async () => {
    const db = fakePrisma();
    const svc = SecretsService.withCrypto(db, new SecretsCrypto(key()));
    const out = await svc.set('e1', 'TOKEN', 'hunter2-hunter2', 'u1');
    expect(out).not.toHaveProperty('valueEnc');
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify([...db.rows.values()])).not.toContain('hunter2');
    expect(await svc.forEnvironment('e1')).toEqual(['TOKEN=hunter2-hunter2']);
    expect(await svc.forEnvironment('other-env')).toEqual([]);
  });

  it('rejects bad names, reserved names and bad values before touching the database', async () => {
    const svc = SecretsService.withCrypto(fakePrisma(), new SecretsCrypto(key()));
    await expect(svc.set('e', 'lower', 'v')).rejects.toThrow('UPPER_SNAKE_CASE');
    await expect(svc.set('e', 'PORT', 'v')).rejects.toThrow('set by the platform');
    await expect(svc.set('e', 'AEGIS_X', 'v')).rejects.toThrow('set by the platform');
    await expect(svc.set('e', 'OK', '')).rejects.toThrow('1-8192');
    await expect(svc.set('e', 'OK', 'a\0b')).rejects.toThrow('1-8192');
    await expect(svc.set('e', 'OK', 'x'.repeat(8193))).rejects.toThrow('1-8192');
  });

  it('fails closed when no encryption key is configured', async () => {
    const svc = SecretsService.withCrypto(fakePrisma(), null);
    expect(svc.isConfigured()).toBe(false);
    await expect(svc.set('e', 'OK', 'v')).rejects.toThrow('not configured');
    expect(await svc.forEnvironment('e')).toEqual([]); // nothing stored, nothing needed
  });
});
