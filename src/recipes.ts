import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { KNOWN_FORMATS, formatName, type Kind } from './known';
import type { Tool, ToolId, Toolbox } from './tools';

/**
 * Which conversions run on this computer, and the command line of each: the extension's own
 * conversions (data formats in TypeScript, common images through the editor's own image decoder
 * and encoder) and simple, public recipes for the tools installed on the computer. Every command
 * is an array of arguments, never a shell string.
 */

/**
 * What does a conversion on the computer: a tool, two tools one after the other (Pandoc writes a
 * Word file, LibreOffice makes the PDF of it), or the extension itself.
 */
export type Engine = ToolId | 'pandoc+soffice' | 'data' | 'canvas';
/** The engines that run tools. */
export type ToolEngine = Exclude<Engine, 'data' | 'canvas'>;

/** A second kind of conversion to the same format: a smaller PDF, or text recognition. */
export type Variant = 'compress' | 'ocr';

export const ENGINE_NAMES: Readonly<Record<Engine, string>> = {
  ffmpeg: 'FFmpeg',
  soffice: 'LibreOffice',
  pandoc: 'Pandoc',
  magick: 'ImageMagick',
  gs: 'Ghostscript',
  tesseract: 'Tesseract',
  'pandoc+soffice': 'Pandoc + LibreOffice',
  data: 'built in',
  canvas: 'built in',
};

export interface Capabilities {
  tools: Toolbox;
  /** The editor's image decoder and encoder can be used (a desktop editor window). */
  canvas: boolean;
}

/** Every tool, with every format and encoder: what could run here once the tools are installed. */
export const EVERYTHING: Capabilities = {
  canvas: true,
  tools: {
    ffmpeg: { id: 'ffmpeg', path: 'ffmpeg', version: null, encoders: new Set(['*']) },
    soffice: { id: 'soffice', path: 'soffice', version: null },
    pandoc: { id: 'pandoc', path: 'pandoc', version: null },
    magick: {
      id: 'magick',
      path: 'magick',
      version: null,
      reads: new Set(['*']),
      writes: new Set(['*']),
    },
    gs: { id: 'gs', path: 'gs', version: null },
    tesseract: {
      id: 'tesseract',
      path: 'tesseract',
      version: null,
      languages: [],
      imageFormats: new Set(['*']),
    },
  },
};

const kind = (id: string): Kind | undefined => KNOWN_FORMATS[id]?.kind;
const has = (set: ReadonlySet<string> | undefined, value: string) =>
  !!set && (set.has('*') || set.has(value));

// --- The extension's own conversions ---------------------------------------------------------

/** Data conversions in TypeScript (`data.ts`). */
const DATA_PAIRS = new Set(['json>csv', 'json>yaml', 'csv>json']);
/** What the editor's image decoder reads (Chromium) and what its canvas writes. */
export const CANVAS_READS = new Set(['png', 'jpg', 'webp', 'gif', 'bmp', 'avif', 'ico', 'svg']);
export const CANVAS_WRITES = new Set(['png', 'jpg', 'webp']);

// --- FFmpeg ------------------------------------------------------------------------------------

const VIDEO_TARGETS = ['mp4', 'webm', 'mov', 'mkv', 'avi', 'gif'] as const;
const AUDIO_TARGETS = ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'] as const;

/** The video encoder for a target, by preference; null when this FFmpeg has none. */
function videoEncoder(to: string, encoders: ReadonlySet<string> | undefined): string | null {
  const choices: Record<string, string[]> = {
    mp4: ['libx264', 'libopenh264', 'mpeg4'],
    mov: ['libx264', 'libopenh264', 'mpeg4'],
    mkv: ['libx264', 'libopenh264', 'mpeg4'],
    webm: ['libvpx-vp9', 'libvpx'],
    avi: ['mpeg4'],
    gif: ['gif'],
  };
  return (choices[to] ?? []).find((encoder) => has(encoders, encoder)) ?? null;
}

