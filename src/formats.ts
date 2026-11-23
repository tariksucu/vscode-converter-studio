import type { FormatInfo } from './client';

/**
 * Which targets a selection of files can have, from the API's own catalogue (`GET /v1/formats`),
 * never from a list of our own: what Converter Studio offers today is what the picker shows.
 */

/** A choice of the picker: a target format and the conversion options that go with it. */
export interface Target {
  to: string;
  /** What the picker shows (`WebP`, `Text (recognize scanned pages)`). */
  label: string;
  /** A short note beside it. */
  description?: string;
  options?: Record<string, unknown>;
  /** The files it applies to (indexes into the selection). */
  files: number[];
  /** One of the suggestions at the top. */
  suggested: boolean;
}

/**
 * Suggestions for developers, shown first (in this order) when every selected file is one of
 * `sources` and the API offers the target for each of them.
 */
export const SUGGESTIONS: ReadonlyArray<{
  to: string;
  label: string;
  description: string;
  sources: readonly string[];
  options?: Record<string, unknown>;
}> = [
  {
    to: 'jpg',
    label: 'JPG',
    description: 'photos that open everywhere',
    sources: ['heic', 'cr2', 'nef', 'arw', 'dng'],
  },
  {
    to: 'png',
    label: 'PNG',
    description: 'lossless images',
    sources: ['heic', 'svg'],
  },
  {
    to: 'webp',
    label: 'WebP',
    description: 'smaller images for the web',
    sources: ['jpg', 'png', 'gif', 'bmp', 'tiff', 'heic', 'avif'],
  },
  {
    to: 'avif',
    label: 'AVIF',
    description: 'the smallest images for the web',
    sources: ['jpg', 'png', 'gif', 'bmp', 'tiff', 'heic', 'webp'],
  },
  {
    to: 'pdf',
    label: 'PDF',
    description: 'documents anyone can open',
    sources: [
      'docx',
      'doc',
      'odt',
      'rtf',
      'pptx',
      'ppt',
      'odp',
      'xlsx',
      'xls',
      'ods',
      'md',
      'html',
    ],
  },
  {
    to: 'txt',
    label: 'Text, recognizing scanned pages',
    description: 'OCR',
    sources: ['pdf'],
    options: { ocr: true },
  },
];

/** The format of a file name, by its extension (`archive.tar.gz` → `tgz`); null if unknown. */
export function formatOfName(name: string, catalogue: readonly FormatInfo[]): string | null {
  const lower = name.toLowerCase();
  let best: { id: string; length: number } | null = null;
  for (const format of catalogue) {
    for (const extension of format.extensions) {
      const suffix = `.${extension.toLowerCase()}`;
      // A name that is only the extension (".png") is a hidden file without one.
      if (
        lower.endsWith(suffix) &&
        lower.length > suffix.length &&
        (!best || suffix.length > best.length)
      )
        best = { id: format.id, length: suffix.length };
    }
  }
  return best?.id ?? null;
}

/**
 * The picker's choices for files of these formats (null: not a format Converter Studio reads):
 * the suggestions that fit every file, then every target that fits at least one, those that fit
 * all of them first, each group in the API's order (the most used first).
 */
export function targetsFor(
  formats: ReadonlyArray<string | null>,
  catalogue: readonly FormatInfo[],
): Target[] {
  const byId = new Map(catalogue.map((format) => [format.id, format]));
  const known = formats
    .map((format, index) => ({ index, info: format ? byId.get(format) : undefined }))
    .filter((entry): entry is { index: number; info: FormatInfo } => entry.info !== undefined);
  if (known.length === 0) return [];

  const suggested: Target[] = [];
  if (known.length === formats.length) {
    for (const suggestion of SUGGESTIONS) {
      const fits = known.every(
        ({ info }) => suggestion.sources.includes(info.id) && info.to.includes(suggestion.to),
      );
      if (fits)
        suggested.push({
          to: suggestion.to,
          label: suggestion.label,
          description: suggestion.description,
          ...(suggestion.options ? { options: suggestion.options } : {}),
          files: known.map(({ index }) => index),
          suggested: true,
        });
    }
  }

  // Every target in first-seen order (the API sorts each format's targets by use).
  const order: string[] = [];
  const files = new Map<string, number[]>();
  for (const { index, info } of known) {
    for (const to of info.to) {
      if (!files.has(to)) {
        files.set(to, []);
        order.push(to);
      }
      files.get(to)!.push(index);
    }
  }
  // A suggestion without options already stands for its target.
  const plainSuggested = new Set(suggested.filter((t) => !t.options).map((t) => t.to));
  const all = order
    .filter((to) => !plainSuggested.has(to))
    .map((to): Target => {
      const indexes = files.get(to)!;
      const sameFormat = indexes.every((index) => formats[index] === to);
      return {
        to,
        label: byId.get(to)?.name ?? to.toUpperCase(),
        ...(sameFormat ? { description: 'smaller file (compress)' } : {}),
        files: indexes,
        suggested: false,
      };
    });
  all.sort(
    (a, b) => Number(b.files.length === formats.length) - Number(a.files.length === formats.length),
  );
  return [...suggested, ...all];
}

/** "1 file", "3 files". */
export const filesText = (n: number): string => `${n} file${n === 1 ? '' : 's'}`;
