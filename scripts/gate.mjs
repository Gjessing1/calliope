#!/usr/bin/env node
// The pre-push quality gate: format → lint → build → typecheck → tests, with the
// one expensive part made conditional on what actually changed.
//
// The local `docker build` proves exactly one thing the fast stages cannot: that
// the *image* is assemblable and complete — a workspace missing from the runtime
// stage, a package-lock.json with no entry for a newly added dependency. Neither
// shows up as a type error or a failing test; both show up as a container that
// will not boot. Only a change to the dependency/packaging surface can break it,
// so it runs only then. CI builds and boots the image on every push regardless,
// so nothing is ever skipped on the path that decides a deploy.
//
// Usage: npm run gate [--docker] [--no-docker] [--dry] [--since <ref>]
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const sinceArg = argv.indexOf('--since');
const since = sinceArg === -1 ? null : argv[sinceArg + 1];

const git = (args) => {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};

// Everything this working tree would push: committed-but-unpushed, staged,
// unstaged, and untracked. Falls back to the last commit when there is no
// upstream yet (fresh clone, detached CI checkout).
const baseRef =
  since ?? git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']) ?? '';
const changed = new Set(
  [
    baseRef
      ? git(['diff', '--name-only', `${baseRef}...HEAD`])
      : git(['diff', '--name-only', 'HEAD~1']),
    git(['diff', '--name-only', 'HEAD']),
    git(['ls-files', '--others', '--exclude-standard']),
  ]
    .join('\n')
    .split('\n')
    .map((f) => f.trim())
    .filter(Boolean),
);

// Packaging surface: what the image build proves and the fast gate cannot.
const imageRisk = [...changed].filter(
  (f) =>
    f === 'package-lock.json' ||
    f === '.dockerignore' ||
    f.endsWith('package.json') ||
    f.startsWith('backend/Dockerfile') ||
    f.startsWith('.forgejo/'),
);

const runDocker = has('--docker') || (imageRisk.length > 0 && !has('--no-docker'));

const stages = [
  ['format:check', ['npm', ['run', 'format:check']]],
  ['lint', ['npm', ['run', 'lint']]],
  ['build', ['npm', ['run', 'build']]],
  ['typecheck', ['npm', ['run', 'typecheck']]],
  ['test', ['npm', ['test']]],
  ...(runDocker
    ? [
        [
          'docker build',
          ['docker', ['build', '-f', 'backend/Dockerfile', '-t', 'calliope-gate', '.']],
        ],
      ]
    : []),
];

console.log(`gate: ${changed.size} changed file(s) vs ${baseRef || 'HEAD~1'}`);
const imageVerdict = runDocker
  ? `gate: image build INCLUDED (${imageRisk.slice(0, 3).join(', ')}${imageRisk.length > 3 ? ', …' : ''})`
  : imageRisk.length > 0
    ? `gate: image build REQUIRED by ${imageRisk.length} packaging file(s) but skipped via --no-docker — only CI will prove the image`
    : 'gate: image build skipped (no dependency/packaging change) — CI still builds it';
console.log(imageVerdict);
// --dry answers "what would this run cost?" without spending it.
if (has('--dry')) {
  console.log(`gate: --dry, would run: ${stages.map(([name]) => name).join(' → ')}`);
  process.exit(0);
}

const timings = [];
for (const [name, [cmd, args]] of stages) {
  const started = Date.now();
  console.log(`\n=== ${name} ===`);
  try {
    execFileSync(cmd, args, { cwd: root, stdio: 'inherit' });
  } catch {
    const failed = ((Date.now() - started) / 1000).toFixed(0);
    console.error(`\ngate: FAILED at ${name} after ${failed}s`);
    process.exit(1);
  }
  timings.push([name, ((Date.now() - started) / 1000).toFixed(0)]);
}

const total = timings.reduce((sum, [, s]) => sum + Number(s), 0);
console.log('\ngate: PASSED');
for (const [name, seconds] of timings) console.log(`  ${name.padEnd(14)} ${seconds}s`);
console.log(`  ${'total'.padEnd(14)} ${total}s`);
if (!runDocker) console.log(`  (${imageVerdict.replace('gate: ', '')})`);
