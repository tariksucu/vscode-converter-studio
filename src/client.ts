import { ConverterStudioError } from './errors';

/**
 * A small client for Converter Studio's public REST API (https://converter.studio/developers):
 * the formats, the account, uploads (in parts when large), conversions and downloads. No
 * dependencies: it uses the `fetch` of the extension host's Node.
 *
 * The API key only goes to the API's own address. Upload and download links carry their own
 * one-time tokens, so the key is never sent with them, and it never appears in an error message.
 */

export const DEFAULT_API_URL = 'https://converter.studio/api';
/** One upload request carries at most this much when the API does not say (the CDN stops at 100 MB). */
export const DEFAULT_PART_BYTES = 95 * 1024 * 1024;
/** The longest a single status request waits on the server (the API allows 60 seconds). */
export const LONG_POLL_SECONDS = 50;
/** The longest file name the API takes. */
const MAX_NAME_LENGTH = 255;

export type ConversionStatus =
  | 'fetching'
  | 'waiting_for_upload'
  | 'measuring'
  | 'quoted'
  | 'queued'
  | 'processing'
  | 'done'
  | 'failed'
  | 'expired'
  | 'canceled';

/** A conversion as the API shows it (`GET /v1/conversions/:id`). */
export interface ConversionView {
  id: string;
  status: ConversionStatus;
  from: string | null;
  to: string | null;
  inputName: string | null;
  inputSize: number | null;
  credits: number | null;
  maxCredits: number | null;
  progress: number | null;
  outputName: string | null;
  outputSize: number | null;
  downloadUrl: string | null;
  expiresAt: string | null;
  error: { code: string; message: string; params?: Record<string, string | number> } | null;
}

/** A format of the API's catalogue (`GET /v1/formats`) and what it can become. */
export interface FormatInfo {
  id: string;
  name: string;
  category: string;
  /** File extensions without the dot, lower case (`tar.gz`, `jpg`, `jpeg`…). */
  extensions: string[];
  /** Target format ids, the most used first. */
  to: string[];
}

/** The account behind the API key (`GET /v1/account`), without its e-mail address. */
export interface AccountView {
  plan: string;
  credits: number;
  allowance: { used: number; limit: number; per: 'day' | 'month' } | null;
  renewsAt: string | null;
  maxFileBytes: number;
}

interface UploadSlot {
  id: string;
  uploadUrl: string;
  maxBytes: number;
  partBytes: number;
}

type UploadReceipt =
  | { id: string; status: 'ready'; file: { name: string; size: number; format: string | null } }
  | { id: string; status: 'partial'; received: number };

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Not needed for the formats. */
  apiKey?: string;
  /** `https://converter.studio/api`, or the address of a test server. */
  apiUrl?: string;
  /** The extension's version, for `X-Converter-Studio-Client` and the User-Agent. */
  version: string;
  /** The editor and its version (`VSCode/1.147.0`), added to the User-Agent. */
  host?: string;
  fetch?: FetchLike;
  /** How often a busy or unreachable API is tried again (default 3). */
  retries?: number;
  /** Waits between tries; replaced in tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const SETTLED: ReadonlySet<ConversionStatus> = new Set([
  'done',
  'failed',
  'expired',
  'canceled',
  'quoted',
]);
const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new ConverterStudioError('canceled'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ConverterStudioError('canceled'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** How long one request of an upload may take: two minutes, plus two seconds a megabyte. */
const partTimeout = (bytes: number) => 120_000 + Math.ceil(bytes / 1_000_000) * 2000;

/** A file name the API takes: at most 255 characters, keeping its extension. */
export function uploadName(name: string): string {
  // eslint-disable-next-line no-control-regex
  const trimmed = name.replace(/[\u0000-\u001f\u007f]/g, '').trim() || 'file';
  if (trimmed.length <= MAX_NAME_LENGTH) return trimmed;
  const dot = trimmed.lastIndexOf('.');
  const extension = dot > 0 && trimmed.length - dot <= 16 ? trimmed.slice(dot) : '';
  return trimmed.slice(0, MAX_NAME_LENGTH - extension.length) + extension;
}

function concat(chunks: Uint8Array[], length: number): Uint8Array {
  if (chunks.length === 1 && chunks[0]!.byteLength === length) return chunks[0]!;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Cuts a stream into parts of `partBytes` (the last one may be shorter). */
export async function* partsOf(
  stream: AsyncIterable<Uint8Array>,
  partBytes: number,
): AsyncGenerator<Uint8Array> {
  let chunks: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of stream) {
    let data = chunk;
    while (data.byteLength > 0) {
      const take = Math.min(partBytes - length, data.byteLength);
      chunks.push(data.subarray(0, take));
      length += take;
      data = data.subarray(take);
      if (length === partBytes) {
        yield concat(chunks, length);
        chunks = [];
        length = 0;
      }
    }
  }
  if (length > 0) yield concat(chunks, length);
}

