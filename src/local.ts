import { createReadStream, promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { save, type FileAccess, type Outcome, type Questions } from './convert';
import { convertData, csvSeparator } from './data';
import { ConverterStudioError, asConverterStudioError } from './errors';
import { formatName } from './known';
import { resultName, stemOf } from './naming';
import {
  ENGINE_NAMES,
  EVERYTHING,
  engineFor,
  planFor,
  type Capabilities,
  type Engine,
  type LocalTarget,
  type Variant,
} from './recipes';
import { runTool, toolMessage, type RunResult, type Runner } from './run';
import { TOOL_NAMES, type ToolId } from './tools';

/**
 * Converting files on this computer: with the extension's own code or a tool installed here.
 * Each tool writes into a folder of its own in the system's temporary folder; the result is then
 * saved next to the original under a free name, and the folder is removed. Nothing is uploaded.
 */

export interface LocalSettings {
  existingFiles: 'keepBoth' | 'ask';
  /** The longest one conversion may take. */
  timeoutMs: number;
  /** Files converted at once. */
  concurrency: number;
  /** Tesseract's languages (`eng`, `eng+deu`). */
  languages: string;
}

export const DEFAULT_LOCAL_SETTINGS: LocalSettings = {
  existingFiles: 'keepBoth',
  timeoutMs: 30 * 60_000,
  concurrency: 2,
  languages: 'eng',
};

/** Converts an image with the editor's own image decoder and encoder. */
export type ImageConverter = (
  bytes: Uint8Array,
  from: string,
  to: string,
  signal: AbortSignal,
) => Promise<Uint8Array>;

export type LocalStage = 'converting' | 'saving';

export interface LocalDeps<F> {
  files: FileAccess<F>;
  /** The file's path on disk, or null when it is not on disk (a virtual file system). */
  pathOf(file: F): string | null;
  /** Each file's format (indexes into the selection); null when unknown. */
  formats: ReadonlyArray<string | null>;
  caps: Capabilities;
  /** The workspace is trusted (in Restricted Mode no tool runs). */
  trusted: boolean;
  questions: Pick<Questions, 'existing'>;
  settings: LocalSettings;
  /** LibreOffice's profile folder, kept between conversions. */
  profile: string;
  canvas?: ImageConverter;
  run?: Runner;
  /** A new, empty folder for one conversion. */
  workFolder?: () => Promise<string>;
  onStage?: (index: number, stage: LocalStage, fraction: number | null) => void;
  onDone?: (index: number, outcome: Outcome<F>) => void;
}

/** Data and images the extension converts itself are read into memory: up to this size. */
const MAX_DATA_BYTES = 64 * 1024 * 1024;
const MAX_IMAGE_BYTES = 128 * 1024 * 1024;

/** Why a file has no conversion to the target on this computer. */
export function whyNotLocal(
  from: string | null,
  to: string,
  variant: Variant | null,
  context: { trusted: boolean; onDisk: boolean; canvas: boolean },
): ConverterStudioError {
  const target = variant === 'compress' ? 'a smaller PDF' : formatName(to);
  if (!from)
    return new ConverterStudioError(
      'noLocalConversion',
      `The extension does not know this kind of file, so it cannot convert it to ${target} on this computer.`,
    );
  const could = engineFor(from, to, variant, { ...EVERYTHING, canvas: context.canvas });
  if (could && could !== 'data' && could !== 'canvas') {
    if (!context.trusted)
      return new ConverterStudioError(
        'untrustedWorkspace',
        `${TOOL_NAMES[could]} would convert it, but tools on this computer do not run in Restricted Mode. Trust the workspace to use them.`,
      );
    if (!context.onDisk)
      return new ConverterStudioError(
        'notOnDisk',
        `${TOOL_NAMES[could]} needs a file on disk; this one is in a virtual file system.`,
      );
    return new ConverterStudioError(
      'noLocalConversion',
      `No tool on this computer converts ${formatName(from)} to ${target}; ${toolHint(could, from, to, variant)}.`,
    );
  }
  return new ConverterStudioError(
    'noLocalConversion',
    `Nothing on this computer converts ${formatName(from)} to ${target}.`,
  );
}

function toolHint(tool: ToolId, from: string, to: string, variant: Variant | null): string {
  if (variant === 'ocr' && from === 'pdf') return 'Tesseract and Ghostscript would';
  if (tool === 'magick' && (from === 'heic' || to === 'heic'))
    return 'ImageMagick built with HEIC support (libheif) would';
  if (tool === 'ffmpeg') return 'FFmpeg (with the right encoder) would';
  return `${TOOL_NAMES[tool]} would`;
}

/** One lock per key: LibreOffice runs one conversion at a time with its profile. */
const locks = new Map<string, Promise<unknown>>();
async function oneAtATime<T>(key: string, task: () => Promise<T>): Promise<T> {
  const before = locks.get(key) ?? Promise.resolve();
  const next = before.then(task, task);
  locks.set(
    key,
    next.catch(() => undefined),
  );
  return next;
}

/** FFmpeg's progress: the input's length from its log, the time written from `-progress`. */
function ffmpegProgress(onFraction: (fraction: number) => void) {
  let duration = 0;
  return {
    stderr: (text: string) => {
      const match = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
      if (match && !duration)
        duration = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    },
    stdout: (text: string) => {
      const matches = [...text.matchAll(/out_time_us=(\d+)/g)];
      const last = matches[matches.length - 1];
      if (last && duration > 0) onFraction(Math.min(1, Number(last[1]) / 1e6 / duration));
    },
  };
}

async function readAll(stream: AsyncIterable<Uint8Array>, limit: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    length += chunk.byteLength;
    if (length > limit) throw new ConverterStudioError('tooLarge');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function* once(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield await Promise.resolve(bytes);
}

const defaultWorkFolder = () => fsp.mkdtemp(join(tmpdir(), 'converter-studio-'));

/** Converts one file on this computer and saves the result next to it. */
export async function convertHere<F>(
  deps: LocalDeps<F>,
  file: F,
  index: number,
  target: Pick<LocalTarget, 'to' | 'variant'>,
  signal: AbortSignal,
): Promise<{ result: F; engine: Engine }> {
  const { files } = deps;
  const from = deps.formats[index] ?? null;
  const path = deps.pathOf(file);
  const caps: Capabilities =
    deps.trusted && path ? deps.caps : { tools: {}, canvas: deps.caps.canvas };
  const engine = from ? engineFor(from, target.to, target.variant, caps) : null;
  if (!from || !engine || (engine === 'canvas' && !deps.canvas))
    throw whyNotLocal(from, target.to, target.variant, {
      trusted: deps.trusted,
      onDisk: !!path,
      canvas: deps.caps.canvas,
    });
  const name = files.name(file);
  const wanted =
    target.variant === 'compress'
      ? `${stemOf(name) || 'document'}-compressed.pdf`
      : resultName(name, null, target.to);
  const stage = (s: LocalStage, fraction: number | null = null) =>
    deps.onStage?.(index, s, fraction);
  stage('converting');

  if (engine === 'data' || engine === 'canvas') {
    const bytes = await readAll(
      files.read(file, signal),
      engine === 'data' ? MAX_DATA_BYTES : MAX_IMAGE_BYTES,
    );
    if (bytes.byteLength === 0) throw new ConverterStudioError('sourceEmpty');
    const out =
      engine === 'data'
        ? new TextEncoder().encode(convertData(from, target.to, new TextDecoder().decode(bytes)))
        : await deps.canvas!(bytes, from, target.to, signal);
    if (signal.aborted) throw new ConverterStudioError('canceled');
    stage('saving');
    const result = await save(deps, file, wanted, { body: once(out), signal });
    return { result, engine };
  }

  if (engine === 'tesseract')
    checkLanguages(deps.settings.languages, caps.tools.tesseract?.languages);
  const work = await (deps.workFolder ?? defaultWorkFolder)();
  try {
    let csv: string | undefined;
    if (from === 'csv') {
      const head = await readHead(path!, 64 * 1024);
      csv = csvSeparator(head);
    }
    const plan = planFor(
      engine,
      {
        input: path!,
        from,
        to: target.to,
        variant: target.variant,
        work,
        profile: deps.profile,
        languages: deps.settings.languages,
        title: stemOf(name) || name,
        ...(csv ? { csvSeparator: csv } : {}),
      },
      caps.tools,
    );
    const deadline = Date.now() + deps.settings.timeoutMs;
    const run = deps.run ?? runTool;
    let last: RunResult = { code: 0, stdout: '', stderr: '' };
    const runSteps = async () => {
      for (const step of plan.steps) {
        if (signal.aborted) throw new ConverterStudioError('canceled');
        if ('makeFolder' in step) {
          await fsp.mkdir(step.makeFolder, { recursive: true });
          continue;
        }
        if ('listFiles' in step) {
          const { folder, prefix, into } = step.listFiles;
          const pages = (await fsp.readdir(folder).catch(() => [] as string[]))
            .filter((n) => n.startsWith(prefix))
            .sort();
          if (pages.length === 0)
            throw new ConverterStudioError('toolFailed', 'Ghostscript found no pages in the PDF.');
          await fsp.writeFile(into, pages.map((n) => join(folder, n)).join('\n') + '\n');
          continue;
        }
        const program = caps.tools[step.tool]!;
        const progress =
          step.tool === 'ffmpeg' ? ffmpegProgress((f) => stage('converting', f)) : null;
        last = await run(program.path, step.args, {
          ...(step.cwd ? { cwd: step.cwd } : {}),
          timeoutMs: Math.max(1000, deadline - Date.now()),
          signal,
          ...(progress ? { onStdout: progress.stdout, onStderr: progress.stderr } : {}),
        });
        if (last.code !== 0)
          throw new ConverterStudioError(
            'toolFailed',
            `${TOOL_NAMES[step.tool]} could not convert ${name}${detail(last)}`,
          );
      }
    };
    if (engine === 'soffice') await oneAtATime(deps.profile, runSteps);
    else await runSteps();

    const output =
      'file' in plan.output ? plan.output.file : await onlyFile(plan.output.onlyFileIn);
    const size = output
      ? await fsp
          .stat(output)
          .then((s) => s.size)
          .catch(() => 0)
      : 0;
    if (!output || size === 0)
      throw new ConverterStudioError(
        'toolFailed',
        `${TOOL_NAMES[engine]} made no result from ${name}${detail(last)}`,
      );
    if (target.variant === 'compress') {
      const original = await files.size(file);
      if (size >= original)
        throw new ConverterStudioError(
          'notSmaller',
          `${name} is already as small as Ghostscript makes it; nothing was saved.`,
        );
    }
    stage('saving');
    const result = await save(deps, file, wanted, { body: createReadStream(output), signal });
    return { result, engine };
  } finally {
    await fsp.rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Tesseract's languages: `eng`, `eng+deu`, each one installed. */
export function checkLanguages(languages: string, installed: readonly string[] | undefined): void {
  if (!/^[\w/-]+(\+[\w/-]+)*$/.test(languages))
    throw new ConverterStudioError(
      'toolFailed',
      `converterStudio.local.ocrLanguages must be Tesseract language codes joined by "+", such as eng+deu (it is "${languages}").`,
    );
  if (!installed || installed.length === 0) return;
  const missing = languages.split('+').filter((language) => !installed.includes(language));
  if (missing.length > 0)
    throw new ConverterStudioError(
      'toolFailed',
      `Tesseract has no language data for ${missing.join(', ')} on this computer (it has ${installed.join(', ')}). Install the language or change converterStudio.local.ocrLanguages.`,
    );
}

const detail = (result: RunResult) => {
  const message = toolMessage(result);
  return message ? `: ${message}` : '.';
};

async function readHead(path: string, bytes: number): Promise<string> {
  const handle = await fsp.open(path, 'r');
  try {
    const buffer = Buffer.alloc(bytes);
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    await handle.close();
  }
}

async function onlyFile(folder: string): Promise<string | null> {
  const names = await fsp.readdir(folder).catch(() => [] as string[]);
  return names.length === 1 ? join(folder, names[0]!) : null;
}

/** Not done, but nothing went wrong: no conversion here for the file, or nothing to save. */
const SKIPS = new Set([
  'skipped',
  'notSmaller',
  'noLocalConversion',
  'untrustedWorkspace',
  'notOnDisk',
]);

/**
 * Converts a selection on this computer, a few files at a time. Files the target does not apply
 * to are skipped with the reason; nothing is sent anywhere.
 */
export async function convertAllHere<F>(
  deps: LocalDeps<F>,
  selection: readonly F[],
  target: LocalTarget,
  signal: AbortSignal,
): Promise<Outcome<F>[]> {
  const outcomes: Outcome<F>[] = new Array<Outcome<F>>(selection.length);
  const applies = new Set(target.files);
  const queue: number[] = [];
  selection.forEach((file, index) => {
    if (applies.has(index)) return void queue.push(index);
    const error = whyNotLocal(deps.formats[index] ?? null, target.to, target.variant, {
      trusted: deps.trusted,
      onDisk: deps.pathOf(file) !== null,
      canvas: deps.caps.canvas,
    });
    outcomes[index] = { status: 'skipped', file, error };
    deps.onDone?.(index, outcomes[index]);
  });

  const worker = async () => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined) return;
      const file = selection[index]!;
      let outcome: Outcome<F>;
      if (signal.aborted)
        outcome = { status: 'skipped', file, error: new ConverterStudioError('canceled') };
      else {
        try {
          const { result, engine } = await convertHere(deps, file, index, target, signal);
          outcome = { status: 'converted', file, result, credits: 0, engine: ENGINE_NAMES[engine] };
        } catch (thrown) {
          const error = signal.aborted
            ? new ConverterStudioError('canceled')
            : asConverterStudioError(thrown);
          outcome = SKIPS.has(error.code)
            ? { status: 'skipped', file, error }
            : { status: 'failed', file, error };
        }
      }
      outcomes[index] = outcome;
      deps.onDone?.(index, outcome);
    }
  };
  const workers = Math.max(1, Math.min(deps.settings.concurrency, queue.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return outcomes;
}
