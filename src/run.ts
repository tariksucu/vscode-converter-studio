import { spawn } from 'node:child_process';
import { ConverterStudioError } from './errors';

/**
 * Runs a tool: an executable and an array of arguments (never through a shell), with a time
 * limit and a cancel signal. On either, the tool and the programs it started are stopped.
 */

export interface RunOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Each piece of standard output as it comes (FFmpeg's progress). */
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface RunResult {
  code: number | null;
  /** The last few kilobytes of each stream. */
  stdout: string;
  stderr: string;
}

export type Runner = (
  file: string,
  args: readonly string[],
  options: RunOptions,
) => Promise<RunResult>;

const KEEP = 16 * 1024;
const keepTail = (text: string) => (text.length > KEEP ? text.slice(-KEEP) : text);

/** Stops a process and its children: its process group on Linux and macOS, its tree on Windows. */
function stop(pid: number | undefined, force: boolean) {
  if (!pid) return;
  try {
    if (process.platform === 'win32')
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM');
  } catch {
    // Already gone.
  }
}

/** The tools running now, stopped with the extension (the editor closing). */
const running = new Set<number>();

/** Stops every tool still running (and the programs they started). */
export function stopAll(): void {
  for (const pid of running) stop(pid, true);
  running.clear();
}

export const runTool: Runner = (file, args, options) =>
  new Promise<RunResult>((resolve, reject) => {
    if (options.signal?.aborted) return reject(new ConverterStudioError('canceled'));
    let stdout = '';
    let stderr = '';
    let ended: 'timeout' | 'canceled' | null = null;
    const child = spawn(file, [...args], {
      cwd: options.cwd,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      // Its own process group, so it can be stopped with the programs it starts (LibreOffice).
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (child.pid) running.add(child.pid);
    let killTimer: NodeJS.Timeout | undefined;
    const end = (why: 'timeout' | 'canceled') => {
      if (ended) return;
      ended = why;
      stop(child.pid, false);
      killTimer = setTimeout(() => stop(child.pid, true), 3000);
    };
    const timer = setTimeout(() => end('timeout'), options.timeoutMs);
    const onAbort = () => end('canceled');
    options.signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (text: string) => {
      stdout = keepTail(stdout + text);
      options.onStdout?.(text);
    });
    child.stderr.on('data', (text: string) => {
      stderr = keepTail(stderr + text);
      options.onStderr?.(text);
    });
    const finish = () => {
      if (child.pid) running.delete(child.pid);
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (error: NodeJS.ErrnoException) => {
      finish();
      reject(
        new ConverterStudioError(
          'toolMissing',
          `${file} could not be started: ${error.code === 'ENOENT' ? 'it is not there any more' : error.message}.`,
          { cause: error },
        ),
      );
    });
    child.on('close', (code) => {
      finish();
      if (ended === 'canceled') return reject(new ConverterStudioError('canceled'));
      if (ended === 'timeout')
        return reject(
          new ConverterStudioError(
            'toolTimeout',
            `The conversion did not finish in ${Math.round(options.timeoutMs / 60_000) || 1} minutes and was stopped (converterStudio.local.timeoutMinutes).`,
          ),
        );
      resolve({ code, stdout, stderr });
    });
  });

/** The most useful line of a tool's error output, for a message (the last non-empty lines). */
export function toolMessage(result: Pick<RunResult, 'stdout' | 'stderr'>): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    // FFmpeg's progress lines (`frame=12`, `progress=end`) say nothing about an error.
    .filter((line) => line && !/^[a-z_]+=\S*$/.test(line));
  const last = lines.slice(-3).join(' ');
  return last.length > 400 ? `…${last.slice(-400)}` : last;
}