/** A signal that fires when the caller's does or after `ms`. */
function withTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export class ConverterStudioClient {
  private readonly apiKey: string | undefined;
  readonly apiUrl: string;
  private readonly fetch: FetchLike;
  private readonly retries: number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly headers: Record<string, string>;

  constructor(options: ClientOptions) {
    this.apiKey = options.apiKey;
    this.apiUrl = (options.apiUrl?.trim() || DEFAULT_API_URL).replace(/\/+$/, '');
    this.fetch = options.fetch ?? ((input, init) => fetch(input, init));
    this.retries = options.retries ?? 3;
    this.sleep = options.sleep ?? defaultSleep;
    this.headers = {
      'User-Agent': `vscode-converter-studio/${options.version}${options.host ? ` ${options.host}` : ''}`,
      // Names this extension on its API calls (Converter Studio's statistics of its connectors).
      'X-Converter-Studio-Client': `vscode/${options.version}`,
    };
  }

  /** The formats Converter Studio reads and what each can become (no key needed). */
  async formats(signal?: AbortSignal): Promise<FormatInfo[]> {
    const body = await this.json<{ formats?: FormatInfo[] }>('GET', '/v1/formats', {
      auth: false,
      signal,
    });
    if (!Array.isArray(body.formats)) throw new ConverterStudioError('badResponse');
    return body.formats;
  }

  /** The account's plan and credits. */
  async account(signal?: AbortSignal): Promise<AccountView> {
    const body = await this.json<AccountView & { email?: string }>('GET', '/v1/account', {
      signal,
    });
    return {
      plan: body.plan,
      credits: body.credits,
      allowance: body.allowance ?? null,
      renewsAt: body.renewsAt ?? null,
      maxFileBytes: body.maxFileBytes,
    };
  }

  /**
   * Uploads a file's bytes: an upload slot (`POST /v1/uploads`, which checks the plan's size limit
   * before anything is sent), then the bytes in one request, or in parts of the slot's
   * `partBytes` with `Upload-Offset` for a larger file. Returns the upload's id.
   */
  async upload(input: {
    fileName: string;
    size: number;
    stream: AsyncIterable<Uint8Array>;
    signal?: AbortSignal;
    onProgress?: (sent: number) => void;
  }): Promise<string> {
    if (!(input.size > 0)) throw new ConverterStudioError('sourceEmpty');
    const slot = await this.json<UploadSlot>('POST', '/v1/uploads', {
      body: { fileName: uploadName(input.fileName), size: input.size },
      signal: input.signal,
    });
    const partBytes = slot.partBytes > 0 ? slot.partBytes : DEFAULT_PART_BYTES;
    const inParts = input.size > partBytes;
    let offset = 0;
    for await (const part of partsOf(input.stream, partBytes)) {
      const receipt = await this.sendPart(
        slot.uploadUrl,
        part,
        inParts ? offset : null,
        input.signal,
      );
      offset += part.byteLength;
      input.onProgress?.(offset);
      if (receipt.status === 'ready') {
        if (offset !== input.size) break;
        return slot.id;
      }
      if (receipt.received !== offset) break;
    }
    throw new ConverterStudioError(
      'uploadIncomplete',
      `Converter Studio received a different number of bytes than the file has (${input.size}).`,
    );
  }

  /**
   * Starts a conversion of an upload. The Idempotency-Key makes a request that is sent again
   * (after a lost answer) return the same conversion instead of starting a second one.
   */
  start(input: {
    uploadId: string;
    to: string;
    options?: Record<string, unknown>;
    maxCredits: number;
    idempotencyKey: string;
    signal?: AbortSignal;
  }): Promise<ConversionView> {
    return this.json<ConversionView>('POST', '/v1/conversions', {
      body: {
        uploadId: input.uploadId,
        to: input.to,
        ...(input.options && Object.keys(input.options).length ? { options: input.options } : {}),
        maxCredits: input.maxCredits,
      },
      headers: { 'Idempotency-Key': input.idempotencyKey },
      signal: input.signal,
    });
  }

  /** A conversion's status; with `waitSeconds`, waits on the server until it changes. */
  get(id: string, waitSeconds = 0, signal?: AbortSignal): Promise<ConversionView> {
    const query = waitSeconds > 0 ? `?wait=${Math.min(60, Math.ceil(waitSeconds))}` : '';
    return this.json<ConversionView>('GET', `/v1/conversions/${encodeURIComponent(id)}${query}`, {
      signal,
      timeoutMs: (waitSeconds + 30) * 1000,
    });
  }

  /** Goes ahead with a conversion that costs more than its `maxCredits` (status `quoted`). */
  confirm(id: string, signal?: AbortSignal): Promise<ConversionView> {
    return this.json<ConversionView>('POST', `/v1/conversions/${encodeURIComponent(id)}/confirm`, {
      signal,
    });
  }

  /**
   * Waits until a conversion is done, failed, expired, canceled or quoted, and returns it. Each
   * status request waits on the server until something changes, so a finished conversion is
   * seen at once and an unfinished one costs one request every 50 seconds.
   */
  async settle(
    view: ConversionView,
    options: {
      timeoutMs: number;
      signal?: AbortSignal;
      onUpdate?: (view: ConversionView) => void;
    },
  ): Promise<ConversionView> {
    const deadline = Date.now() + options.timeoutMs;
    let current = view;
    while (!SETTLED.has(current.status)) {
      const left = deadline - Date.now();
      if (left <= 0)
        throw new ConverterStudioError(
          'timeout',
          `The conversion did not finish in ${Math.round(options.timeoutMs / 60_000)} minutes. It goes on at Converter Studio as ${current.id}.`,
        );
      current = await this.get(
        current.id,
        Math.max(1, Math.min(LONG_POLL_SECONDS, Math.floor(left / 1000))),
        options.signal,
      );
      options.onUpdate?.(current);
    }
    return current;
  }

  /** The converted file (a response whose body streams it). The link carries its own token. */
  download(downloadUrl: string, signal?: AbortSignal): Promise<Response> {
    return this.send(downloadUrl, { method: 'GET' }, 'resultDownloadFailed', {
      signal,
      timeoutMs: 60 * 60_000,
    });
  }

  /**
   * Sends one request of an upload. A part is sent again after a lost connection, a rate limit or
   * a busy server: the API overwrites what arrived of it before.
   */
  private async sendPart(
    uploadUrl: string,
    bytes: Uint8Array,
    offset: number | null,
    signal: AbortSignal | undefined,
  ): Promise<UploadReceipt> {
    const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
    if (offset !== null) headers['Upload-Offset'] = String(offset);
    const response = await this.send(
      uploadUrl,
      { method: 'PUT', headers, body: bytes },
      'network',
      { signal, timeoutMs: partTimeout(bytes.byteLength) },
    );
    return (await response.json()) as UploadReceipt;
  }

  /** A request to the API; its JSON body, or a ConverterStudioError. */
  private async json<T>(
    method: string,
    path: string,
    options: {
      body?: unknown;
      headers?: Record<string, string>;
      auth?: boolean;
      signal?: AbortSignal;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const auth = options.auth ?? true;
    if (auth && !this.apiKey) throw new ConverterStudioError('noApiKey');
    const response = await this.send(
      `${this.apiUrl}${path}`,
      {
        method,
        headers: {
          Accept: 'application/json',
          ...(auth ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...options.headers,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      },
      'network',
      { signal: options.signal, timeoutMs: options.timeoutMs ?? 60_000 },
    );
    try {
      return (await response.json()) as T;
    } catch (cause) {
      throw new ConverterStudioError('badResponse', undefined, { status: response.status, cause });
    }
  }

  /** Sends a request, trying again while the API is busy or unreachable. */
  private async send(
    url: string,
    init: RequestInit,
    failure: string,
    options: { signal?: AbortSignal; timeoutMs: number },
  ): Promise<Response> {
    const headers = { ...this.headers, ...(init.headers as Record<string, string> | undefined) };
    for (let attempt = 0; ; attempt++) {
      if (options.signal?.aborted) throw new ConverterStudioError('canceled');
      let response: Response;
      try {
        response = await this.fetch(url, {
          ...init,
          headers,
          redirect: 'follow',
          signal: withTimeout(options.signal, options.timeoutMs),
        });
      } catch (cause) {
        if (options.signal?.aborted) throw new ConverterStudioError('canceled');
        if (attempt < this.retries) {
          await this.sleep(1000 * 2 ** attempt, options.signal);
          continue;
        }
        throw new ConverterStudioError(failure === 'network' ? 'network' : failure, undefined, {
          cause,
        });
      }
      if (response.ok) return response;
      const error = await readError(response);
      // Uploads waiting or left unconverted are counted over hours: trying again soon cannot help.
      const lasting = error.code === 'tooManyPending' || error.code === 'tooManyUnconverted';
      if (RETRY_STATUS.has(response.status) && attempt < this.retries && !lasting) {
        const wait = error.retryAfter !== null ? error.retryAfter * 1000 : 1000 * 2 ** attempt;
        await this.sleep(Math.min(wait, 30_000), options.signal);
        continue;
      }
      throw error;
    }
  }
}

/** The API's error (`{ error: { code, message } }`), or one made from the status. */
async function readError(response: Response): Promise<ConverterStudioError> {
  const header = response.headers.get('retry-after');
  const retryAfter = header && /^\d+$/.test(header) ? Number(header) : null;
  let code: string | null = null;
  let message: string | null = null;
  try {
    const body = (await response.json()) as { error?: { code?: unknown; message?: unknown } };
    if (typeof body.error?.code === 'string') code = body.error.code;
    if (typeof body.error?.message === 'string') message = body.error.message;
  } catch {
    // Not JSON (a proxy's error page): the status says enough.
  }
  if (!code) {
    if (response.status === 401) code = 'invalidApiKey';
    else if (response.status === 402) code = 'notEnoughCredits';
    else if (response.status === 404) code = 'notFound';
    else if (response.status === 413) code = 'fileTooLarge';
    else if (response.status === 429) code = 'tooManyRequests';
    else if (response.status >= 500) code = 'serverBusy';
    else code = 'badResponse';
  }
  return new ConverterStudioError(
    code,
    message ?? `Converter Studio answered ${response.status}.`,
    {
      status: response.status,
      retryAfter,
    },
  );
}
