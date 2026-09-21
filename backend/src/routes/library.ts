import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { BookMetadata, MetadataUpdate } from '@calliope/core';
import type { LibrarySort } from '@calliope/library';
import {
  getCoverBuffer,
  normalizeMetadata,
  optimizeCover,
  readEpub,
  readEpubFile,
  saveEpubFile,
} from '@calliope/epub';
import { fetchCoverImage } from '@calliope/metadata';
import type { AppState } from '../state.js';
import { resolveBookPath } from '../paths.js';
import { isAllowedCoverUrl } from './lookup.js';

interface ListQuery {
  search?: string;
  sort?: LibrarySort;
  limit?: string;
  offset?: string;
}

interface SaveBody {
  metadata: MetadataUpdate;
  coverUrl?: string;
  coverData?: string;
  coverRevisionId?: string;
  expectedMtimeMs?: number;
  expectedFileSize?: number;
}

const COVER_DATA = /^data:image\/(?:jpeg|png|webp|avif);base64,([A-Za-z0-9+/=]+)$/;

function uploadedCover(value: string): Buffer | null {
  const match = COVER_DATA.exec(value);
  if (!match) return null;
  const cover = Buffer.from(match[1]!, 'base64');
  return cover.length > 0 && cover.length <= 15 * 1024 * 1024 ? cover : null;
}

async function refreshAfterWrite(
  state: AppState,
  bookId: string,
  absolute: string,
  bytes: number,
): Promise<void> {
  const book = state.index.get(bookId)!;
  const [{ metadata, version, cover }, file] = await Promise.all([
    readEpubFile(absolute),
    stat(absolute),
  ]);
  const hasCover = cover ? await state.covers.put(book.id, cover) : false;
  if (!cover) await state.covers.remove(book.id);

  state.index.upsert({
    ...book,
    metadata,
    epubVersion: version,
    fileSize: bytes,
    mtimeMs: file.mtimeMs,
    hasCover,
    scannedAt: Date.now(),
  });
}

async function requestAbsRescan(state: AppState): Promise<'ok' | 'failed' | 'skipped'> {
  if (!state.abs || !state.config.abs?.rescanOnSave) return 'skipped';
  try {
    await state.abs.rescanAll();
    return 'ok';
  } catch {
    return 'failed';
  }
}