/** The audio encoder for a target (a video target or an audio one). */
function audioEncoder(to: string, encoders: ReadonlySet<string> | undefined): string | null {
  const choices: Record<string, string[]> = {
    mp4: ['aac'],
    mov: ['aac'],
    mkv: ['aac'],
    webm: ['libopus', 'libvorbis'],
    avi: ['libmp3lame', 'pcm_s16le'],
    mp3: ['libmp3lame'],
    wav: ['pcm_s16le'],
    m4a: ['aac'],
    aac: ['aac'],
    flac: ['flac'],
    ogg: ['libvorbis'],
    opus: ['libopus'],
  };
  return (choices[to] ?? []).find((encoder) => has(encoders, encoder)) ?? null;
}

function ffmpegDoes(from: string, to: string, tool: Tool | undefined): boolean {
  if (!tool || from === to) return false;
  const source = kind(from);
  const video = (VIDEO_TARGETS as readonly string[]).includes(to);
  const audio = (AUDIO_TARGETS as readonly string[]).includes(to);
  if (source === 'video') {
    if (video)
      return (
        !!videoEncoder(to, tool.encoders) && (to === 'gif' || !!audioEncoder(to, tool.encoders))
      );
    return audio && !!audioEncoder(to, tool.encoders);
  }
  // An animated GIF becomes a video (no sound).
  if (from === 'gif') return (to === 'mp4' || to === 'webm') && !!videoEncoder(to, tool.encoders);
  if (source === 'audio') return audio && !!audioEncoder(to, tool.encoders);
  return false;
}

// --- LibreOffice -------------------------------------------------------------------------------

/** LibreOffice's export filter for a target, by the kind of document it starts from. */
const OFFICE_TARGETS: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  document: {
    pdf: 'pdf',
    docx: 'docx:MS Word 2007 XML',
    doc: 'doc:MS Word 97',
    odt: 'odt',
    rtf: 'rtf',
    txt: 'txt:Text (encoded):UTF8',
  },
  spreadsheet: {
    pdf: 'pdf',
    xlsx: 'xlsx:Calc MS Excel 2007 XML',
    xls: 'xls:MS Excel 97',
    ods: 'ods',
    // Comma, double quotes, UTF-8, from the first line (the first sheet only).
    csv: 'csv:Text - txt - csv (StarCalc):44,34,76,1',
  },
  presentation: {
    pdf: 'pdf',
    pptx: 'pptx:Impress MS PowerPoint 2007 XML',
    ppt: 'ppt:MS PowerPoint 97',
    odp: 'odp',
  },
};

function sofficeFilter(from: string, to: string): string | null {
  const source = kind(from);
  if (!source || from === to) return null;
  return OFFICE_TARGETS[source]?.[to] ?? null;
}

// --- Pandoc ------------------------------------------------------------------------------------

const PANDOC_READERS: Readonly<Record<string, string>> = {
  md: 'gfm',
  html: 'html',
  docx: 'docx',
  odt: 'odt',
  epub: 'epub',
};
const PANDOC_WRITERS: Readonly<Record<string, string>> = {
  md: 'gfm',
  html: 'html5',
  docx: 'docx',
  odt: 'odt',
  epub: 'epub3',
  rtf: 'rtf',
  txt: 'plain',
};

const pandocDoes = (from: string, to: string) =>
  from !== to && !!PANDOC_READERS[from] && !!PANDOC_WRITERS[to];

// --- ImageMagick -------------------------------------------------------------------------------

/** ImageMagick's name (coder) for a format. */
const MAGICK_CODERS: Readonly<Record<string, string>> = {
  jpg: 'JPEG',
  png: 'PNG',
  webp: 'WEBP',
  avif: 'AVIF',
  heic: 'HEIC',
  gif: 'GIF',
  bmp: 'BMP',
  tiff: 'TIFF',
  ico: 'ICO',
  svg: 'SVG',
  cr2: 'CR2',
  nef: 'NEF',
  arw: 'ARW',
  dng: 'DNG',
};
const MAGICK_TARGETS = new Set(['jpg', 'png', 'webp', 'avif', 'gif', 'bmp', 'tiff', 'ico']);

