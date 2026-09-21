import type { ScanProgress } from '@calliope/core';

export function scanLabel(progress: ScanProgress | null | undefined): string {
  if (!progress) return 'Scanning…';
  if (progress.phase === 'discovering') {
    return progress.found === 0 ? 'Finding books…' : `Finding books · ${progress.found} found…`;
  }
  return `Scanning ${progress.current} of ${progress.total}…`;
}
