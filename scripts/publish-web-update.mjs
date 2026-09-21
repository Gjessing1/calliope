#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import JSZip from 'jszip';

const [sourceArg, dataArg, runtimeVersion, bundleId] = process.argv.slice(2);
if (
  !sourceArg ||
  !dataArg ||
  !/^\d+$/.test(runtimeVersion ?? '') ||
  !bundleId ||
  !/^[0-9A-Za-z._-]+$/.test(bundleId)
) {
  console.error(
    'usage: publish-web-update.mjs <web-dist> <data-dir> <runtime-version> <bundle-id>',
  );
  process.exit(1);
}

const source = path.resolve(sourceArg);
const updateDir = path.resolve(dataArg, 'app', 'updates', runtimeVersion);
const zip = new JSZip();

async function addTree(dir, prefix = '') {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = path.join(dir, entry.name);
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) await addTree(absolute, relative);
    else if (entry.isFile()) zip.file(relative, await readFile(absolute));
  }
}

await addTree(source);
const bytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
await mkdir(updateDir, { recursive: true });
const file = `bundle-${bundleId}.zip`;
const zipTmp = path.join(updateDir, `.${file}.${process.pid}`);
await writeFile(zipTmp, bytes, { mode: 0o644 });
await rename(zipTmp, path.join(updateDir, file));

const digest = createHash('sha256').update(bytes).digest();
const metadata = {
  id: bundleId,
  file,
  bytes: bytes.length,
  sha256: digest.toString('hex'),
  checksum: digest.toString('base64'),
  createdAt: new Date().toISOString(),
};
const metadataTmp = path.join(updateDir, `.current.json.${process.pid}`);
await writeFile(metadataTmp, `${JSON.stringify(metadata)}\n`, { mode: 0o644 });
await rename(metadataTmp, path.join(updateDir, 'current.json'));

// Keep the current bundle plus two fallbacks. A client already downloading an
// older file therefore survives two subsequent deploys instead of racing a
// cleanup that removes the bytes beneath it.
const old = (
  await Promise.all(
    (await readdir(updateDir))
      .filter((name) => name.startsWith('bundle-') && name.endsWith('.zip') && name !== file)
      .map(async (name) => ({ name, mtimeMs: (await stat(path.join(updateDir, name))).mtimeMs })),
  )
).sort((a, b) => b.mtimeMs - a.mtimeMs);
await Promise.all(old.slice(2).map(({ name }) => unlink(path.join(updateDir, name))));

console.log(`Published web bundle ${bundleId} for native runtime ${runtimeVersion}`);
