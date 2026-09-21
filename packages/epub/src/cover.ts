import path from 'node:path';
import type JSZip from 'jszip';
import sharp from 'sharp';
import type { ManifestItem, OpfDocument } from './opf.js';

/**
 * Find the cover item in a manifest.
 *
 * Three strategies in order, because EPUBs in the wild use all three and many
 * use none consistently:
 *   1. EPUB 2's `<meta name="cover" content="itemId"/>`;
 *   2. EPUB 3's `properties="cover-image"` on the manifest item;
 *   3. an item whose id merely contains "cover" and whose media type is an image.
 * Every step guards on the node existing — a manifest item with no attributes at
 * all is not hypothetical in this corpus.
 */
export function findCoverItem(opf: OpfDocument): ManifestItem | null {
  const manifest = opf.package?.manifest?.[0]?.item;
  if (!manifest) return null;

  const meta = opf.package.metadata?.[0];

  let coverId: string | null = null;
  const coverMeta = meta?.meta?.find((m) => m?.$?.name === 'cover');
  if (coverMeta?.$?.content) coverId = coverMeta.$.content;

  if (!coverId) {
    const byProperty = manifest.find((item) => item?.$?.properties?.includes('cover-image'));
    if (byProperty?.$?.id) coverId = byProperty.$.id;
  }

  if (!coverId) {
    const byName = manifest.find((item) => {
      if (!item?.$) return false;
      return (
        item.$.id?.toLowerCase().includes('cover') && item.$['media-type']?.startsWith('image/')
      );
    });
    if (byName?.$?.id) coverId = byName.$.id;
  }

  if (!coverId) return null;
  return manifest.find((item) => item?.$?.id === coverId) ?? null;
}

/** Resolve a manifest href to its path inside the archive (OPF-relative). */
export function resolveHref(opfPath: string, href: string): string {
  return path.join(path.dirname(opfPath), href).replace(/\\/g, '/');
}

/**
 * The cover image bytes, or null when the book has none or the manifest points
 * at a file that is not in the archive. Never throws: a library scan must not
 * stop on one bad book.
 */
export async function getCoverBuffer(
  zip: JSZip,
  opf: OpfDocument,
  opfPath: string,
): Promise<Buffer | null> {
  try {
    const coverItem = findCoverItem(opf);
    if (!coverItem?.$?.href) return null;

    const coverFile = zip.file(resolveHref(opfPath, coverItem.$.href));
    if (!coverFile) return null;

    return await coverFile.async('nodebuffer');
  } catch {
    return null;
  }
}

/** The cover as base64, for handing straight to an `<img src="data:…">`. */
export async function getCoverImage(
  zip: JSZip,
  opf: OpfDocument,
  opfPath: string,
): Promise<string | null> {
  const buffer = await getCoverBuffer(zip, opf, opfPath);
  return buffer ? buffer.toString('base64') : null;
}

export interface OptimizeCoverOptions {
  maxWidth?: number;
  maxHeight?: number;
  quality?: number;
  convertToJpeg?: boolean;
}

/**
 * Resize an oversized cover and flatten transparency onto white.
 *
 * Returns the input unchanged if anything goes wrong: an unoptimized cover is a
 * cosmetic problem, a failed save is not.
 */
export async function optimizeCover(
  buffer: Buffer,
  options: OptimizeCoverOptions = {},
): Promise<Buffer> {
  try {
    const { maxWidth = 1600, maxHeight = 2400, quality = 90, convertToJpeg = true } = options;

    let image = sharp(buffer);
    const metadata = await image.metadata();

    if ((metadata.width ?? 0) > maxWidth || (metadata.height ?? 0) > maxHeight) {
      image = image.resize(maxWidth, maxHeight, { fit: 'inside', withoutEnlargement: true });
    }

    // A PNG with alpha becomes black where it was transparent once a reader
    // composites it onto a dark background, so flatten before encoding JPEG.
    if (convertToJpeg || (metadata.format === 'png' && metadata.hasAlpha)) {
      image = image.flatten({ background: { r: 255, g: 255, b: 255 } }).jpeg({ quality });
    }

    return await image.toBuffer();
  } catch {
    return buffer;
  }
}

/** A downscaled JPEG for the library grid. Null when the source is not an image. */
export async function makeThumbnail(buffer: Buffer, width = 400): Promise<Buffer | null> {
  try {
    return await sharp(buffer)
      .resize(width, null, { fit: 'inside', withoutEnlargement: true })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .jpeg({ quality: 80 })
      .toBuffer();
  } catch {
    return null;
  }
}
