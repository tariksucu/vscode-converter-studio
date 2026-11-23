/**
 * Names of saved results. A result goes next to its original, under the name Converter Studio
 * gave it (`photo.heic` → `photo.jpg`, `report.pdf` → `report-compressed.pdf`, a multi-page PDF to
 * images → `scan.zip`), and a name that is taken gets a number: `photo (1).jpg`.
 */

/** Extensions of two parts, kept whole when a number is added. */
const DOUBLE_EXTENSIONS = ['.tar.gz', '.tar.bz2', '.tar.xz'];

/** The extension of a name (`.jpg`, `.tar.gz`) or `''`. */
export function extensionOf(name: string): string {
  const lower = name.toLowerCase();
  for (const double of DOUBLE_EXTENSIONS)
    if (lower.endsWith(double) && lower.length > double.length) return name.slice(-double.length);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
}

/** A name without its extension. */
export const stemOf = (name: string): string =>
  name.slice(0, name.length - extensionOf(name).length);

/** A safe file name: no folders, no control characters, not `.` or `..`. */
export function safeName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? '';
  // eslint-disable-next-line no-control-regex
  const clean = base.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').trim();
  return clean === '' || clean === '.' || clean === '..' ? '' : clean;
}

/**
 * The name of a result: the server's `outputName` when it is a usable file name, else the
 * original's stem with the target's extension.
 */
export function resultName(original: string, outputName: string | null, to: string): string {
  const fromServer = outputName ? safeName(outputName) : '';
  if (fromServer && extensionOf(fromServer)) return fromServer;
  const extension = to === 'tgz' ? 'tar.gz' : to;
  return `${stemOf(original) || 'converted'}.${extension}`;
}

/** The n-th other name for a taken one: `photo (1).jpg`, `photo (2).jpg`… */
export function numberedName(name: string, n: number): string {
  const extension = extensionOf(name);
  return `${name.slice(0, name.length - extension.length)} (${n})${extension}`;
}

/** The first of `name`, `name (1)`, `name (2)`… that `taken` says is free (at most 999 tries). */
export async function freeName(
  name: string,
  taken: (candidate: string) => Promise<boolean>,
): Promise<string> {
  if (!(await taken(name))) return name;
  for (let n = 1; n < 1000; n++) {
    const candidate = numberedName(name, n);
    if (!(await taken(candidate))) return candidate;
  }
  throw new Error(`No free name for ${name}.`);
}
