import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  CreateBucketCommand, DeleteObjectCommand, GetObjectCommand, HeadBucketCommand, HeadObjectCommand, ListObjectsV2Command, S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';

/** Off-host storage for encrypted backup archives (FR-BACKUP-2): S3-compatible (DigitalOcean Spaces, AWS S3, MinIO, ...). */
export interface ObjectStore {
  /** Streams `body` to `key`; returns the stored size in bytes. Must fail (not truncate silently) if the stream errors. */
  put(key: string, body: Readable): Promise<void>;
  get(key: string): Promise<Readable>;
  size(key: string): Promise<number | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<{ key: string; size: number }[]>;
}

export interface S3Config {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO and some others need path-style URLs. */
  forcePathStyle?: boolean;
}

export class S3ObjectStore implements ObjectStore {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(cfg: S3Config) {
    this.bucket = cfg.bucket;
    this.s3 = new S3Client({
      region: cfg.region,
      endpoint: cfg.endpoint,
      forcePathStyle: cfg.forcePathStyle ?? false,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }

  /** Returns null when S3 is not configured (the caller then refuses to run backups rather than writing them to a local disk). */
  static fromEnv(env: NodeJS.ProcessEnv = process.env): S3ObjectStore | null {
    const { S3_BUCKET: bucket, S3_ACCESS_KEY_ID: accessKeyId, S3_SECRET_ACCESS_KEY: secretAccessKey } = env;
    if (!bucket || !accessKeyId || !secretAccessKey) return null;
    return new S3ObjectStore({
      bucket, accessKeyId, secretAccessKey,
      endpoint: env.S3_ENDPOINT || undefined,
      region: env.S3_REGION || 'us-east-1',
      forcePathStyle: env.S3_FORCE_PATH_STYLE === 'true',
    });
  }

  /** Create the bucket if it does not exist (used by local/test stores; production buckets are created by a human). */
  async ensureBucket() {
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.s3.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }

  async put(key: string, body: Readable) {
    // lib-storage does a multipart upload for streams of unknown length, and aborts the upload if the stream errors.
    const up = new Upload({ client: this.s3, params: { Bucket: this.bucket, Key: key, Body: body }, queueSize: 2, partSize: 8 * 1024 * 1024, leavePartsOnError: false });
    await up.done();
  }

  async get(key: string) {
    const res = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    return res.Body as Readable;
  }

  async size(key: string) {
    try {
      const res = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.ContentLength ?? null;
    } catch (e: any) {
      if (e?.$metadata?.httpStatusCode === 404 || e?.name === 'NotFound') return null;
      throw e;
    }
  }

  async delete(key: string) {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string) {
    const out: { key: string; size: number }[] = [];
    let token: string | undefined;
    do {
      const res = await this.s3.send(new ListObjectsV2Command({ Bucket: this.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of res.Contents ?? []) out.push({ key: o.Key!, size: o.Size ?? 0 });
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out;
  }
}

/** In-memory store for unit tests. Same contract, including "a failed stream stores nothing". */
export class MemoryObjectStore implements ObjectStore {
  readonly objects = new Map<string, Buffer>();

  async put(key: string, body: Readable) {
    const chunks: Buffer[] = [];
    for await (const c of body) chunks.push(Buffer.from(c));
    this.objects.set(key, Buffer.concat(chunks));
  }
  async get(key: string) {
    const o = this.objects.get(key);
    if (!o) throw new Error(`NoSuchKey: ${key}`);
    return Readable.from([o]);
  }
  async size(key: string) { return this.objects.get(key)?.length ?? null; }
  async delete(key: string) { this.objects.delete(key); }
  async list(prefix: string) {
    return [...this.objects].filter(([k]) => k.startsWith(prefix)).map(([key, v]) => ({ key, size: v.length }));
  }
  sha256(key: string) { return createHash('sha256').update(this.objects.get(key) ?? Buffer.alloc(0)).digest('hex'); }
}
