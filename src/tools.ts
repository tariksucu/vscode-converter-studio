import { isAbsolute, join, relative, win32, posix } from 'node:path';

/**
 * The conversion tools already installed on the computer: where they are (the setting, PATH and
 * the folders their installers use) and what each one can do (its version, FFmpeg's encoders,
 * ImageMagick's formats, Tesseract's languages). Nothing is installed or downloaded.
 */

export const TOOL_IDS = ['ffmpeg', 'soffice', 'pandoc', 'magick', 'gs', 'tesseract'] as const;
export type ToolId = (typeof TOOL_IDS)[number];

export const TOOL_NAMES: Readonly<Record<ToolId, string>> = {
  ffmpeg: 'FFmpeg',
  soffice: 'LibreOffice',
  pandoc: 'Pandoc',
  magick: 'ImageMagick',
  gs: 'Ghostscript',
  tesseract: 'Tesseract',
};

/** What each tool is for, in the words of the tools view. */
export const TOOL_USES: Readonly<Record<ToolId, string>> = {
  ffmpeg: 'video and audio: MP4, WebM, MOV, MKV, AVI, GIF, MP3, WAV, M4A, AAC, FLAC, OGG, Opus',
  soffice:
    'Office documents, spreadsheets and slides: to and from PDF, DOCX, ODT, XLSX, CSV, PPTX…',
  pandoc: 'Markdown, HTML, DOCX, ODT, EPUB, RTF and plain text',
  magick:
    'images: JPG, PNG, WebP, AVIF, GIF, TIFF, BMP, ICO, SVG; HEIC and camera RAW when built in',
  gs: 'PDF: smaller files, and the text of a PDF',
  tesseract: 'text recognition (OCR) of images, and of scanned PDFs with Ghostscript',
};

/** Where to get each tool. */
export const TOOL_PAGES: Readonly<Record<ToolId, string>> = {
  ffmpeg: 'https://ffmpeg.org/download.html',
  soffice: 'https://www.libreoffice.org/download/download/',
  pandoc: 'https://pandoc.org/installing.html',
  magick: 'https://imagemagick.org/script/download.php',
  gs: 'https://ghostscript.com/releases/gsdnld.html',
  tesseract: 'https://tesseract-ocr.github.io/tessdoc/Installation.html',
};

export interface Tool {
  id: ToolId;
  /** The executable's absolute path. */
  path: string;
  version: string | null;
  /** ImageMagick 6 (`convert`) rather than 7 (`magick`). */
  legacy?: boolean;
  /** FFmpeg's encoders (`libx264`, `aac`…). */
  encoders?: ReadonlySet<string>;
  /** ImageMagick's formats it reads and writes, upper case (`HEIC`, `WEBP`…). */
  reads?: ReadonlySet<string>;
  writes?: ReadonlySet<string>;
  /** Tesseract's installed languages (`eng`, `deu`…). */
  languages?: readonly string[];
  /** The image formats Tesseract reads (format ids: `png`, `jpg`…). */
  imageFormats?: ReadonlySet<string>;
}

export type Toolbox = Partial<Record<ToolId, Tool>>;

export interface Host {
  os: NodeJS.Platform;
  env: Readonly<Record<string, string | undefined>>;
  home: string;
}

/** The executable names of a tool on an operating system, the preferred first. */
export function executableNames(id: ToolId, os: NodeJS.Platform): string[] {
  const win = os === 'win32';
  switch (id) {
    case 'ffmpeg':
      return win ? ['ffmpeg.exe'] : ['ffmpeg'];
    case 'soffice':
      return win ? ['soffice.exe'] : ['soffice', 'libreoffice'];
    case 'pandoc':
      return win ? ['pandoc.exe'] : ['pandoc'];
    case 'magick':
      // Windows has its own convert.exe (a file system tool): only magick.exe there.
      return win ? ['magick.exe'] : ['magick', 'convert'];
    case 'gs':
      return win ? ['gswin64c.exe', 'gswin32c.exe'] : ['gs'];
    case 'tesseract':
      return win ? ['tesseract.exe'] : ['tesseract'];
  }
}

