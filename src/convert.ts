import { randomUUID } from 'node:crypto';
import type { ConversionView, ConverterStudioClient } from './client';
import { ConverterStudioError, asConverterStudioError, stopsBatch } from './errors';
import type { Target } from './formats';
import { freeName, resultName } from './naming';

/**
 * Converting a selection of files: each file is uploaded, converted to the chosen target, and its
 * result saved next to it. Nothing here knows VS Code: the file system and the questions to the
 * user are given, so the same code runs in the editor and in the unit tests.
 */

/** The file operations a conversion needs, on files of type F (VS Code's `Uri`, or a path). */
export interface FileAccess<F> {
  /** The file's name, without its folder. */
  name(file: F): string;
  /** Another file in the same folder. */
  sibling(file: F, name: string): F;
  size(file: F): Promise<number>;
  read(file: F, signal: AbortSignal): AsyncIterable<Uint8Array>;
  exists(file: F): Promise<boolean>;
  /**
   * Writes a file from a stream. Without `overwrite`, fails with `exists: true` if the file is
   * there; an unfinished write leaves nothing behind.
   */
  write(
    file: F,
    body: AsyncIterable<Uint8Array>,
    options: { overwrite: boolean; signal: AbortSignal },
  ): Promise<void>;
}

/** What to do when the result's name is taken. */
export type ExistingChoice = 'overwrite' | 'keepBoth' | 'skip';

export interface Questions {
  /** The conversion costs more than the limit: go ahead and pay `credits`? */
  confirmCost(fileName: string, credits: number | null, limit: number): Promise<boolean>;
  /** `name` is already there: overwrite it, keep both or skip? */
  existing(name: string): Promise<ExistingChoice>;
}

export type Stage = 'uploading' | 'converting' | 'confirming' | 'downloading';

export interface ConvertSettings {
  /** A dearer conversion asks first (`confirmCost`). */
  maxCredits: number;
  /** `ask` asks `existing`; `keepBoth` numbers the new name. Nothing is overwritten silently. */
  existingFiles: 'keepBoth' | 'ask';
  /** The longest a conversion may take before the extension stops waiting. */
  timeoutMs: number;
  /** Files converted at once. */
  concurrency: number;
}

export const DEFAULT_SETTINGS: ConvertSettings = {
  maxCredits: 20,
  existingFiles: 'keepBoth',
  timeoutMs: 60 * 60_000,
  concurrency: 3,
};

export interface ConvertDeps<F> {
  client: ConverterStudioClient;
  files: FileAccess<F>;
  questions: Questions;
  settings: ConvertSettings;
  /** Each step of each file (index into the selection), with a fraction when known. */
  onStage?: (index: number, stage: Stage, fraction: number | null) => void;
  /** Called when a file is finished (converted, failed or skipped). */
  onDone?: (index: number, outcome: Outcome<F>) => void;
  /** Makes Idempotency-Keys; replaced in tests. */
  newKey?: () => string;
}

export type Outcome<F> =
  | { status: 'converted'; file: F; result: F; credits: number }
  | { status: 'failed'; file: F; error: ConverterStudioError }
  | { status: 'skipped'; file: F; error: ConverterStudioError };

/** Converts one file to the target and saves the result next to it. */
export async function convertFile<F>(
  deps: ConvertDeps<F>,
  file: F,
  index: number,
  target: Pick<Target, 'to' | 'options' | 'label'>,
  signal: AbortSignal,
): Promise<{ result: F; credits: number }> {
  const { client, files, settings } = deps;
  const stage = (s: Stage, fraction: number | null = null) => deps.onStage?.(index, s, fraction);
  const name = files.name(file);

  let size: number;
  try {
    size = await files.size(file);
  } catch (cause) {
    throw new ConverterStudioError('sourceUnreadable', undefined, { cause });
  }
  if (size === 0) throw new ConverterStudioError('sourceEmpty');

  stage('uploading', 0);
  const uploadId = await client.upload({
    fileName: name,
    size,
    stream: files.read(file, signal),
    signal,
    onProgress: (sent) => stage('uploading', sent / size),
  });

  stage('converting', null);
  // One key per file: a request sent again after a lost answer gets the same conversion.
  const idempotencyKey = deps.newKey?.() ?? randomUUID();
  let view = await client.start({
    uploadId,
    to: target.to,
    ...(target.options ? { options: target.options } : {}),
    maxCredits: settings.maxCredits,
    idempotencyKey,
    signal,
  });
  const onUpdate = (v: ConversionView) => stage('converting', v.progress);
  view = await client.settle(view, { timeoutMs: settings.timeoutMs, signal, onUpdate });

  if (view.status === 'quoted') {
    stage('confirming', null);
    const yes = await deps.questions.confirmCost(name, view.credits, settings.maxCredits);
    if (!yes) throw new ConverterStudioError('declined');
    if (signal.aborted) throw new ConverterStudioError('canceled');
    view = await client.confirm(view.id, signal);
    stage('converting', null);
    view = await client.settle(view, { timeoutMs: settings.timeoutMs, signal, onUpdate });
  }
  failIfNotDone(view);

  stage('downloading', 0);
  const response = await client.download(view.downloadUrl!, signal);
  const total = Number(response.headers.get('content-length')) || view.outputSize || 0;
  const result = await save(deps, file, resultName(name, view.outputName, target.to), {
    body: counted(bodyOf(response), (received) =>
      stage('downloading', total > 0 ? Math.min(1, received / total) : null),
    ),
    signal,
  });
  return { result, credits: view.credits ?? 0 };
}

