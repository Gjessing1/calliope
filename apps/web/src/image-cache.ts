/**
 * Object URLs for images that have to be fetched rather than linked, shared
 * between every element showing the same URL.
 *
 * Each URL is fetched once while anything holds it, and revoked a grace period
 * after the last holder lets go. The grace period is what keeps a regrouped
 * library grid from refetching every cover: React unmounts the old cards
 * before it mounts the new ones, so without it each switch of view would drop
 * every blob and download the whole grid again.
 */
export interface ImageCache {
  acquire(url: string): ImageHold;
}

export interface ImageHold {
  objectUrl: Promise<string>;
  /** Idempotent. Bound to this hold, so a retry after a failure never releases another's. */
  release(): void;
}

interface Entry {
  holders: number;
  objectUrl: Promise<string>;
  revokeTimer: ReturnType<typeof setTimeout> | null;
}

export function createImageCache(
  load: (url: string) => Promise<Blob>,
  graceMs = 30_000,
): ImageCache {
  const entries = new Map<string, Entry>();

  const forget = (url: string, entry: Entry): void => {
    if (entries.get(url) === entry) entries.delete(url);
  };

  return {
    acquire(url) {
      let entry = entries.get(url);
      if (!entry) {
        const created: Entry = {
          holders: 0,
          objectUrl: load(url).then((blob) => URL.createObjectURL(blob)),
          revokeTimer: null,
        };
        // A failed fetch must not be served from the cache forever: the next
        // element to ask gets a fresh attempt.
        created.objectUrl.catch(() => forget(url, created));
        entries.set(url, created);
        entry = created;
      }
      if (entry.revokeTimer) {
        clearTimeout(entry.revokeTimer);
        entry.revokeTimer = null;
      }
      entry.holders += 1;

      const held = entry;
      let released = false;
      return {
        objectUrl: held.objectUrl,
        release() {
          if (released) return;
          released = true;
          held.holders -= 1;
          if (held.holders > 0) return;
          held.revokeTimer = setTimeout(() => {
            forget(url, held);
            void held.objectUrl.then(
              (objectUrl) => URL.revokeObjectURL(objectUrl),
              () => undefined,
            );
          }, graceMs);
        },
      };
    },
  };
}