const envValue = (host: Host, name: string): string | undefined => {
  if (host.os !== 'win32') return host.env[name];
  const key = Object.keys(host.env).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? host.env[key] : undefined;
};

/**
 * The folders the tools' installers and package managers use, searched after PATH (an editor
 * started from the Dock or the Start menu may not have the shell's PATH). A segment ending in `*`
 * stands for the versioned folders it starts (`ImageMagick-7.1.1-Q16-HDRI`), the newest first.
 */
export function usualFolders(id: ToolId, host: Host): string[] {
  if (host.os === 'win32') {
    const programs = [
      envValue(host, 'ProgramFiles') ?? 'C:\\Program Files',
      envValue(host, 'ProgramFiles(x86)') ?? 'C:\\Program Files (x86)',
    ];
    const local = envValue(host, 'LOCALAPPDATA') ?? win32.join(host.home, 'AppData', 'Local');
    const shared = [
      win32.join(local, 'Microsoft', 'WinGet', 'Links'),
      win32.join(envValue(host, 'ProgramData') ?? 'C:\\ProgramData', 'chocolatey', 'bin'),
      win32.join(host.home, 'scoop', 'shims'),
    ];
    const own: Record<ToolId, string[]> = {
      ffmpeg: ['C:\\ffmpeg\\bin', ...programs.map((p) => win32.join(p, 'ffmpeg', 'bin'))],
      soffice: programs.map((p) => win32.join(p, 'LibreOffice', 'program')),
      pandoc: [win32.join(local, 'Pandoc'), ...programs.map((p) => win32.join(p, 'Pandoc'))],
      magick: programs.map((p) => win32.join(p, 'ImageMagick-*')),
      gs: programs.map((p) => win32.join(p, 'gs', 'gs*', 'bin')),
      tesseract: [
        ...programs.map((p) => win32.join(p, 'Tesseract-OCR')),
        win32.join(local, 'Programs', 'Tesseract-OCR'),
      ],
    };
    return [...own[id], ...shared];
  }
  const unix = ['/usr/local/bin', '/usr/bin', posix.join(host.home, '.local', 'bin')];
  if (host.os === 'darwin') {
    const brew = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin'];
    if (id === 'soffice')
      return [
        '/Applications/LibreOffice.app/Contents/MacOS',
        posix.join(host.home, 'Applications', 'LibreOffice.app', 'Contents', 'MacOS'),
        ...brew,
      ];
    return [...brew, ...unix];
  }
  const linux = [...unix, '/home/linuxbrew/.linuxbrew/bin'];
  if (id === 'soffice')
    return [...linux, '/usr/lib/libreoffice/program', '/opt/libreoffice*/program'];
  return linux;
}

/**
 * The PATH folders that may hold a tool: absolute ones only, and none inside an open workspace
 * folder, so a project can never put its own `ffmpeg` in front of the real one.
 */
export function pathFolders(host: Host, workspaceFolders: readonly string[]): string[] {
  const path = host.os === 'win32' ? win32 : posix;
  const raw = envValue(host, 'PATH') ?? '';
  const folders: string[] = [];
  for (const entry of raw.split(host.os === 'win32' ? ';' : ':')) {
    const folder = entry.trim().replace(/^"(.*)"$/, '$1');
    if (!folder || !path.isAbsolute(folder)) continue;
    if (workspaceFolders.some((root) => isInside(folder, root, host.os))) continue;
    if (!folders.includes(folder)) folders.push(folder);
  }
  return folders;
}

