/**
 * Handing files to Converter Studio for desktop: a `converter-studio://convert` link opened by
 * the operating system. The app shows a card "Files from Visual Studio Code" (Continue or
 * Ignore), then the files in its Convert tab with the target chosen; the user presses Convert
 * there, so nothing runs by itself. The app does not answer; an older version only comes to the
 * front.
 */

export const DESKTOP_SCHEME = 'converter-studio';
/** The first version of Converter Studio for desktop that takes these links. */
export const DESKTOP_MIN_VERSION = '0.1.11';
export const DESKTOP_APP = `Converter Studio for desktop ${DESKTOP_MIN_VERSION} or later`;
export const DESKTOP_PAGE = 'https://converter.studio/download';
/** This extension's name in the link (`from`), the same as in its API requests. */
export const CLIENT_NAME = 'vscode';
/** What the desktop app takes in one request (links of the same request are merged). */
export const DESKTOP_MAX_FILES = 200;
export const DESKTOP_MAX_BYTES = 50 * 1024 ** 3;
/** The longest link handed over (Windows cuts long ones). */
export const DESKTOP_MAX_LINK = 2000;

/**
 * A hand-off link: `converter-studio://convert?to=<format id>&from=vscode&file=<path>&…`, every
 * value percent-encoded with encodeURIComponent (a space is `%20`, and `+ # & %` are encoded),
 * so any path arrives as it is.
 */
export const desktopLink = (to: string, paths: readonly string[]): string =>
  `${DESKTOP_SCHEME}://convert?${[
    `to=${encodeURIComponent(to)}`,
    `from=${encodeURIComponent(CLIENT_NAME)}`,
    ...paths.map((path) => `file=${encodeURIComponent(path)}`),
  ].join('&')}`;

/**
 * The links for a list of files: as few as possible, each at most DESKTOP_MAX_LINK characters
 * (the app merges links with the same `from` and `to` that arrive within 15 seconds).
 */
export function desktopLinks(to: string, paths: readonly string[]): string[] {
  const links: string[] = [];
  let batch: string[] = [];
  for (const path of paths) {
    if (batch.length > 0 && desktopLink(to, [...batch, path]).length > DESKTOP_MAX_LINK) {
      links.push(desktopLink(to, batch));
      batch = [];
    }
    batch.push(path);
  }
  if (batch.length > 0) links.push(desktopLink(to, batch));
  return links;
}

/** Why a selection cannot be handed over at once, or null. */
export function desktopLimitProblem(files: number, bytes: number): string | null {
  if (files > DESKTOP_MAX_FILES)
    return `The desktop app takes up to ${DESKTOP_MAX_FILES} files at a time; ${files} are selected.`;
  if (bytes > DESKTOP_MAX_BYTES) return 'The desktop app takes up to 50 GB of files at a time.';
  return null;
}

/** What a link carries, read back (for the tests). */
export function readDesktopLink(
  link: string,
): { to: string; from: string; files: string[] } | null {
  const prefix = `${DESKTOP_SCHEME}://convert?`;
  if (!link.startsWith(prefix)) return null;
  const out = { to: '', from: '', files: [] as string[] };
  for (const pair of link.slice(prefix.length).split('&')) {
    const cut = pair.indexOf('=');
    if (cut < 0) continue;
    const value = decodeURIComponent(pair.slice(cut + 1));
    const name = pair.slice(0, cut);
    if (name === 'to') out.to = value;
    else if (name === 'from') out.from = value;
    else if (name === 'file') out.files.push(value);
  }
  return out;
}