function magickDoes(from: string, to: string, tool: Tool | undefined): boolean {
  if (!tool || from === to || !MAGICK_TARGETS.has(to)) return false;
  const reader = MAGICK_CODERS[from];
  const writer = MAGICK_CODERS[to];
  return !!reader && !!writer && has(tool.reads, reader) && has(tool.writes, writer);
}

// --- Choosing --------------------------------------------------------------------------------

/**
 * What converts `from` to `to` on this computer, or null. When several could, the one that does
 * it best: ImageMagick before the built-in image encoder, LibreOffice for Office formats and PDF,
 * Pandoc for Markdown, HTML, EPUB and plain text, and the two together for Markdown to PDF.
 */
export function engineFor(
  from: string,
  to: string,
  variant: Variant | null,
  caps: Capabilities,
): Engine | null {
  const { tools } = caps;
  if (variant === 'compress') return from === 'pdf' && to === 'pdf' && tools.gs ? 'gs' : null;
  if (variant === 'ocr') {
    if (to !== 'txt' || !tools.tesseract) return null;
    if (from === 'pdf') return tools.gs ? 'tesseract' : null;
    return has(tools.tesseract.imageFormats, from) ? 'tesseract' : null;
  }
  if (from === to) return null;
  if (DATA_PAIRS.has(`${from}>${to}`)) return 'data';
  if (magickDoes(from, to, tools.magick)) return 'magick';
  if (caps.canvas && CANVAS_READS.has(from) && CANVAS_WRITES.has(to)) return 'canvas';
  if (ffmpegDoes(from, to, tools.ffmpeg)) return 'ffmpeg';
  const office = sofficeFilter(from, to);
  const markup = pandocDoes(from, to);
  const pandocFirst =
    ['md', 'html', 'epub', 'txt'].includes(from) || ['md', 'html', 'epub'].includes(to);
  if (markup && tools.pandoc && (pandocFirst || !office || !tools.soffice)) return 'pandoc';
  if (office && tools.soffice) return 'soffice';
  if (markup && tools.pandoc) return 'pandoc';
  // Markdown to PDF without LaTeX: Pandoc writes a Word file, LibreOffice makes the PDF of it.
  if (from === 'md' && to === 'pdf' && tools.pandoc && tools.soffice) return 'pandoc+soffice';
  if (from === 'pdf' && to === 'txt' && tools.gs) return 'gs';
  return null;
}

/** A choice of the picker for this computer. */
export interface LocalTarget {
  to: string;
  variant: Variant | null;
  label: string;
  /** What runs it (`FFmpeg`, `built in`, or `2 tools` when the files differ). */
  engine: string;
  /** The files it applies to (indexes into the selection). */
  files: number[];
  /** The API's options for the same conversion in the cloud or the desktop app. */
  options?: Record<string, unknown>;
}

/** The order targets are shown in: what developers convert to most, first. */
const TARGET_ORDER = [
  'webp',
  'png',
  'jpg',
  'avif',
  'pdf',
  'mp4',
  'webm',
  'gif',
  'mp3',
  'docx',
  'md',
  'html',
  'txt',
  'csv',
  'json',
  'yaml',
  'xlsx',
  'pptx',
  'odt',
  'ods',
  'odp',
  'epub',
  'rtf',
  'm4a',
  'wav',
  'ogg',
  'opus',
  'flac',
  'aac',
  'mov',
  'mkv',
  'avi',
  'tiff',
  'bmp',
  'ico',
  'doc',
  'xls',
  'ppt',
];

/** The label of a target in the picker. */
export function targetLabel(to: string, variant: Variant | null): string {
  if (variant === 'compress') return 'PDF, smaller file';
  if (variant === 'ocr') return 'Text, recognizing the words (OCR)';
  return formatName(to);
}

