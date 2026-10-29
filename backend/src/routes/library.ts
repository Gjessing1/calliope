import type { FastifyInstance } from 'fastify';
import type { BookMetadata, MetadataUpdate } from '@calliope/core';
import type { LibrarySort } from '@calliope/library';
import { absMetadataPatch } from '@calliope/library';
import type { AbsField } from '@calliope/library';
import { getCoverBuffer, normalizeMetadata, optimizeCover, readEpub } from '@calliope/epub';
import { fetchCoverImage } from '@calliope/metadata';
import type { AppState } from '../state.js';
import { commitWrite, requestAbsRescan } from '../writes.js';
import { isAllowedCoverUrl } from './lookup.js';

interface ListQuery {
  search?: string;
  sort?: LibrarySort;
  /** `true`: only books whose file and Audiobookshelf disagree. */
  drift?: string;
  read?: string;
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

const ABS_FIELDS = new Set<AbsField>([
  'title',
  'authors',
  'series',
  'publisher',
  'date',
  'identifier',
  'language',
]);

const COVER_DATA = /^data:image\/(?:jpeg|png|webp|avif);base64,([A-Za-z0-9+/=]+)$/;

function uploadedCover(value: string): Buffer | null {
  const match = COVER_DATA.exec(value);
  if (!match) return null;
  const cover = Buffer.from(match[1]!, 'base64');
  return cover.length > 0 && cover.length <= 15 * 1024 * 1024 ? cover : null;
}

export function libraryRoutes(app: FastifyInstance, state: AppState): void {
  app.get<{ Querystring: ListQuery }>('/api/library', async (req, reply) => {
    if (req.query.read !== undefined && !['true', 'false'].includes(req.query.read)) {
      return reply.code(400).send({ error: 'Read filter must be true or false' });
    }
    const read = req.query.read === undefined ? undefined : req.query.read === 'true';
    const limit = Math.min(Number(req.query.limit ?? 200), 1000);
    const offset = Number(req.query.offset ?? 0);

    // Disagreement with ABS is computed per book at merge time, not stored, so
    // this filter walks the matching books. A personal library is small enough
    // for that to cost milliseconds.
    if (req.query.drift === 'true') {
      const differing = state.index
        .list({ search: req.query.search, sort: req.query.sort ?? 'title', read, limit: 100_000 })
        .map((book) => state.merge(book))
        .filter((book) => book.absDrift.length > 0);
      return {
        total: differing.length,
        limit,
        offset,
        scanning: state.isScanning,
        books: differing.slice(offset, offset + limit),
      };
    }

    const books = state.index.list({
      search: req.query.search,
      read,
      sort: req.query.sort ?? 'title',
      limit,
      offset,
    });

    return {
      total: state.index.count(req.query.search, read),
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

  app.patch<{ Params: { id: string }; Body: { fields?: string[] } }>(
    '/api/books/:id/audiobookshelf',
    async (req, reply) => {
      if (!state.abs) {
        return reply.code(404).send({ error: 'Audiobookshelf is not configured' });
      }
      const book = state.index.get(req.params.id);
      if (!book) return reply.code(404).send({ error: 'No such book' });
      const abs = state.index.getAbs(book.id);
      if (!abs) return reply.code(404).send({ error: 'This book is not linked to Audiobookshelf' });

      const requested = req.body?.fields;
      if (
        !Array.isArray(requested) ||
        requested.length === 0 ||
        requested.some((field) => !ABS_FIELDS.has(field as AbsField))
      ) {
        return reply.code(400).send({ error: 'Choose at least one supported metadata field' });
      }
      const fields = requested as AbsField[];

      try {
        const updated = await state.abs.updateMetadata(
          abs.id,
          absMetadataPatch(book.metadata, fields),
        );
        state.index.putAbs(book.id, updated);
        return { updated: true, book: state.merge(book) };
      } catch (error) {
        return reply.code(502).send({ error: (error as Error).message });
      }
    },
  );

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
      if (req.body.metadata.read !== undefined && typeof req.body.metadata.read !== 'boolean') {
        return reply.code(400).send({ error: 'Read status must be a boolean' });
      }
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

      const outcome = await commitWrite(state, req.params.id, req.body, {
        metadata: req.body.metadata,
        cover,
      });
      if (!outcome.ok) return reply.code(outcome.code).send({ error: outcome.error });
      const { ok: _ok, book, ...result } = outcome;
      return {
        saved: true,
        ...result,
        absRescan: await requestAbsRescan(state),
        book: state.merge(book),
      };
    },
  );

  app.post<{
    Params: { id: string; revisionId: string };
    Body: { expectedMtimeMs?: number; expectedFileSize?: number };
  }>('/api/books/:id/revisions/:revisionId/restore', async (req, reply) => {
    if (!state.index.get(req.params.id)) return reply.code(404).send({ error: 'No such book' });
    const replacement = await state.revisions.read(req.params.id, req.params.revisionId);
    if (!replacement) return reply.code(404).send({ error: 'No such revision' });

    // commitWrite captures the present file first, making the restore itself undoable.
    const outcome = await commitWrite(state, req.params.id, req.body ?? {}, { replacement });
    if (!outcome.ok) return reply.code(outcome.code).send({ error: outcome.error });
    const { ok: _ok, book, ...result } = outcome;
    return {
      saved: true,
      restored: true,
      ...result,
      absRescan: await requestAbsRescan(state),
      book: state.merge(book),
    };
  });
}
