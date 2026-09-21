import path from 'node:path';

/**
 * Resolve a library-relative path to an absolute one, refusing anything that
 * escapes the library root.
 *
 * The id→path lookup goes through the index, so a traversal would need a
 * poisoned index row rather than a crafted request — but this is the only place
 * a path from stored data becomes a filesystem write, and the cost of checking
 * is one `startsWith`.
 */
export function resolveBookPath(root: string, relativePath: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    return null;
  }
  return resolved;
}
