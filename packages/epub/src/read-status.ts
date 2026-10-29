import type { MetaElement, OpfDocument, OpfMetadata } from './opf.js';
import { textOf } from './opf.js';

const VOCABULARY = 'https://books.gjessing.io/vocab#';
const LEGACY_NAME = 'calliope:read';

function prefixes(declaration: string): Map<string, string> {
  return new Map([...declaration.matchAll(/(\S+):\s+(\S+)/g)].map((m) => [m[1]!, m[2]!]));
}

function isReadElement(element: MetaElement, declared: Map<string, string>): boolean {
  if (element.$?.refines) return false;
  if (element.$?.name === LEGACY_NAME) return true;
  const [prefix, term] = (element.$?.property ?? '').split(':');
  return term === 'read' && declared.get(prefix ?? '') === VOCABULARY;
}

/** Resolve the vocabulary, so another vendor's `calliope:read` is never adopted. */
export function readStatus(meta: OpfMetadata, declaration: string): boolean {
  const declared = prefixes(declaration);
  const element = meta.meta?.find((m) => isReadElement(m, declared));
  return (element?.$?.content ?? textOf(element)).trim() === 'true';
}

/** Keep personal status in the file so deleting the disposable index loses nothing. */
export function writeReadStatus(pkg: OpfDocument['package'], read: boolean | undefined): void {
  if (read === undefined) return;
  if (typeof read !== 'boolean') throw new Error('Read status must be a boolean');
  const meta = pkg.metadata[0]!;
  const declared = prefixes(pkg.$?.prefix ?? '');
  const existing = meta.meta?.filter((m) => isReadElement(m, declared)) ?? [];
  if (read && existing.length) {
    for (const element of existing) {
      if (element.$?.name === LEGACY_NAME) element.$.content = 'true';
      else element._ = 'true';
    }
    return;
  }
  meta.meta = (meta.meta ?? []).filter((m) => !isReadElement(m, declared));
  if (!read) return;
  if (pkg.$?.version?.startsWith('2')) {
    meta.meta.push({ $: { name: LEGACY_NAME, content: 'true' } });
    return;
  }

  // EPUB 3 requires a declared vocabulary. Never rebind a vendor's prefix:
  // doing so would silently change the meaning of its existing metadata.
  let prefix = [...declared].find(([, uri]) => uri === VOCABULARY)?.[0];
  if (!prefix) {
    prefix = 'calliope';
    for (let suffix = 1; declared.has(prefix); suffix++) prefix = `calliope${suffix}`;
    const attrs = (pkg.$ ??= {});
    attrs.prefix = `${attrs.prefix ?? ''} ${prefix}: ${VOCABULARY}`.trim();
  }
  meta.meta.push({ $: { property: `${prefix}:read` }, _: 'true' });
}
