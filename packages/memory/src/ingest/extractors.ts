// ingest/extractors.ts — declared extractors for Job 1 (Ingest), PRD §8.2/FR-WIKI-03.
//
// "Declare text encodings; PDF/binary extraction needs qualified extractors.
//  Unsupported formats stay intact with errors." For M0 we only qualify the
// plain-text formats already flowing through the pipeline (`.md`, `.txt`,
// `.json`, `.csv`) — all decoded via strict UTF-8 (`TextDecoder({ fatal: true })`)
// so a mis-encoded drop errors instead of silently mangling into replacement
// characters. PDF/binary/image/docx extraction needs a real qualified
// extractor (OCR, PDF text layer, etc.) that does not exist yet in M0; those
// extensions are deliberately absent from `EXTRACTORS` so callers treat them
// as unsupported and leave the original untouched (A04).
//
// `vault-watcher.ts` consults `isSupportedExtension` to decide whether a
// dropped file is even enqueued for extraction; `jobs/ingest.ts` consults
// `getExtractor` again at read time (defense in depth — `runIngest` must be
// safe to call directly, e.g. from a resumed run, without going through the
// watcher).

export interface ExtractedText {
  /** Decoded text, BOM stripped. */
  text: string;
  /** The encoding actually used to decode (always 'utf-8' for M0's qualified set). */
  encoding: 'utf-8';
}

export interface Extractor {
  /** Stable extractor name, recorded on the derived note's frontmatter. */
  name: string;
  /** Extractor version, recorded on the derived note's frontmatter. Bump on any
   *  behavior change so existing provenance remains a truthful record of how it
   *  was produced. */
  version: string;
  /** Decode raw bytes into text. Throws on invalid/undeclared encoding. */
  extract(buf: Buffer): ExtractedText;
}

/** Thrown when a byte sequence is not valid UTF-8 for a declared-UTF-8 extractor. */
export class InvalidEncodingError extends Error {
  constructor(detail: string) {
    super(`invalid UTF-8: ${detail}`);
    this.name = 'InvalidEncodingError';
  }
}

const UTF8_BOM = 0xfeff;

/** Strict UTF-8 text extractor: fatal decode (no lossy replacement chars), BOM stripped. */
function decodeStrictUtf8(buf: Buffer): ExtractedText {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text: string;
  try {
    text = decoder.decode(buf);
  } catch (err) {
    throw new InvalidEncodingError(err instanceof Error ? err.message : String(err));
  }
  if (text.length > 0 && text.charCodeAt(0) === UTF8_BOM) {
    text = text.slice(1);
  }
  return { text, encoding: 'utf-8' };
}

const utf8TextExtractor: Extractor = {
  name: 'utf8-text',
  version: '1.0.0',
  extract: decodeStrictUtf8,
};

/**
 * Declared extractors, keyed by lowercase file extension (with leading dot).
 * M0's qualified set is plain UTF-8 text only — PDF/binary/image/docx are
 * intentionally absent (A04); adding a new extension here is the single
 * "declare an extractor" act FR-WIKI-03 requires before that format may be
 * ingested.
 */
export const EXTRACTORS: Readonly<Record<string, Extractor>> = Object.freeze({
  '.md': utf8TextExtractor,
  '.markdown': utf8TextExtractor,
  '.txt': utf8TextExtractor,
  '.json': utf8TextExtractor,
  '.csv': utf8TextExtractor,
});

/** Normalize a filename/path into the lowercase extension key `EXTRACTORS` uses. */
export function extensionOf(fileNameOrPath: string): string {
  const m = /\.[^./\\]+$/.exec(fileNameOrPath);
  return m ? m[0]!.toLowerCase() : '';
}

/** True if `ext` (or a filename/path) has a declared extractor. */
export function isSupportedExtension(extOrPath: string): boolean {
  const ext = extOrPath.includes('.') ? extensionOf(extOrPath) : extOrPath.toLowerCase();
  return ext in EXTRACTORS;
}

/** Look up the declared extractor for a filename/path, or `undefined` if unsupported. */
export function getExtractor(fileNameOrPath: string): Extractor | undefined {
  return EXTRACTORS[extensionOf(fileNameOrPath)];
}
