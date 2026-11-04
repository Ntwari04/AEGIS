import { randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CHUNK, MAGIC, decryptStream, encryptStream, parseKey } from './crypto-stream';

const key = () => randomBytes(32);

async function collect(input: Buffer, ...transforms: any[]) {
  const out: Buffer[] = [];
  await (pipeline as any)(Readable.from([input]), ...transforms, async function* (src: AsyncIterable<Buffer>) { for await (const c of src) out.push(c); });
  return Buffer.concat(out);
}
const encrypt = (plain: Buffer, k: Buffer) => collect(plain, encryptStream(k));
const decrypt = (blob: Buffer, k: Buffer) => collect(blob, decryptStream(k));

describe('backup encryption (chunked AES-256-GCM)', () => {
  const k = key();

  it.each([0, 1, 100, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK, 5 * CHUNK + 7])('round-trips %i bytes', async (n) => {
    const plain = randomBytes(n);
    const blob = await encrypt(plain, k);
    expect((await decrypt(blob, k)).equals(plain)).toBe(true);
  });

  it('handles input arriving in arbitrary small pieces', async () => {
    const plain = randomBytes(3 * CHUNK + 123);
    const pieces: Buffer[] = [];
    for (let i = 0; i < plain.length; i += 1777) pieces.push(plain.subarray(i, i + 1777));
    const enc: Buffer[] = [];
    await pipeline(Readable.from(pieces), encryptStream(k), async function* (s: AsyncIterable<Buffer>) { for await (const c of s) enc.push(c); });
    const blob = Buffer.concat(enc);
    // and decrypt from tiny pieces too
    const small: Buffer[] = [];
    for (let i = 0; i < blob.length; i += 999) small.push(blob.subarray(i, i + 999));
    const out: Buffer[] = [];
    await pipeline(Readable.from(small), decryptStream(k), async function* (s: AsyncIterable<Buffer>) { for await (const c of s) out.push(c); });
    expect(Buffer.concat(out).equals(plain)).toBe(true);
  });

  it('never stores the plaintext and uses a fresh nonce prefix per archive', async () => {
    const plain = Buffer.from('SELECT secret FROM users; -- super sensitive '.repeat(50));
    const a = await encrypt(plain, k);
    const b = await encrypt(plain, k);
    expect(a.includes('super sensitive')).toBe(false);
    expect(a.subarray(0, 8).equals(MAGIC)).toBe(true);
    expect(a.subarray(8, 16).equals(b.subarray(8, 16))).toBe(false);
    expect(a.equals(b)).toBe(false);
  });

  it('rejects the wrong key', async () => {
    const blob = await encrypt(randomBytes(1000), k);
    await expect(decrypt(blob, key())).rejects.toThrow(/authentication/);
  });

  it('detects a flipped bit anywhere in the archive', async () => {
    const blob = await encrypt(randomBytes(2 * CHUNK + 50), k);
    for (const pos of [20, CHUNK + 30, blob.length - 1, blob.length - 20]) {
      const bad = Buffer.from(blob);
      bad[pos] ^= 1;
      await expect(decrypt(bad, k)).rejects.toThrow();
    }
  });

  it('detects truncation, including dropping whole trailing chunks', async () => {
    const blob = await encrypt(randomBytes(3 * CHUNK + 10), k);
    await expect(decrypt(blob.subarray(0, blob.length - 1), k)).rejects.toThrow();
    // drop the last (final) chunk exactly at a block boundary: the previous chunk was not flagged final
    const BLOCK = CHUNK + 16;
    await expect(decrypt(blob.subarray(0, 16 + 3 * BLOCK), k)).rejects.toThrow(/authentication/);
    await expect(decrypt(blob.subarray(0, 16), k)).rejects.toThrow();
    await expect(decrypt(Buffer.alloc(0), k)).rejects.toThrow();
  });

  it('detects reordered chunks', async () => {
    const blob = await encrypt(randomBytes(3 * CHUNK), k);
    const BLOCK = CHUNK + 16;
    const c0 = blob.subarray(16, 16 + BLOCK);
    const c1 = blob.subarray(16 + BLOCK, 16 + 2 * BLOCK);
    const swapped = Buffer.concat([blob.subarray(0, 16), c1, c0, blob.subarray(16 + 2 * BLOCK)]);
    await expect(decrypt(swapped, k)).rejects.toThrow(/authentication/);
  });

  it('releases NO plaintext from a tampered chunk, so a restore cannot run unverified SQL', async () => {
    const plain = randomBytes(4 * CHUNK);
    const blob = Buffer.from(await encrypt(plain, k));
    blob[16 + 10] ^= 1; // corrupt the FIRST chunk
    const released: Buffer[] = [];
    await expect(
      pipeline(Readable.from([blob]), decryptStream(k), async function* (s: AsyncIterable<Buffer>) { for await (const c of s) released.push(c); }),
    ).rejects.toThrow();
    expect(Buffer.concat(released).length).toBe(0);
  });

  it('rejects a file that is not a backup archive', async () => {
    await expect(decrypt(Buffer.from('this is plainly not an archive, just text'), k)).rejects.toThrow(/not an AegisOps backup/);
  });

  it('parseKey demands exactly 32 bytes', () => {
    expect(() => parseKey('')).toThrow();
    expect(() => parseKey(Buffer.alloc(31).toString('base64'))).toThrow('32 bytes');
    expect(parseKey(Buffer.alloc(32).toString('base64')).length).toBe(32);
  });
});