/** Whether `child` is `parent` or inside it. */
export function isInside(child: string, parent: string, os: NodeJS.Platform): boolean {
  const path = os === 'win32' ? win32 : posix;
  const fold = (p: string) => (os === 'win32' ? p.toLowerCase() : p);
  const rel = path.relative(fold(path.resolve(parent)), fold(path.resolve(child)));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** The file system checks detection needs; replaced in the unit tests. */
export interface Probe {
  isExecutable(path: string): Promise<boolean>;
  /** The names in a folder; empty when it cannot be read. */
  list(folder: string): Promise<string[]>;
}

/** Folders with a `*` segment, expanded (the newest-looking version first). */
export async function expandFolder(
  pattern: string,
  os: NodeJS.Platform,
  probe: Probe,
): Promise<string[]> {
  const path = os === 'win32' ? win32 : posix;
  const parts = pattern.split(/[\\/]/);
  const star = parts.findIndex((part) => part.endsWith('*'));
  if (star < 0) return [pattern];
  const parent = parts.slice(0, star).join(path.sep) || path.sep;
  const prefix = parts[star]!.slice(0, -1);
  const names = (await probe.list(parent))
    .filter((name) => name.startsWith(prefix))
    .sort((a, b) => b.localeCompare(a, 'en', { numeric: true }));
  const rest = parts.slice(star + 1);
  const out: string[] = [];
  for (const name of names)
    out.push(...(await expandFolder(path.join(parent, name, ...rest), os, probe)));
  return out;
}

/**
 * The candidate executables of a tool, in the order they are tried: the path from the settings,
 * then each PATH folder, then the usual folders.
 */
export async function candidates(
  id: ToolId,
  host: Host,
  options: { configured?: string; workspaceFolders: readonly string[]; probe: Probe },
): Promise<string[]> {
  const path = host.os === 'win32' ? win32 : posix;
  const out: string[] = [];
  const add = (file: string) => {
    if (!out.includes(file)) out.push(file);
  };
  const configured = options.configured?.trim();
  if (configured && path.isAbsolute(configured)) add(configured);
  const folders = [...pathFolders(host, options.workspaceFolders)];
  for (const pattern of usualFolders(id, host))
    for (const folder of await expandFolder(pattern, host.os, options.probe))
      if (!folders.includes(folder)) folders.push(folder);
  for (const name of executableNames(id, host.os))
    for (const folder of folders) add(path.join(folder, name));
  // The configured path first, then by name: `magick` anywhere before `convert` anywhere.
  return out;
}

/** The first candidate that is an executable file. */
export async function locate(list: readonly string[], probe: Probe): Promise<string | null> {
  for (const file of list) if (await probe.isExecutable(file)) return file;
  return null;
}

// --- What a tool says about itself ---------------------------------------------------------

const firstMatch = (text: string, pattern: RegExp): string | null =>
  pattern.exec(text)?.[1] ?? null;

export const parseFfmpegVersion = (text: string) => firstMatch(text, /ffmpeg version (\S+)/);

/** FFmpeg's encoder names from `ffmpeg -encoders`. */
export function parseFfmpegEncoders(text: string): Set<string> {
  const encoders = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s[VAS][A-Z.]{5}\s+(\S+)/.exec(line);
    if (match && match[1] !== '=') encoders.add(match[1]!);
  }
  return encoders;
}

/** ImageMagick's version, or null if the program is not ImageMagick. */
export const parseMagickVersion = (text: string) => firstMatch(text, /ImageMagick (\d[\w.-]*)/);

/** The formats of `magick -list format`: `   HEIC  HEIC      rw+   High Efficiency…`. */
export function parseMagickFormats(text: string): { reads: Set<string>; writes: Set<string> } {
  const reads = new Set<string>();
  const writes = new Set<string>();
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9][A-Z0-9-]*)\*?\s+\S+\s+([r-])([w-])([+-])\s/.exec(line);
    if (!match) continue;
    if (match[2] === 'r') reads.add(match[1]!);
    if (match[3] === 'w') writes.add(match[1]!);
  }
  return { reads, writes };
}

export const parsePandocVersion = (text: string) => firstMatch(text, /^pandoc(?:\.exe)? (\S+)/m);
export const parseGsVersion = (text: string) => firstMatch(text.trim(), /^(\d+(?:\.\d+)+)/);
export const parseSofficeVersion = (text: string) => firstMatch(text, /LibreOffice (\d[\w.]*)/);
export const parseTesseractVersion = (text: string) => firstMatch(text, /tesseract v?(\d[\w.-]*)/);

