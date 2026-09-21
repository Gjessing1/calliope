import type { FastifyInstance } from 'fastify';
import type {
  BatchItemResult,
  BatchJob,
  BatchOperation,
  MergedBook,
  MetadataUpdate,
} from '@calliope/core';
import { planBatch } from '@calliope/library';
import type { AppState } from '../state.js';
import { commitWrite, requestAbsRescan } from '../writes.js';

interface BatchItem {
  id: string;
  update: MetadataUpdate;
  expectedMtimeMs: number;
  expectedFileSize: number;
}

const OPERATIONS = new Set<BatchOperation['kind']>([
  'series',
  'language',
  'publisher',
  'subjects',
  'author',
  'tidy',
  'abs',
]);

/** The keys a batch may write. Anything else in a client's update is dropped. */
const UPDATE_KEYS: ReadonlyArray<keyof MetadataUpdate> = [
  'title',
  'subtitle',
  'authors',
  'contributors',
  'language',
  'identifier',
  'publisher',
  'date',
  'description',
  'rights',
  'series',
  'seriesIndex',
  'subjects',
];

const MAX_BOOKS = 5000;

function cleanUpdate(update: unknown): MetadataUpdate {
  const source = (update ?? {}) as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const key of UPDATE_KEYS) if (source[key] !== undefined) clean[key] = source[key];
  return clean as MetadataUpdate;
}

/**
 * One batch at a time, written book by book in the background.
 *
 * Each book goes through `commitWrite` exactly as an editor save does — its own
 * history entry, its own conflict check — so a batch is N ordinary, individually
 * undoable saves, not a new kind of write. Audiobookshelf is asked to rescan
 * once at the end rather than once per book.
 */
class BatchRunner {
  current: BatchJob | null = null;

  constructor(private readonly state: AppState) {}

  get running(): boolean {
    return this.current !== null && this.current.finishedAt === null;
  }

  start(label: string, items: BatchItem[]): BatchJob {
    const job: BatchJob = {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      label,
      startedAt: Date.now(),
      finishedAt: null,
      total: items.length,
      results: [],
      absRescan: null,
    };
    this.current = job;
    void this.run(job, items);
    return job;
  }

  private async run(job: BatchJob, items: BatchItem[]): Promise<void> {
    for (const item of items) {
      const book = this.state.index.get(item.id);
      const title = book?.metadata.title || book?.folder || item.id;
      let result: BatchItemResult;
      try {
        const outcome = await commitWrite(this.state, item.id, item, { metadata: item.update });
        result = outcome.ok
          ? { id: item.id, title, status: 'saved', warnings: outcome.warnings }
          : {
              id: item.id,
              title,
              status:
                outcome.code === 409 ? 'conflict' : outcome.code === 404 ? 'missing' : 'failed',
              message: outcome.error,
              warnings: [],
            };
      } catch (err) {
        result = {
          id: item.id,
          title,
          status: 'failed',
          message: (err as Error).message,
          warnings: [],
        };
      }
      job.results.push(result);
    }

    job.absRescan = job.results.some((r) => r.status === 'saved')
      ? await requestAbsRescan(this.state)
      : 'skipped';
    job.finishedAt = Date.now();
  }
}

export function batchRoutes(app: FastifyInstance, state: AppState): void {
  const runner = new BatchRunner(state);

  /** What an operation would do to each selected book. Writes nothing. */
  app.post<{ Body: { ids?: string[]; operation?: BatchOperation } }>(
    '/api/batch/preview',
    async (req, reply) => {
      const { ids, operation } = req.body ?? {};
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > MAX_BOOKS) {
        return reply.code(400).send({ error: `Select between 1 and ${MAX_BOOKS} books` });
      }
      if (!operation || !OPERATIONS.has(operation.kind)) {
        return reply.code(400).send({ error: 'Unknown batch operation' });
      }
      const books: MergedBook[] = [];
      const missing: string[] = [];
      const health = state.health();
      for (const id of new Set(ids)) {
        const book = state.index.get(id);
        if (book) books.push(state.merge(book, health.get(book.id) ?? []));
        else missing.push(id);
      }
      return { ...planBatch(books, operation), missing };
    },
  );

  /** Write a reviewed plan. Answers at once; the client polls GET /api/batch. */
  app.post<{ Body: { label?: string; items?: BatchItem[] } }>(
    '/api/batch/apply',
    async (req, reply) => {
      if (runner.running) {
        return reply.code(409).send({ error: 'A batch is already being written' });
      }
      const items = req.body?.items;
      if (!Array.isArray(items) || items.length === 0 || items.length > MAX_BOOKS) {
        return reply.code(400).send({ error: `Send between 1 and ${MAX_BOOKS} books` });
      }
      const clean = items.map((item) => ({
        id: String(item.id),
        update: cleanUpdate(item.update),
        expectedMtimeMs: Number(item.expectedMtimeMs),
        expectedFileSize: Number(item.expectedFileSize),
      }));
      // Without the reviewed file state there is nothing to detect a conflict
      // against, and a batch is the last place to overwrite an edit blindly.
      if (clean.some((i) => !Number.isFinite(i.expectedMtimeMs + i.expectedFileSize))) {
        return reply
          .code(400)
          .send({ error: 'Every book needs the file state it was reviewed at' });
      }
      const label = String(req.body?.label ?? 'Batch edit').slice(0, 200);
      return reply.code(202).send(runner.start(label, clean));
    },
  );

  /** The running batch, or the last one to finish, or null. */
  app.get('/api/batch', async () => ({ job: runner.current }));
}
