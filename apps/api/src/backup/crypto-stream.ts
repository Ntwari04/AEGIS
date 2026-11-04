import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';

/**
 * Streaming authenticated encryption for backup archives (FR-BACKUP-2, PRD 8.4).
 *
 * Why chunked: a backup is restored by piping the decrypted stream straight into `psql`. With one big AES-GCM message the
 * authentication tag is only checked at the very end, so a tampered archive would already have executed attacker-chosen SQL.
 * Here every 64 KiB chunk is its own AES-256-GCM message, authenticated BEFORE a single byte of it is released, and the
 * chunk index and a "final" flag are bound in as AAD, so reordering, dropping or truncating chunks is detected too (STREAM construction).
 *
 * Layout: MAGIC(8) | noncePrefix(8) | chunk* where chunk = ciphertext(<=CHUNK) | tag(16).
 * Nonce for chunk i = noncePrefix(8) | i as uint32 BE (unique per chunk under one key; prefix is random per file).
 * Every chunk except the last holds exactly CHUNK plaintext bytes; the last (possibly empty) one is flagged final.
 */
export const MAGIC = Buffer.from('AEGISBK1', 'ascii');
export const CHUNK = 64 * 1024;
const TAG = 16;
const HEADER = MAGIC.length + 8;

export function parseKey(base64Key: string): Buffer {
  const key = Buffer.from(base64Key, 'base64');
  if (key.length !== 32) throw new Error('BACKUP_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
  return key;
}

const nonceFor = (prefix: Buffer, index: number) => {
  const n = Buffer.alloc(12);
  prefix.copy(n, 0);
  n.writeUInt32BE(index, 8);
  return n;
};
const aadFor = (index: number, final: boolean) => {
  const a = Buffer.alloc(MAGIC.length + 5);
  MAGIC.copy(a, 0);
  a.writeUInt32BE(index, MAGIC.length);
  a.writeUInt8(final ? 1 : 0, MAGIC.length + 4);
  return a;
};

export function encryptStream(key: Buffer): Transform {
  const prefix = randomBytes(8);
  let index = 0;
  let buf = Buffer.alloc(0);
  let wroteHeader = false;

  const seal = (plain: Buffer, final: boolean) => {
    const c = createCipheriv('aes-256-gcm', key, nonceFor(prefix, index));
    c.setAAD(aadFor(index, final));
    const out = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]);
    index++;
    if (index > 0xffffffff) throw new Error('backup too large for one archive');
    return out;
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        if (!wroteHeader) { this.push(Buffer.concat([MAGIC, prefix])); wroteHeader = true; }
        buf = Buffer.concat([buf, chunk]);
        // Hold back: only emit a chunk as non-final once MORE data is known to follow it.
        while (buf.length > CHUNK) {
          this.push(seal(buf.subarray(0, CHUNK), false));
          buf = buf.subarray(CHUNK);
        }
        cb();
      } catch (e) { cb(e as Error); }
    },
    flush(cb: TransformCallback) {
      try {
        if (!wroteHeader) { this.push(Buffer.concat([MAGIC, prefix])); wroteHeader = true; }
        this.push(seal(buf, true));
        cb();
      } catch (e) { cb(e as Error); }
    },
  });
}

export function decryptStream(key: Buffer): Transform {
  let header = Buffer.alloc(0);
  let prefix: Buffer | undefined;
  let index = 0;
  let buf = Buffer.alloc(0);
  const BLOCK = CHUNK + TAG;

  const open = (block: Buffer, final: boolean) => {
    if (block.length < TAG) throw new Error('backup archive is truncated or corrupt');
    const d = createDecipheriv('aes-256-gcm', key, nonceFor(prefix!, index));
    d.setAAD(aadFor(index, final));
    d.setAuthTag(block.subarray(block.length - TAG));
    try {
      const plain = Buffer.concat([d.update(block.subarray(0, block.length - TAG)), d.final()]);
      index++;
      return plain;
    } catch {
      throw new Error('backup archive failed authentication (wrong key, tampered, truncated or reordered)');
    }
  };

  return new Transform({
    transform(chunk: Buffer, _enc, cb: TransformCallback) {
      try {
        let data = chunk;
        if (!prefix) {
          header = Buffer.concat([header, data]);
          if (header.length < HEADER) return cb();
          if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('not an AegisOps backup archive');
          prefix = Buffer.from(header.subarray(MAGIC.length, HEADER));
          data = header.subarray(HEADER);
        }
        buf = Buffer.concat([buf, data]);
        // A full block is non-final only if more bytes follow it, so keep at least one byte back.
        while (buf.length > BLOCK) {
          this.push(open(buf.subarray(0, BLOCK), false));
          buf = buf.subarray(BLOCK);
        }
        cb();
      } catch (e) { cb(e as Error); }
    },
    flush(cb: TransformCallback) {
      try {
        if (!prefix) throw new Error('backup archive is truncated or corrupt');
        this.push(open(buf, true));
        cb();
      } catch (e) { cb(e as Error); }
    },
  });
}
