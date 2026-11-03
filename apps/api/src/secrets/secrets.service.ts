import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { SecretsCrypto, SECRET_NAME, isReservedSecretName } from './secrets-crypto';

/** What the deploy engine needs: the decrypted `KEY=VALUE` pairs for one environment. */
export interface SecretSource {
  forEnvironment(environmentId: string): Promise<string[]>;
}
export const SECRET_SOURCE = Symbol('SECRET_SOURCE');

const aad = (environmentId: string, name: string) => `${environmentId}:${name}`;

@Injectable()
export class SecretsService implements SecretSource {
  private crypto: SecretsCrypto | null;

  constructor(private readonly prisma: PrismaService) {
    this.crypto = SecretsCrypto.fromEnv();
  }

  /** For tests and tooling: construct with an explicit key instead of reading the environment. */
  static withCrypto(prisma: PrismaService, crypto: SecretsCrypto | null) {
    const s = new SecretsService(prisma);
    s.crypto = crypto;
    return s;
  }

  isConfigured() {
    return this.crypto !== null;
  }

  private need(): SecretsCrypto {
    if (!this.crypto) throw new ServiceUnavailableException('Secret storage is not configured (SECRETS_ENCRYPTION_KEY)');
    return this.crypto;
  }

  /** Names and timestamps only. Values are never returned by any API. */
  list(environmentId: string) {
    return this.prisma.environmentSecret.findMany({
      where: { environmentId }, orderBy: { name: 'asc' }, select: { name: true, updatedAt: true },
    });
  }

  async set(environmentId: string, name: string, value: string, userId?: string) {
    if (!SECRET_NAME.test(name)) throw new BadRequestException('Name must be UPPER_SNAKE_CASE (letters, digits, underscore; up to 64 characters)');
    if (isReservedSecretName(name)) throw new BadRequestException('That name is set by the platform (PORT, AEGIS_*)');
    if (value.length < 1 || value.length > 8192 || value.includes('\0')) throw new BadRequestException('Value must be 1-8192 characters');
    const valueEnc = this.need().encrypt(value, aad(environmentId, name));
    const row = await this.prisma.environmentSecret.upsert({
      where: { environmentId_name: { environmentId, name } },
      create: { environmentId, name, valueEnc, updatedById: userId },
      update: { valueEnc, updatedById: userId },
      select: { name: true, updatedAt: true },
    });
    return row;
  }

  async remove(environmentId: string, name: string) {
    await this.prisma.environmentSecret.deleteMany({ where: { environmentId, name } });
  }

  async forEnvironment(environmentId: string): Promise<string[]> {
    const rows = await this.prisma.environmentSecret.findMany({ where: { environmentId }, orderBy: { name: 'asc' } });
    if (rows.length === 0) return [];
    const c = this.need();
    return rows.map((r) => `${r.name}=${c.decrypt(r.valueEnc, aad(environmentId, r.name))}`);
  }
}