/** The targets a selection of files (their format ids; null when unknown) has on this computer. */
export function localTargets(
  formats: ReadonlyArray<string | null>,
  caps: Capabilities,
  /** Per file: whether it is on disk (tools need a path; the built-in conversions do not). */
  onDisk: readonly boolean[],
): LocalTarget[] {
  const found = new Map<
    string,
    { to: string; variant: Variant | null; files: number[]; engines: Set<Engine> }
  >();
  const tried: Array<[string, Variant | null]> = [
    ...TARGET_ORDER.map((to): [string, Variant | null] => [to, null]),
    ['pdf', 'compress'],
    ['txt', 'ocr'],
  ];
  formats.forEach((from, index) => {
    if (!from) return;
    const usable: Capabilities = onDisk[index] ? caps : { tools: {}, canvas: caps.canvas };
    for (const [to, variant] of tried) {
      const engine = engineFor(from, to, variant, usable);
      if (!engine) continue;
      const key = `${to}/${variant ?? ''}`;
      const entry = found.get(key) ?? { to, variant, files: [], engines: new Set<Engine>() };
      entry.files.push(index);
      entry.engines.add(engine);
      found.set(key, entry);
    }
  });
  const targets = [...found.values()].map((entry): LocalTarget => {
    const names = new Set([...entry.engines].map((engine) => ENGINE_NAMES[engine]));
    return {
      to: entry.to,
      variant: entry.variant,
      label: targetLabel(entry.to, entry.variant),
      engine: names.size === 1 ? [...names][0]! : `${names.size} tools`,
      files: entry.files,
      ...(entry.variant === 'ocr' ? { options: { ocr: true } } : {}),
      ...(entry.variant === 'compress' ? { options: {} } : {}),
    };
  });
  // Those that fit every file first; otherwise in TARGET_ORDER.
  const all = formats.length;
  return targets.sort((a, b) => Number(b.files.length === all) - Number(a.files.length === all));
}

// --- Command lines ---------------------------------------------------------------------------

/** One program run of a conversion, or a list file written between two runs. */
export type Step =
  | { tool: ToolId; args: string[]; cwd?: string }
  | { makeFolder: string }
  | { listFiles: { folder: string; prefix: string; into: string } };

export interface Plan {
  steps: Step[];
  /** The result: a file, or the only file in a folder (LibreOffice names it itself). */
  output: { file: string } | { onlyFileIn: string };
}

export interface Job {
  /** The original's absolute path. */
  input: string;
  from: string;
  to: string;
  variant: Variant | null;
  /** An empty folder of the extension's own for this conversion. */
  work: string;
  /** LibreOffice's own profile folder (so it never meets an open LibreOffice window). */
  profile: string;
  /** Tesseract's languages (`eng`, `eng+deu`). */
  languages: string;
  /** The CSV's field separator, when the original is a CSV. */
  csvSeparator?: string;
  /** The original's name without its extension (Pandoc's HTML title). */
  title: string;
}

