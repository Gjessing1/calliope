import type { ImgHTMLAttributes, JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import { API_ORIGIN, deviceToken, fetchImage } from '../api.js';
import { createImageCache } from '../image-cache.js';
import type { ImageHold } from '../image-cache.js';

const images = createImageCache(fetchImage);

/**
 * Only a client with a device token needs this. The browser reaches the API
 * through the SSO gateway with its session cookie, so a plain `<img>` works
 * there and keeps the browser's own caching and lazy loading.
 */
function mustFetch(src: string): boolean {
  return deviceToken() !== '' && src.startsWith(`${API_ORIGIN}/api/`);
}

type ApiImageProps = Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> & { src: string };

/**
 * An `<img>` for an API URL. On Android an `<img src>` cannot send the bearer
 * header the gateway needs, so the image is fetched with it and shown from a
 * blob URL instead. `loading="lazy"` is honoured either way: a grid of a whole
 * library must not download every cover the moment it renders.
 */
export function ApiImage({ src, loading, alt, ...rest }: ApiImageProps): JSX.Element {
  const fetched = mustFetch(src);
  const element = useRef<HTMLImageElement>(null);
  const [shown, setShown] = useState<{ src: string; objectUrl: string } | null>(null);

  useEffect(() => {
    if (!fetched) return;
    let hold: ImageHold | null = null;
    let active = true;
    const start = (): void => {
      hold = images.acquire(src);
      hold.objectUrl.then(
        (objectUrl) => {
          if (active) setShown({ src, objectUrl });
        },
        // A failed image stays empty, as a broken <img> would.
        () => undefined,
      );
    };

    let observer: IntersectionObserver | null = null;
    const target = element.current;
    if (loading === 'lazy' && target && typeof IntersectionObserver !== 'undefined') {
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer?.disconnect();
          start();
        },
        { rootMargin: '400px' },
      );
      observer.observe(target);
    } else {
      start();
    }

    return () => {
      active = false;
      observer?.disconnect();
      hold?.release();
    };
  }, [fetched, src, loading]);

  if (!fetched) return <img src={src} loading={loading} alt={alt} {...rest} />;
  return (
    <img ref={element} src={shown?.src === src ? shown.objectUrl : undefined} alt={alt} {...rest} />
  );
}
