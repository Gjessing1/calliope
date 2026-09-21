import type { FastifyInstance } from 'fastify';
import { optimizeCover } from '@calliope/epub';
import { fetchCoverImage, lookupISBN, searchByTitle, searchCovers } from '@calliope/metadata';

/**
 * Cover images are proxied rather than loaded directly by the browser, for two
 * reasons: the Android app has no same-origin relationship with these hosts at
 * all, and a remote URL reaching `fetch` on the server is a request the server
 * makes — so the set of hosts it will make it to is pinned here.
 */
const ALLOWED_COVER_HOSTS = [
  'covers.openlibrary.org',
  'books.google.com',
  'books.googleusercontent.com',
  'is1-ssl.mzstatic.com',
  'is2-ssl.mzstatic.com',
  'is3-ssl.mzstatic.com',
  'is4-ssl.mzstatic.com',
  'is5-ssl.mzstatic.com',
];

export function isAllowedCoverUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:') return false;
    return ALLOWED_COVER_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

export function lookupRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { isbn?: string } }>('/api/lookup/isbn', async (req, reply) => {
    const isbn = req.query.isbn?.trim();
    if (!isbn) return reply.code(400).send({ error: 'isbn is required' });
    return lookupISBN(isbn);
  });

  app.get<{ Querystring: { title?: string } }>('/api/lookup/title', async (req, reply) => {
    const title = req.query.title?.trim();
    if (!title) return reply.code(400).send({ error: 'title is required' });
    return searchByTitle(title);
  });

  app.get<{ Querystring: { query?: string; isbn?: string } }>(
    '/api/lookup/covers',
    async (req, reply) => {
      const { query, isbn } = req.query;
      if (!query && !isbn) return reply.code(400).send({ error: 'query or isbn is required' });
      return { covers: await searchCovers(query, isbn) };
    },
  );

  app.get<{ Querystring: { url?: string } }>('/api/lookup/cover-proxy', async (req, reply) => {
    const url = req.query.url;
    if (!url || !isAllowedCoverUrl(url)) {
      return reply.code(400).send({ error: 'Not an allowed cover URL' });
    }

    const image = await fetchCoverImage(url);
    if (!image) return reply.code(502).send({ error: 'Could not fetch that cover' });

    // Re-encoded here rather than passed through: it normalizes the wildly
    // different sizes these sources return and strips whatever metadata came
    // with them, and it is the same bytes that would be written into the book.
    const optimized = await optimizeCover(image, { maxWidth: 1000, maxHeight: 1500 });
    return reply
      .header('Content-Type', 'image/jpeg')
      .header('Cache-Control', 'public, max-age=86400')
      .send(optimized);
  });
}
