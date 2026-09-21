import path from 'node:path';

/**
 * Configuration, all from the environment.
 *
 * Two of these decide where user data lives and are therefore required to be
 * explicit in production; the rest have defaults that make `npm run dev` work
 * with no setup at all.
 */
export interface Config {
  port: number;
  host: string;
  /** The ebook library. Read-write: this is where metadata edits land. */
  libraryRoot: string;
  /** Calliope's own state: index, cover cache and revisions. Never inside the library. */
  dataDir: string;
  /** Number of full pre-write EPUB snapshots retained per book. */
  revisionLimit: number;
  /** Keep a `.bak` beside a book on every save. */
  backupOnSave: boolean;
  /** Walk the library on startup. */
  scanOnStart: boolean;
  abs: {
    url: string;
    token: string;
    booksRoot: string;
    libraryId?: string;
    /** Ask ABS to rescan after a write. Requires a token with admin rights. */
    rescanOnSave: boolean;
  } | null;
}

const bool = (value: string | undefined, fallback: boolean): boolean =>
  value === undefined ? fallback : /^(1|true|yes|on)$/i.test(value);

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const dataDir = env.CALLIOPE_DATA_DIR ?? path.resolve('data');
  const requestedRevisionLimit = Number(env.CALLIOPE_REVISION_LIMIT ?? 10);

  // ABS is entirely optional. Configuring a URL without a token is far more
  // likely to be a half-finished setup than an intentional anonymous ABS, so it
  // is treated as "not configured" rather than failing every request later.
  const absUrl = env.ABS_URL?.trim();
  const absToken = env.ABS_TOKEN?.trim();

  return {
    port: Number(env.PORT ?? 3008),
    host: env.HOST ?? '0.0.0.0',
    libraryRoot: env.CALLIOPE_LIBRARY_ROOT ?? '/books',
    dataDir,
    revisionLimit: Number.isFinite(requestedRevisionLimit)
      ? Math.max(1, Math.floor(requestedRevisionLimit))
      : 10,
    backupOnSave: bool(env.CALLIOPE_BACKUP_ON_SAVE, false),
    scanOnStart: bool(env.CALLIOPE_SCAN_ON_START, true),
    abs:
      absUrl && absToken
        ? {
            url: absUrl,
            token: absToken,
            booksRoot: env.ABS_BOOKS_ROOT ?? '/books',
            libraryId: env.ABS_LIBRARY_ID?.trim() || undefined,
            rescanOnSave: bool(env.ABS_RESCAN_ON_SAVE, true),
          }
        : null,
  };
}

export const indexPath = (config: Config): string => path.join(config.dataDir, 'calliope.sqlite');
export const coverDir = (config: Config): string => path.join(config.dataDir, 'covers');
export const revisionDir = (config: Config): string => path.join(config.dataDir, 'revisions');
