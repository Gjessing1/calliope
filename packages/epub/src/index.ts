export { normalizeLanguageCode } from './language.js';
export type { LanguageNormalization } from './language.js';
export { sanitizeMetadataString } from './sanitize.js';
export { attrsOf, textOf } from './opf.js';
export type { ManifestItem, MetaElement, OpfDocument, OpfMetadata, XmlNode } from './opf.js';
export { InvalidEpubError, extractMetadata, readEpub } from './read.js';
export type { OpenedEpub } from './read.js';
export { normalizeDateFormat, normalizeMetadata, stripHTML } from './normalize.js';
export type { NormalizedMetadata } from './normalize.js';
export {
  findCoverItem,
  getCoverBuffer,
  getCoverImage,
  makeThumbnail,
  optimizeCover,
  resolveHref,
} from './cover.js';
export type { OptimizeCoverOptions } from './cover.js';
export { writeEpub } from './write.js';
export type { WriteResult } from './write.js';
export { bookId, openEpubFile, readEpubFile, saveEpubFile } from './file.js';
export type { ReadFileResult, SaveOptions, SaveResult } from './file.js';
