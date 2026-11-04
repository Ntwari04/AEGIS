import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import { APP_ENV, type AppEnv } from '../config/env';

export const DATA_QUEUE = 'data-jobs';

export type DataJob =
  | { name: 'backup'; data: { target: string; requestedById: string } }
  | { name: 'restore'; data: { backupJobId: string; requestedById: string; reason?: string } }
  | { name: 'drill'; data: Record<string, never> };

export interface DataJobQueue {
  enqueue(job: DataJob): Promise<void>;
}
export const DATA_JOB_QUEUE = Symbol('DATA_JOB_QUEUE');

/** The API only ENQUEUES: it never touches the backup role, the encryption key or object storage. The data worker does the work. */
@Injectable()
export class BullDataJobQueue implements DataJobQueue, OnModuleDestroy {
  private readonly queue: Queue;
  constructor(@Inject(APP_ENV) env: AppEnv) {
    const u = new URL(env.redisUrl);
    this.queue = new Queue(DATA_QUEUE, { connection: { host: u.hostname, port: Number(u.port || 6379), password: decodeURIComponent(u.password), lazyConnect: true } });
  }
  async enqueue(job: DataJob) {
    await this.queue.add(job.name, job.data, { removeOnComplete: 200, removeOnFail: 200, attempts: 1 });
  }
  onModuleDestroy() {
    return this.queue.close();
  }
}
