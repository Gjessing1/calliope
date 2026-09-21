import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createImageCache } from './image-cache.js';

describe('createImageCache', () => {
  let created = 0;
  const revoked: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    created = 0;
    revoked.length = 0;
    vi.spyOn(URL, 'createObjectURL').mockImplementation(() => `blob:${++created}`);
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url) => void revoked.push(url));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const blob = (): Promise<Blob> => Promise.resolve(new Blob(['jpeg']));

  it('fetches a URL once for every element showing it', async () => {
    const load = vi.fn(blob);
    const cache = createImageCache(load);
    const a = cache.acquire('/api/books/1/cover');
    const b = cache.acquire('/api/books/1/cover');
    expect(await a.objectUrl).toBe('blob:1');
    expect(await b.objectUrl).toBe('blob:1');
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('revokes only after the last holder has let go for the grace period', async () => {
    const cache = createImageCache(blob, 1000);
    const a = cache.acquire('/api/books/1/cover');
    const b = cache.acquire('/api/books/1/cover');
    await a.objectUrl;
    a.release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(revoked).toEqual([]);
    b.release();
    await vi.advanceTimersByTimeAsync(999);
    expect(revoked).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(revoked).toEqual(['blob:1']);
  });

  it('keeps the blob when the element remounts within the grace period', async () => {
    const load = vi.fn(blob);
    const cache = createImageCache(load, 1000);
    const first = cache.acquire('/api/books/1/cover');
    await first.objectUrl;
    first.release();
    const second = cache.acquire('/api/books/1/cover');
    await vi.advanceTimersByTimeAsync(5000);
    expect(await second.objectUrl).toBe('blob:1');
    expect(load).toHaveBeenCalledTimes(1);
    expect(revoked).toEqual([]);
  });

  it('retries a URL whose fetch failed', async () => {
    const load = vi
      .fn<(url: string) => Promise<Blob>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(blob);
    const cache = createImageCache(load);
    await expect(cache.acquire('/api/books/1/cover').objectUrl).rejects.toThrow('offline');
    expect(await cache.acquire('/api/books/1/cover').objectUrl).toBe('blob:1');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('never lets a hold on a failed fetch release the retry', async () => {
    const load = vi
      .fn<(url: string) => Promise<Blob>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockImplementation(blob);
    const cache = createImageCache(load, 1000);
    const failed = cache.acquire('/api/books/1/cover');
    await failed.objectUrl.catch(() => undefined);
    const retry = cache.acquire('/api/books/1/cover');
    await retry.objectUrl;
    failed.release();
    failed.release();
    await vi.advanceTimersByTimeAsync(5000);
    expect(revoked).toEqual([]);
  });
});