function conflict(reply: FastifyReply): FastifyReply {
  return reply.code(409).send({
    error:
      'This book changed after the editor was opened. Close it, review the latest file, and try again.',
  });
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
      total: state.index.count(req.query.search),
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
    return reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'no-cache')
      .send(cover);
  });

  app.get<{ Params: { id: string } }>('/api/books/:id/revisions', async (req, reply) => {
    if (!state.index.get(req.params.id)) return reply.code(404).send({ error: 'No such book' });
    return {
      revisions: await state.revisions.listComparedTo(
        req.params.id,
        await state.covers.get(req.params.id),
      ),
    };
  });

  app.get<{ Params: { id: string; revisionId: string } }>(
    '/api/books/:id/revisions/:revisionId/cover',
    async (req, reply) => {
      if (!state.index.get(req.params.id)) return reply.code(404).send({ error: 'No such book' });
      const thumbnail = await state.revisions.cover(req.params.id, req.params.revisionId);
      if (!thumbnail) return reply.code(404).send({ error: 'No cover in this revision' });
      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'private, max-age=31536000, immutable')
        .send(thumbnail);
    },
  );

  /** Preview what normalization would change, without writing anything. */
  app.post<{ Params: { id: string }; Body: { metadata?: BookMetadata } }>(
    '/api/books/:id/normalize',
    async (req, reply) => {
      const book = state.index.get(req.params.id);
      if (!book) return reply.code(404).send({ error: 'No such book' });
      return normalizeMetadata(req.body?.metadata ?? book.metadata);
    },
  );

  app.put<{ Params: { id: string }; Body: SaveBody }>(
    '/api/books/:id/metadata',
    async (req, reply) => {
      if (!req.body?.metadata) return reply.code(400).send({ error: 'Metadata is required' });
      if (!state.index.get(req.params.id)) return reply.code(404).send({ error: 'No such book' });
      let cover: Buffer | null = null;
      const coverSources = [req.body.coverUrl, req.body.coverData, req.body.coverRevisionId].filter(
        Boolean,
      );
      if (coverSources.length > 1) {
        return reply.code(400).send({ error: 'Choose one cover source' });
      }
      if (req.body.coverUrl) {
        if (!isAllowedCoverUrl(req.body.coverUrl)) {
          return reply.code(400).send({ error: 'That cover URL is not from a supported provider' });
        }
        const downloaded = await fetchCoverImage(req.body.coverUrl);
        if (!downloaded) return reply.code(502).send({ error: 'Could not fetch that cover' });
        cover = await optimizeCover(downloaded);
      } else if (req.body.coverData) {
        const uploaded = uploadedCover(req.body.coverData);
        if (!uploaded) {
          return reply
            .code(400)
            .send({ error: 'Cover must be a JPEG, PNG, WebP or AVIF under 15 MB' });
        }
        cover = await optimizeCover(uploaded);
      } else if (req.body.coverRevisionId) {
        const snapshot = await state.revisions.read(req.params.id, req.body.coverRevisionId);
        if (!snapshot) return reply.code(404).send({ error: 'No such revision' });
        const opened = await readEpub(snapshot);
        const previousCover = await getCoverBuffer(opened.zip, opened.opf, opened.opfPath);
        if (!previousCover) return reply.code(400).send({ error: 'That revision has no cover' });
        cover = await optimizeCover(previousCover);
      }

      return state.writeBook(req.params.id, async () => {
        const book = state.index.get(req.params.id);
        if (!book) return reply.code(404).send({ error: 'No such book' });
        if (
          (req.body.expectedMtimeMs !== undefined && req.body.expectedMtimeMs !== book.mtimeMs) ||
          (req.body.expectedFileSize !== undefined && req.body.expectedFileSize !== book.fileSize)
        ) {
          return conflict(reply);
        }

        const absolute = resolveBookPath(state.config.libraryRoot, book.path);
        if (!absolute) return reply.code(400).send({ error: 'Book path is outside the library' });
        const file = await stat(absolute);
        if (
          (req.body.expectedMtimeMs !== undefined &&
            Math.abs(file.mtimeMs - req.body.expectedMtimeMs) > 1) ||
          (req.body.expectedFileSize !== undefined && file.size !== req.body.expectedFileSize)
        ) {
          return conflict(reply);
        }

        const revision = await state.revisions.capture(book.id, absolute, {
          metadata: book.metadata,
          hasCover: book.hasCover,
          thumbnail: await state.covers.get(book.id),
        });
        const result = await saveEpubFile(absolute, req.body.metadata, {
          backup: state.config.backupOnSave,
          cover,
        });
        await refreshAfterWrite(state, book.id, absolute, result.bytes);
        const absRescan = await requestAbsRescan(state);

        return {
          saved: true,
          warnings: result.warnings,
          backupPath: result.backupPath ? path.basename(result.backupPath) : null,
          revision,
          bytes: result.bytes,
          absRescan,
          book: state.merge(state.index.get(book.id)!),
        };
      });
    },
  );

  app.post<{
    Params: { id: string; revisionId: string };
    Body: { expectedMtimeMs?: number; expectedFileSize?: number };
  }>('/api/books/:id/revisions/:revisionId/restore', async (req, reply) =>
    state.writeBook(req.params.id, async () => {
      const book = state.index.get(req.params.id);
      if (!book) return reply.code(404).send({ error: 'No such book' });
      if (
        (req.body?.expectedMtimeMs !== undefined && req.body.expectedMtimeMs !== book.mtimeMs) ||
        (req.body?.expectedFileSize !== undefined && req.body.expectedFileSize !== book.fileSize)
      ) {
        return conflict(reply);
      }
      const absolute = resolveBookPath(state.config.libraryRoot, book.path);
      if (!absolute) return reply.code(400).send({ error: 'Book path is outside the library' });
      const file = await stat(absolute);
      if (
        (req.body?.expectedMtimeMs !== undefined &&
          Math.abs(file.mtimeMs - req.body.expectedMtimeMs) > 1) ||
        (req.body?.expectedFileSize !== undefined && file.size !== req.body.expectedFileSize)
      ) {
        return conflict(reply);
      }

      const replacement = await state.revisions.read(book.id, req.params.revisionId);
      if (!replacement) return reply.code(404).send({ error: 'No such revision' });

      // Capture the present file first, making restoration itself undoable.
      const revision = await state.revisions.capture(book.id, absolute, {
        metadata: book.metadata,
        hasCover: book.hasCover,
        thumbnail: await state.covers.get(book.id),
      });
      const result = await saveEpubFile(
        absolute,
        {},
        {
          backup: state.config.backupOnSave,
          replacement,
        },
      );
      await refreshAfterWrite(state, book.id, absolute, result.bytes);
      const absRescan = await requestAbsRescan(state);

      return {
        saved: true,
        restored: true,
        warnings: result.warnings,
        backupPath: result.backupPath ? path.basename(result.backupPath) : null,
        revision,
        bytes: result.bytes,
        absRescan,
        book: state.merge(state.index.get(book.id)!),
      };
    }),
  );
}