/** FFmpeg's arguments. Paths go through the `file:` protocol, so no name is read as a protocol. */
export function ffmpegArgs(
  input: string,
  output: string,
  from: string,
  to: string,
  tool: Tool,
): string[] {
  const args = [
    '-hide_banner',
    '-nostdin',
    '-nostats',
    '-progress',
    'pipe:1',
    // Only local files: a crafted playlist cannot make FFmpeg open anything else.
    '-protocol_whitelist',
    'file',
    '-i',
    `file:${input}`,
  ];
  const video = videoEncoder(to, tool.encoders);
  const audio = audioEncoder(to, tool.encoders);
  if (to === 'gif') {
    args.push(
      '-an',
      '-filter_complex',
      "fps=12,scale='min(640,iw)':-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse",
      '-loop',
      '0',
    );
  } else if ((VIDEO_TARGETS as readonly string[]).includes(to)) {
    args.push('-map', '0:v:0', '-map', '0:a:0?', '-c:v', video!);
    if (video === 'libx264') args.push('-preset', 'medium', '-crf', '23');
    if (video === 'libopenh264') args.push('-b:v', '4M');
    if (video === 'libvpx-vp9') args.push('-crf', '32', '-b:v', '0', '-row-mt', '1');
    if (video === 'libvpx') args.push('-crf', '10', '-b:v', '1M');
    if (video === 'mpeg4') args.push('-q:v', '4');
    if (video !== 'libvpx-vp9' && video !== 'libvpx')
      // H.264 in 4:2:0 needs even sizes.
      args.push('-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-pix_fmt', 'yuv420p');
    if (from === 'gif') args.push('-an');
    else {
      args.push('-c:a', audio!);
      if (audio === 'aac') args.push('-b:a', '160k');
      if (audio === 'libopus') args.push('-b:a', '128k');
      if (audio === 'libvorbis') args.push('-q:a', '5');
      if (audio === 'libmp3lame') args.push('-q:a', '4');
    }
    if (to === 'mp4' || to === 'mov') args.push('-movflags', '+faststart');
  } else {
    args.push('-vn', '-map', '0:a:0', '-map_metadata', '0', '-c:a', audio!);
    if (audio === 'libmp3lame') args.push('-q:a', '2');
    if (audio === 'aac') args.push('-b:a', '192k');
    if (audio === 'libvorbis') args.push('-q:a', '5');
    if (audio === 'libopus') args.push('-b:a', '128k');
    if (to === 'aac') args.push('-f', 'adts');
  }
  args.push('-n', `file:${output}`);
  return args;
}

/** LibreOffice's arguments: headless, with its own profile, the result into `outdir`. */
export function sofficeArgs(job: Job, outdir: string): string[] {
  const filter = sofficeFilter(job.from, job.to);
  if (!filter) throw new Error(`LibreOffice does not convert ${job.from} to ${job.to}`);
  const args = [
    `-env:UserInstallation=${pathToFileURL(job.profile).href}`,
    '--headless',
    '--invisible',
    '--nologo',
    '--nodefault',
    '--norestore',
    '--nolockcheck',
  ];
  if (job.from === 'csv') {
    const separator = (job.csvSeparator ?? ',').charCodeAt(0);
    args.push(`--infilter=CSV:${separator},34,76,1`);
  }
  args.push('--convert-to', filter, '--outdir', outdir, job.input);
  return args;
}

/** Pandoc's arguments. It runs in the original's folder, so its relative images are found. */
export function pandocArgs(job: Job, output: string): string[] {
  const args = ['--from', PANDOC_READERS[job.from]!, '--to', PANDOC_WRITERS[job.to]!];
  if (job.to === 'html' || job.to === 'rtf') args.push('--standalone');
  if (job.to === 'html') args.push('--metadata', `pagetitle=${job.title}`);
  args.push('--output', output, job.input);
  return args;
}

/** Formats that keep every frame (an animated GIF or WebP, a multi-page TIFF). */
const ANIMATED = new Set(['gif', 'webp', 'tiff']);
const MULTI_FRAME_SOURCES = new Set(['gif', 'webp', 'tiff', 'ico', 'heic', 'avif']);

/**
 * ImageMagick's arguments. Each path carries its format (`PNG:/path/a.png`), so ImageMagick
 * never guesses a format from a file's contents or reads a name as an instruction.
 */
export function magickArgs(job: Job, output: string): string[] {
  const reader = MAGICK_CODERS[job.from]!;
  const writer = MAGICK_CODERS[job.to]!;
  const keepFrames = ANIMATED.has(job.to) && ANIMATED.has(job.from);
  const frame = MULTI_FRAME_SOURCES.has(job.from) && !keepFrames ? '[0]' : '';
  const args: string[] = [];
  if (job.from === 'svg') args.push('-background', 'none');
  args.push(`${reader}:${job.input}${frame}`, '-auto-orient');
  if (job.to === 'jpg' || job.to === 'bmp')
    args.push('-background', 'white', '-alpha', 'remove', '-alpha', 'off');
  if (job.to === 'jpg') args.push('-quality', '90');
  if (job.to === 'webp') args.push('-quality', '85');
  if (job.to === 'avif') args.push('-quality', '60');
  if (job.to === 'ico')
    args.push('-resize', '256x256>', '-define', 'icon:auto-resize=256,128,64,48,32,16');
  args.push(`${writer}:${output}`);
  return args;
}