/** Throws the conversion's own error unless it is done with a result to download. */
function failIfNotDone(view: ConversionView): void {
  if (view.status === 'done' && view.downloadUrl) return;
  if (view.status === 'failed' && view.error)
    throw new ConverterStudioError(view.error.code, view.error.message);
  if (view.status === 'expired')
    throw new ConverterStudioError(
      'fileExpired',
      'The converted file expired before it was downloaded.',
    );
  if (view.status === 'canceled')
    throw new ConverterStudioError(
      'conversionCanceled',
      'The conversion was canceled at Converter Studio; nothing was charged.',
    );
  throw new ConverterStudioError('conversionFailed', `The conversion ended as ${view.status}.`);
}

/** The response body as chunks (Node's web streams are async iterable). */
function bodyOf(response: Response): AsyncIterable<Uint8Array> {
  if (!response.body) throw new ConverterStudioError('resultDownloadFailed');
  return response.body;
}

async function* counted(
  body: AsyncIterable<Uint8Array>,
  onProgress: (received: number) => void,
): AsyncGenerator<Uint8Array> {
  let received = 0;
  for await (const chunk of body) {
    received += chunk.byteLength;
    onProgress(received);
    yield chunk;
  }
}

/**
 * Saves a result next to the original, never over another file without asking: a taken name gets
 * a number, or (`existingFiles: ask`) the user chooses.
 */
async function save<F>(
  deps: ConvertDeps<F>,
  original: F,
  wanted: string,
  input: { body: AsyncIterable<Uint8Array>; signal: AbortSignal },
): Promise<F> {
  const { files } = deps;
  const taken = (name: string) => files.exists(files.sibling(original, name));
  let name = wanted;
  let overwrite = false;
  if (deps.settings.existingFiles === 'ask' && (await taken(name))) {
    const choice = await deps.questions.existing(name);
    if (choice === 'skip') throw new ConverterStudioError('skipped');
    overwrite = choice === 'overwrite';
  }
  for (let attempt = 0; ; attempt++) {
    if (!overwrite) name = await freeName(name, taken);
    const target = files.sibling(original, name);
    try {
      await files.write(target, input.body, { overwrite, signal: input.signal });
      return target;
    } catch (error) {
      // Taken between the check and the write (another conversion of the batch): the next number.
      if ((error as { exists?: boolean }).exists && attempt < 5) continue;
      if (input.signal.aborted) throw new ConverterStudioError('canceled');
      if (error instanceof ConverterStudioError) throw error;
      throw new ConverterStudioError(
        'writeFailed',
        `The converted file could not be saved as ${name}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

/**
 * Converts a selection to one target, a few files at a time. Files the target does not apply to
 * are skipped; after an error that would repeat for every file (a wrong key, no credits left,
 * canceled), the files not started yet are not sent.
 */
export async function convertAll<F>(
  deps: ConvertDeps<F>,
  selection: readonly F[],
  target: Target,
  signal: AbortSignal,
): Promise<Outcome<F>[]> {
  const outcomes: Outcome<F>[] = new Array<Outcome<F>>(selection.length);
  const applies = new Set(target.files);
  const queue: number[] = [];
  selection.forEach((file, index) => {
    if (applies.has(index)) queue.push(index);
    else {
      outcomes[index] = {
        status: 'skipped',
        file,
        error: new ConverterStudioError(
          'unsupportedTarget',
          `Converter Studio cannot convert ${deps.files.name(file)} to ${target.label}.`,
        ),
      };
      deps.onDone?.(index, outcomes[index]);
    }
  });

  let stop: ConverterStudioError | null = null;
  const worker = async () => {
    for (;;) {
      const index = queue.shift();
      if (index === undefined) return;
      const file = selection[index]!;
      let outcome: Outcome<F>;
      if (stop || signal.aborted) {
        const error = stop ?? new ConverterStudioError('canceled');
        outcome = { status: 'skipped', file, error };
      } else {
        try {
          const { result, credits } = await convertFile(deps, file, index, target, signal);
          outcome = { status: 'converted', file, result, credits };
        } catch (thrown) {
          const error = asConverterStudioError(signal.aborted ? stopReason(thrown) : thrown);
          if (error.code === 'skipped' || error.code === 'declined')
            outcome = { status: 'skipped', file, error };
          else {
            outcome = { status: 'failed', file, error };
            if (stopsBatch(error.code)) stop ??= error;
          }
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

/** After the user canceled, every error is a cancellation. */
function stopReason(thrown: unknown): unknown {
  return thrown instanceof ConverterStudioError && thrown.code !== 'canceled'
    ? new ConverterStudioError('canceled')
    : thrown;
}
