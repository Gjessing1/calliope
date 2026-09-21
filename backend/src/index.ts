import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { loadConfig } from './config.js';
import { registerDeviceAuth } from './device-auth.js';
import { appReleaseRoutes } from './routes/app-release.js';
import { batchRoutes } from './routes/batch.js';
import { libraryRoutes } from './routes/library.js';
import { lookupRoutes } from './routes/lookup.js';
import { statusRoutes } from './routes/status.js';
import { AppState } from './state.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config = loadConfig();
const state = await AppState.open(config);

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  // Cover uploads and a metadata body with a long description; nothing here is
  // a file upload of a whole book, so this is generous rather than tuned.
  bodyLimit: 20 * 1024 * 1024,
});

// The Android app is a Capacitor WebView served from its own origin
// (capacitor://localhost or https://localhost), so it is cross-origin to this
// API by construction. The web app is same-origin and unaffected.
await app.register(cors, { origin: true });
registerDeviceAuth(app, config.deviceTokens);

appReleaseRoutes(app, config.dataDir);
statusRoutes(app, state);
libraryRoutes(app, state);
batchRoutes(app, state);
lookupRoutes(app);

// In production the built web app is copied to backend/public by the Dockerfile
// and served same-origin. In dev, Vite serves it and proxies /api here instead.
const publicDir = path.join(__dirname, '..', 'public');
if (existsSync(publicDir)) {
  await app.register(fastifyStatic, { root: publicDir });
  // SPA fallback: any non-API path that is not a file is a client-side route.
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    return reply.sendFile('index.html');
  });
}

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  state.close();
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await app.listen({ port: config.port, host: config.host });
app.log.info(
  { library: config.libraryRoot, data: config.dataDir, abs: Boolean(config.abs) },
  'calliope ready',
);

// Started after listen, not before: a first scan of a large library takes long
// enough that the container would fail its health check waiting for it.
if (config.scanOnStart) {
  void state
    .scan()
    .then((summary) => app.log.info(summary, 'initial scan complete'))
    .catch((err) => app.log.error({ err }, 'initial scan failed'));
}
