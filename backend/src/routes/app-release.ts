import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

interface AndroidRelease {
  versionCode: number;
  versionName: string;
  file: string;
  bytes: number;
  sha256: string;
}

interface WebUpdate {
  id: string;
  file: string;
  bytes: number;
  sha256: string;
  checksum: string;
  createdAt: string;
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

function safeFile(name: unknown, suffix: string): name is string {
  return (
    typeof name === 'string' &&
    name === path.basename(name) &&
    !name.startsWith('.') &&
    name.endsWith(suffix)
  );
}

async function sendFile(
  reply: FastifyReply,
  file: string,
  contentType: string,
  downloadName?: string,
): Promise<FastifyReply> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return reply.code(404).send({ error: 'Not published' });
    reply.header('content-type', contentType).header('content-length', String(info.size));
    if (downloadName) reply.header('content-disposition', `attachment; filename="${downloadName}"`);
    return reply.send(createReadStream(file));
  } catch {
    return reply.code(404).send({ error: 'Not published' });
  }
}

/** Public release metadata and artifacts used before the APK has an SSO session. */
export function appReleaseRoutes(app: FastifyInstance, dataDir: string): void {
  const appDir = path.join(dataDir, 'app');

  app.get('/api/app/version', async (_request, reply) => {
    const release = await readJson<AndroidRelease>(path.join(appDir, 'version.json'));
    if (!release || !safeFile(release.file, '.apk')) {
      return reply.code(404).send({ error: 'No Android release published' });
    }
    reply.header('cache-control', 'no-store');
    return {
      versionCode: release.versionCode,
      versionName: release.versionName,
      bytes: release.bytes,
      sha256: release.sha256,
      apkUrl: '/api/app/download',
    };
  });

  app.get('/api/app/download', async (_request, reply) => {
    const release = await readJson<AndroidRelease>(path.join(appDir, 'version.json'));
    if (!release || !safeFile(release.file, '.apk')) {
      return reply.code(404).send({ error: 'No Android release published' });
    }
    return sendFile(
      reply,
      path.join(appDir, release.file),
      'application/vnd.android.package-archive',
      release.file,
    );
  });

  app.get<{ Querystring: { runtimeVersion?: string; currentBundleId?: string } }>(
    '/api/app/update',
    async (request, reply) => {
      const { runtimeVersion, currentBundleId } = request.query;
      if (!runtimeVersion || !/^\d+$/.test(runtimeVersion)) {
        return reply.code(400).send({ error: 'runtimeVersion must be an integer' });
      }
      const update = await readJson<WebUpdate>(
        path.join(appDir, 'updates', runtimeVersion, 'current.json'),
      );
      if (!update || !safeFile(update.file, '.zip') || update.id === currentBundleId) {
        return reply.code(204).send();
      }
      reply.header('cache-control', 'no-store');
      return {
        ...update,
        url: `/api/app/update/download?runtimeVersion=${runtimeVersion}&id=${encodeURIComponent(update.id)}`,
      };
    },
  );

  app.get<{ Querystring: { runtimeVersion?: string; id?: string } }>(
    '/api/app/update/download',
    async (request, reply) => {
      const { runtimeVersion, id } = request.query;
      if (
        !runtimeVersion ||
        !/^\d+$/.test(runtimeVersion) ||
        !id ||
        !/^[0-9A-Za-z._-]+$/.test(id)
      ) {
        return reply.code(400).send({ error: 'runtimeVersion and id required' });
      }
      const updateDir = path.join(appDir, 'updates', runtimeVersion);
      return sendFile(reply, path.join(updateDir, `bundle-${id}.zip`), 'application/zip');
    },
  );
}
