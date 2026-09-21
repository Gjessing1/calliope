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
