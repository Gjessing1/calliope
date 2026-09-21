import type { FastifyInstance } from 'fastify';
import { SCHEMA_VERSION } from '@calliope/library';
import type { AppState } from '../state.js';

const GIT_SHA = process.env.GIT_SHA ?? 'dev';

export function statusRoutes(app: FastifyInstance, state: AppState): void {
  // Deliberately cheap and dependency-free: this is what the container's health
  // check and CI's smoke test call, so it must answer before the first scan
  // finishes and must not fail because ABS is down.
  app.get('/api/health', async () => ({ ok: true, gitSha: GIT_SHA }));

  /**
   * Re-read Audiobookshelf now, rather than at the next scan — after a person
   * fixed a disagreement on the ABS side and wants to see it resolved.
   */
  app.post('/api/abs/refresh', async (_req, reply) => {
    if (!state.abs) return reply.code(404).send({ error: 'Audiobookshelf is not configured' });
    await state.refreshAbs();
    if (state.absError) return reply.code(502).send({ error: state.absError });
    return { refreshed: true };
  });

  app.get('/api/status', async () => ({
    gitSha: GIT_SHA,
    schemaVersion: SCHEMA_VERSION,
    library: {
      root: state.config.libraryRoot,
      books: state.index.count(),
      scanning: state.isScanning,
      scanProgress: state.scanProgress,
      lastScan: state.lastScan,
    },
    audiobookshelf: state.abs
      ? {
          configured: true,
          url: state.config.abs?.url,
          publicUrl: state.config.abs?.publicUrl ?? null,
          error: state.absError,
        }
      : { configured: false },
    backupOnSave: state.config.backupOnSave,
    revisionLimit: state.config.revisionLimit,
  }));
}
