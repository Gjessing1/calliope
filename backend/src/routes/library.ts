import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { MetadataUpdate } from '@calliope/core';
import { normalizeMetadata, optimizeCover, readEpubFile, saveEpubFile } from '@calliope/epub';
import { fetchCoverImage } from '@calliope/metadata';
import type { AppState } from '../state.js';
import { resolveBookPath } from '../paths.js';

interface ListQuery {
  search?: string;
  sort?: 'title' | 'author' | 'series' | 'added';
  limit?: string;
  offset?: string;
}

export function libraryRoutes(app: FastifyInstance, state: AppState): void {
  app.get<{ Querystring: ListQuery }>('/api/library', async (req) => {
    const limit = Math.min(Number(req.query.limit ?? 200), 1000);
    const offset = Number(req.query.offset ?? 0);
    const books = state.index.list({
      search: req.query.search,
      sort: req.query.sort ?? 'title',
      limit,
      offset,
    });

    return {
      total: state.index.count(),
      limit,
      offset,
      scanning: state.isScanning,
      books: books.map((book) => state.merge(book)),
    };
  });

  app.post('/api/library/scan', async (req, reply) => {
    const force = (req.query as { force?: string }).force === 'true';
    // Deliberately not awaited: a full rescan of a large library outlives any
    // sensible HTTP timeout. The client polls /api/status.
    void state.scan(force);
    return reply.code(202).send({ started: true, scanning: true });
  });

  app.get<{ Params: { id: string } }>('/api/books/:id', async (req, reply) => {
    const book = state.index.get(req.params.id);
    if (!book) return reply.code(404).send({ error: 'No such book' });
    return state.merge(book);
  });

  app.get<{ Params: { id: string } }>('/api/books/:id/cover', async (req, reply) => {
    const cover = await state.covers.get(req.params.id);
    if (!cover) return reply.code(404).send({ error: 'No cover' });
    return (
      reply
        .header('Content-Type', 'image/jpeg')
        // The cache key is the book id, which does not change when the cover
        // does, so revalidation has to be forced rather than cached by time.
        .header('Cache-Control', 'no-cache')
        .send(cover)
    );
  });

  /** Preview what normalization would change, without writing anything. */
  app.post<{ Params: { id: string } }>('/api/books/:id/normalize', async (req, reply) => {
    const book = state.index.get(req.params.id);
    if (!book) return reply.code(404).send({ error: 'No such book' });
    return normalizeMetadata(book.metadata);
  });

  app.put<{ Params: { id: string }; Body: { metadata: MetadataUpdate; coverUrl?: string } }>(
    '/api/books/:id/metadata',
    async (req, reply) => {
      const book = state.index.get(req.params.id);
      if (!book) return reply.code(404).send({ error: 'No such book' });

      const absolute = resolveBookPath(state.config.libraryRoot, book.path);
      if (!absolute) return reply.code(400).send({ error: 'Book path is outside the library' });

      let cover: Buffer | null = null;
      if (req.body.coverUrl) {
        const downloaded = await fetchCoverImage(req.body.coverUrl);
        if (!downloaded) return reply.code(502).send({ error: 'Could not fetch that cover' });
        cover = await optimizeCover(downloaded);
      }

      const result = await saveEpubFile(absolute, req.body.metadata, {
        backup: state.config.backupOnSave,
        cover,
      });

      // Re-read rather than trusting the update we just sent: the file is now
      // the truth, and the writer may have combined, normalized or dropped
      // fields on the way in.
      const { metadata, version } = await readEpubFile(absolute);
      const refreshedCover = cover ?? (await readEpubFile(absolute)).cover;
      const hasCover = refreshedCover ? await state.covers.put(book.id, refreshedCover) : false;

      state.index.upsert({
        ...book,
        metadata,
        epubVersion: version,
        fileSize: result.bytes,
        mtimeMs: Date.now(),
        hasCover,
        scannedAt: Date.now(),
      });

      // Tell ABS immediately. Its own watcher would notice eventually, but a
      // user who just pressed Save should not have to wonder.
      let absRescan: 'ok' | 'failed' | 'skipped' = 'skipped';
      if (state.abs && state.config.abs?.rescanOnSave) {
        try {
          await state.abs.rescanAll();
          absRescan = 'ok';
        } catch {
          absRescan = 'failed';
        }
      }

      return {
        saved: true,
        warnings: result.warnings,
        backupPath: result.backupPath ? path.basename(result.backupPath) : null,
        bytes: result.bytes,
        absRescan,
        book: state.merge(state.index.get(book.id)!),
      };
    },
  );
}