/** Ghostscript reads `%` in an output name as a page number. */
const gsName = (path: string) => path.replace(/%/g, '%%');

/** Ghostscript's arguments: a smaller PDF, or the text of a PDF. */
export function gsArgs(job: Job, output: string): string[] {
  const base = ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dQUIET'];
  if (job.variant === 'compress')
    return [
      ...base,
      '-sDEVICE=pdfwrite',
      '-dCompatibilityLevel=1.5',
      '-dPDFSETTINGS=/ebook',
      '-dDetectDuplicateImages=true',
      `-sOutputFile=${gsName(output)}`,
      job.input,
    ];
  return [...base, '-sDEVICE=txtwrite', `-sOutputFile=${gsName(output)}`, job.input];
}

/** The steps of a conversion with a tool (or two). */
export function planFor(engine: ToolEngine, job: Job, tools: Toolbox): Plan {
  const output = join(job.work, `result.${job.to}`);
  switch (engine) {
    case 'ffmpeg':
      return {
        steps: [
          { tool: 'ffmpeg', args: ffmpegArgs(job.input, output, job.from, job.to, tools.ffmpeg!) },
        ],
        output: { file: output },
      };
    case 'soffice': {
      const outdir = join(job.work, 'out');
      return {
        steps: [{ tool: 'soffice', args: sofficeArgs(job, outdir) }],
        output: { onlyFileIn: outdir },
      };
    }
    case 'pandoc':
      return {
        steps: [{ tool: 'pandoc', args: pandocArgs(job, output), cwd: dirname(job.input) }],
        output: { file: output },
      };
    case 'pandoc+soffice': {
      // The Word file goes in a folder of its own; LibreOffice names the PDF after it.
      const step = join(job.work, 'docx');
      const docx = join(step, `${job.title || 'document'}.docx`);
      const outdir = join(job.work, 'out');
      return {
        steps: [
          { makeFolder: step },
          {
            tool: 'pandoc',
            args: pandocArgs({ ...job, to: 'docx' }, docx),
            cwd: dirname(job.input),
          },
          { tool: 'soffice', args: sofficeArgs({ ...job, input: docx, from: 'docx' }, outdir) },
        ],
        output: { onlyFileIn: outdir },
      };
    }
    case 'magick':
      return {
        steps: [{ tool: 'magick', args: magickArgs(job, output) }],
        output: { file: output },
      };
    case 'gs':
      return { steps: [{ tool: 'gs', args: gsArgs(job, output) }], output: { file: output } };
    case 'tesseract': {
      const base = join(job.work, 'result');
      const language = ['-l', job.languages];
      if (job.from !== 'pdf')
        return {
          steps: [{ tool: 'tesseract', args: [job.input, base, ...language, 'txt'] }],
          output: { file: `${base}.txt` },
        };
      // A scanned PDF: its pages as images at 300 dpi (Ghostscript), then all of them read at once.
      const pages = join(job.work, 'pages');
      const list = join(job.work, 'pages.txt');
      return {
        steps: [
          { makeFolder: pages },
          {
            tool: 'gs',
            args: [
              '-dSAFER',
              '-dBATCH',
              '-dNOPAUSE',
              '-dQUIET',
              '-sDEVICE=pnggray',
              '-r300',
              `-sOutputFile=${gsName(join(pages, 'page-'))}%04d.png`,
              job.input,
            ],
          },
          { listFiles: { folder: pages, prefix: 'page-', into: list } },
          { tool: 'tesseract', args: [list, base, ...language, 'txt'] },
        ],
        output: { file: `${base}.txt` },
      };
    }
  }
}
