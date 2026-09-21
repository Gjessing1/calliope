/**
 * Types for the OPF document as xml2js hands it back.
 *
 * xml2js's default options are what the engine has always used, and they shape
 * everything below: every element becomes an array, attributes land under `$`,
 * and an element's text lands under `_` *only when it also has attributes* —
 * a bare `<dc:title>X</dc:title>` is the string `'X'`, the same element with an
 * `id` is `{ _: 'X', $: { id: '…' } }`. Every reader in this package therefore
 * has to accept both, which is what `XmlNode` and `textOf` are for.
 *
 * These types are deliberately open (`[key: string]: unknown`): an OPF may carry
 * any DCMES element and any vendor `<meta>`, and the writer's contract is to
 * leave what it does not understand exactly where it found it.
 */

/** An element that may be a plain string or a text+attributes object. */
export type XmlNode = string | XmlElement;

export interface XmlElement {
  _?: string;
  $?: Record<string, string>;
}

/** A `<meta>` element. Both EPUB 2 (`name`/`content`) and 3 (`property`/`refines`). */
export interface MetaElement extends XmlElement {
  $?: Record<string, string>;
}

export interface OpfMetadata {
  'dc:title'?: XmlNode[];
  'dc:creator'?: XmlNode[];
  'dc:contributor'?: XmlNode[];
  'dc:identifier'?: XmlNode[];
  'dc:subject'?: XmlNode[];
  'dc:language'?: XmlNode[];
  'dc:publisher'?: XmlNode[];
  'dc:date'?: XmlNode[];
  'dc:description'?: XmlNode[];
  'dc:rights'?: XmlNode[];
  meta?: MetaElement[];
  [key: string]: unknown;
}

export interface ManifestItem extends XmlElement {
  $?: Record<string, string>;
}

export interface OpfDocument {
  package: {
    $?: Record<string, string>;
    metadata: OpfMetadata[];
    manifest?: Array<{ item?: ManifestItem[] }>;
    spine?: unknown;
    [key: string]: unknown;
  };
}

/**
 * The text of an element, whichever of the two shapes xml2js produced.
 * Returns `''` for anything that carries no text, so callers never leak
 * `[object Object]` into a metadata field — which is exactly what a
 * self-closing or attribute-only element used to do.
 */
export function textOf(node: XmlNode | undefined | null): string {
  if (typeof node === 'string') return node;
  if (node && typeof node._ === 'string') return node._;
  return '';
}

/** The attributes of an element, or an empty object for a bare string node. */
export function attrsOf(node: XmlNode | undefined | null): Record<string, string> {
  if (!node || typeof node === 'string') return {};
  return node.$ ?? {};
}

/**
 * Every `id` attribute anywhere in the package document.
 *
 * A `<meta refines>` may point at any element in the package, not just at
 * metadata — media overlays refine manifest items — so the writer has to know
 * the whole document's ids to tell an orphaned refinement from a live one.
 */
export function collectIds(node: unknown, ids: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) {
    for (const child of node) collectIds(child, ids);
  } else if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (key === '$') {
        const id = (value as Record<string, unknown>).id;
        if (typeof id === 'string' && id) ids.add(id);
      } else if (key !== '_') {
        collectIds(value, ids);
      }
    }
  }
  return ids;
}

/** The id a `refines` attribute points at (`#creator-0` → `creator-0`), or null. */
export function refinedId(element: XmlNode | undefined | null): string | null {
  const refines = attrsOf(element).refines;
  return refines?.startsWith('#') ? refines.slice(1) : null;
}

/**
 * The EPUB 3 `belongs-to-collection` elements that are a series.
 *
 * A collection refined with `collection-type` = `series` is one; so is an
 * untyped collection, because that is how readers treat it. A `set` (a boxed
 * edition, a publisher's line) is not, and editing the series must leave it be.
 */
export function seriesCollections(meta: OpfMetadata): MetaElement[] {
  const all = meta.meta ?? [];
  return all.filter((m) => {
    if (m.$?.property !== 'belongs-to-collection') return false;
    const id = m.$.id;
    const type = id
      ? all.find((r) => r.$?.property === 'collection-type' && refinedId(r) === id)
      : undefined;
    return !type || textOf(type).trim() === 'series';
  });
}

/** The digits of an ISBN as written, without a `urn:isbn:` prefix, hyphens or spaces. */
export function bareIsbn(value: string): string {
  return value
    .trim()
    .replace(/^urn:isbn:/i, '')
    .replace(/[-\s]/g, '');
}

/** An ISBN-10 or ISBN-13 by shape. The check digit is not verified. */
export function isIsbn(value: string): boolean {
  const bare = bareIsbn(value);
  return /^\d{9}[\dX]$/i.test(bare) || /^(978|979)\d{10}$/.test(bare);
}

/**
 * Whether a `dc:identifier` is an ISBN: declared as one (EPUB 2 `opf:scheme`,
 * or an EPUB 3 `identifier-type` refinement with ONIX code 15 or 02) or simply
 * shaped like one. The reader and the writer must agree on this, or the writer
 * updates a different identifier than the one the editor showed.
 */
export function isIsbnIdentifier(node: XmlNode, meta: OpfMetadata): boolean {
  const { id, 'opf:scheme': scheme } = attrsOf(node);
  if (scheme?.toUpperCase() === 'ISBN') return true;
  if (id) {
    const type = meta.meta?.find((m) => m.$?.property === 'identifier-type' && refinedId(m) === id);
    const code = textOf(type).trim().toUpperCase();
    if (code === '15' || code === '02' || code === 'ISBN') return true;
  }
  return isIsbn(textOf(node));
}