/** The image formats Tesseract reads, from the libraries `tesseract --version` lists. */
export function parseTesseractImageFormats(text: string): Set<string> {
  // Leptonica reads BMP itself; the others need their library.
  const formats = new Set<string>(['bmp']);
  const libraries: Record<string, string[]> = {
    libpng: ['png'],
    libjpeg: ['jpg'],
    libtiff: ['tiff'],
    libgif: ['gif'],
    libwebp: ['webp'],
  };
  for (const [library, ids] of Object.entries(libraries))
    if (new RegExp(`\\b${library}\\b`).test(text)) for (const id of ids) formats.add(id);
  return formats;
}

/** The languages of `tesseract --list-langs` (without `osd`, which is not a language). */
export function parseTesseractLanguages(text: string): string[] {
  const lines = text.split(/\r?\n/).map((line) => line.trim());
  const start = lines.findIndex((line) => /^List of available languages/i.test(line));
  return lines.slice(start + 1).filter((line) => line && line !== 'osd' && /^[\w/+-]+$/.test(line));
}

/** Runs a tool to ask about itself; its output (stdout and stderr). */
export type AskTool = (path: string, args: string[]) => Promise<string>;

/** What a found executable is and can do; null when it is not the tool (`convert` of another kind). */
export async function describe(id: ToolId, path: string, ask: AskTool): Promise<Tool | null> {
  const name = path.split(/[\\/]/).pop()!.toLowerCase();
  switch (id) {
    case 'ffmpeg': {
      const [version, encoders] = await Promise.all([
        ask(path, ['-hide_banner', '-version']),
        ask(path, ['-hide_banner', '-encoders']),
      ]);
      return {
        id,
        path,
        version: parseFfmpegVersion(version),
        encoders: parseFfmpegEncoders(encoders),
      };
    }
    case 'magick': {
      const version = parseMagickVersion(await ask(path, ['-version']));
      if (!version) return null;
      const { reads, writes } = parseMagickFormats(await ask(path, ['-list', 'format']));
      return { id, path, version, legacy: name.startsWith('convert'), reads, writes };
    }
    case 'tesseract': {
      const [version, languages] = await Promise.all([
        ask(path, ['--version']),
        ask(path, ['--list-langs']),
      ]);
      return {
        id,
        path,
        version: parseTesseractVersion(version),
        languages: parseTesseractLanguages(languages),
        imageFormats: parseTesseractImageFormats(version),
      };
    }
    case 'soffice':
      // On Windows soffice.exe is a windowed program with no output: it is not started only to
      // ask its version.
      if (name.endsWith('.exe')) return { id, path, version: null };
      return { id, path, version: parseSofficeVersion(await ask(path, ['--version'])) };
    case 'pandoc':
      return { id, path, version: parsePandocVersion(await ask(path, ['--version'])) };
    case 'gs':
      return { id, path, version: parseGsVersion(await ask(path, ['--version'])) };
  }
}

export interface Detection {
  tools: Toolbox;
  /** Why a tool is missing when it was found but could not be used. */
  problems: Partial<Record<ToolId, string>>;
}

/** Finds and describes every tool. */
export async function detectTools(
  host: Host,
  options: {
    configured: Partial<Record<ToolId, string>>;
    workspaceFolders: readonly string[];
    probe: Probe;
    ask: AskTool;
  },
): Promise<Detection> {
  const tools: Toolbox = {};
  const problems: Partial<Record<ToolId, string>> = {};
  await Promise.all(
    TOOL_IDS.map(async (id) => {
      const list = await candidates(id, host, {
        configured: options.configured[id],
        workspaceFolders: options.workspaceFolders,
        probe: options.probe,
      });
      for (const file of list) {
        if (!(await options.probe.isExecutable(file))) continue;
        try {
          const tool = await describe(id, file, options.ask);
          if (tool) {
            tools[id] = tool;
            return;
          }
        } catch (error) {
          problems[id] =
            `${file} did not answer: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
    }),
  );
  return { tools, problems };
}

/** The relative form of a path inside the home folder, for messages (`~/bin/ffmpeg`). */
export function shortPath(file: string, home: string): string {
  if (!home || !isAbsolute(file)) return file;
  const rel = relative(home, file);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? join('~', rel) : file;
}
