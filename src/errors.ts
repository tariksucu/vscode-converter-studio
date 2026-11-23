/**
 * Why a conversion did not happen. The API's own codes (`{ error: { code, message } }`) are kept
 * as it sends them, with its message, which is what the user sees. The extension's own codes are
 * a fixed list, so the log says what went wrong without file contents or keys.
 */

/** Codes of the extension's own. */
export const EXTENSION_ERROR_CODES = [
  /** No API key is saved. */
  'noApiKey',
  /** Converter Studio could not be reached. */
  'network',
  /** Converter Studio answered something that is not its API (a proxy's page, for example). */
  'badResponse',
  /** The user canceled. */
  'canceled',
  /** The conversion did not finish in time (it goes on at Converter Studio). */
  'timeout',
  /** The file is empty. */
  'sourceEmpty',
  /** The file could not be read. */
  'sourceUnreadable',
  /** The file's extension is not one Converter Studio reads. */
  'unrecognizedFormat',
  /** Converter Studio cannot turn this file into the chosen format. */
  'unsupportedTarget',
  /** The upload did not arrive whole. */
  'uploadIncomplete',
  /** The conversion costs more than the limit and the user said no; nothing was charged. */
  'declined',
  /** The result could not be downloaded. */
  'resultDownloadFailed',
  /** The result could not be saved next to the original. */
  'writeFailed',
  /** A file with the result's name exists and the user chose to skip it. */
  'skipped',
  /** Nothing on this computer converts this file to the chosen format. */
  'noLocalConversion',
  /** The workspace is not trusted, so the tools on this computer are not run. */
  'untrustedWorkspace',
  /** The file is not on disk (a virtual file system), and a tool needs a path. */
  'notOnDisk',
  /** The tool could not be started. */
  'toolMissing',
  /** The tool ran but did not make the result. */
  'toolFailed',
  /** The tool did not finish in time and was stopped. */
  'toolTimeout',
  /** A smaller file was asked for, and the result was not smaller. */
  'notSmaller',
  /** The data file could not be read as its format. */
  'invalidData',
  /** The image could not be read or written by the editor's image decoder. */
  'imageUnreadable',
  /** The file is too large for the extension's own conversions. */
  'tooLarge',
  /** The Converter Studio desktop app cannot be used here. */
  'desktopUnavailable',
  /** Conversions in the cloud are turned off in the settings. */
  'cloudOff',
  /** Anything else. */
  'unknown',
] as const;

export type ExtensionErrorCode = (typeof EXTENSION_ERROR_CODES)[number];

/** Plain-English words for the extension's own codes. */
export const ERROR_TEXT: Record<ExtensionErrorCode, string> = {
  noApiKey: 'No Converter Studio API key is set.',
  network: 'Converter Studio could not be reached. Check the connection and try again.',
  badResponse: 'Converter Studio sent an answer the extension cannot read.',
  canceled: 'Canceled.',
  timeout: 'The conversion did not finish in time.',
  sourceEmpty: 'The file is empty.',
  sourceUnreadable: 'The file could not be read.',
  unrecognizedFormat: 'Converter Studio does not read files of this type.',
  unsupportedTarget: 'Converter Studio cannot convert this file to the chosen format.',
  uploadIncomplete: 'The upload to Converter Studio did not arrive whole.',
  declined: 'Not converted: it costs more credits than allowed. Nothing was charged.',
  resultDownloadFailed: 'The converted file could not be downloaded from Converter Studio.',
  writeFailed: 'The converted file could not be saved.',
  skipped: 'Skipped: a file with that name already exists.',
  noLocalConversion: 'Nothing on this computer converts this file to the chosen format.',
  untrustedWorkspace:
    'The tools on this computer are not run in Restricted Mode (an untrusted workspace).',
  notOnDisk: 'The file is not on disk, so the tools on this computer cannot read it.',
  toolMissing: 'The conversion tool could not be started.',
  toolFailed: 'The conversion tool did not make the result.',
  toolTimeout: 'The conversion tool did not finish in time and was stopped.',
  notSmaller: 'Not saved: the result was not smaller than the original.',
  invalidData: 'The file could not be read.',
  imageUnreadable: 'The image could not be converted by the editor.',
  tooLarge: 'The file is too large for the extension to convert itself.',
  desktopUnavailable: 'The Converter Studio desktop app cannot be used here.',
  cloudOff: 'Conversions in the cloud are turned off (converterStudio.cloud.enabled).',
  unknown: 'Something went wrong.',
};

/** An error from Converter Studio's API or from the extension's own checks. */
export class ConverterStudioError extends Error {
  /** One of EXTENSION_ERROR_CODES, or the API's code (`invalidApiKey`, `notEnoughCredits`…). */
  readonly code: string;
  readonly status: number | null;
  /** Seconds to wait before trying again, when the server said so (`Retry-After`). */
  readonly retryAfter: number | null;

  constructor(
    code: string,
    message?: string,
    options: { status?: number | null; retryAfter?: number | null; cause?: unknown } = {},
  ) {
    super(message ?? ERROR_TEXT[code as ExtensionErrorCode] ?? 'Something went wrong.');
    this.name = 'ConverterStudioError';
    this.code = code;
    this.status = options.status ?? null;
    this.retryAfter = options.retryAfter ?? null;
    if (options.cause !== undefined) (this as { cause?: unknown }).cause = options.cause;
  }
}

/** Any thrown value as a ConverterStudioError. */
export function asConverterStudioError(error: unknown): ConverterStudioError {
  if (error instanceof ConverterStudioError) return error;
  if (isAbort(error)) return new ConverterStudioError('canceled');
  const message = error instanceof Error ? error.message : String(error);
  return new ConverterStudioError('unknown', message, { cause: error });
}

/** An aborted request or stream (the user canceled). */
export function isAbort(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === 'AbortError' || (error as { code?: unknown }).code === 'ABORT_ERR')
  );
}

/** Codes after which the other files of a batch would fail the same way. */
export function stopsBatch(code: string): boolean {
  return (
    code === 'invalidApiKey' ||
    code === 'notEnoughCredits' ||
    code === 'dailyLimit' ||
    code === 'monthlyLimit' ||
    code === 'noApiKey' ||
    code === 'canceled'
  );
}
