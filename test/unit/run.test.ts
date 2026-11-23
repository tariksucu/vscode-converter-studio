import * as assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConverterStudioError } from '../../src/errors';
import { runTool, toolMessage } from '../../src/run';

/** Node itself stands in for a tool: `node -e <script> <args…>`. */
const node = process.execPath;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('runTool', () => {
  let dir: string;
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'cs-run-test-'))));
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('passes each argument as it is, with no shell in between', async () => {
    const tricky = ['a b', '$(echo no)', '"quoted"', ';rm -rf /', '*'];
    const result = await runTool(
      node,
      ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', ...tricky],
      { timeoutMs: 10_000 },
    );
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), tricky);
  });

  it('returns the exit code and the error output', async () => {
    const result = await runTool(node, ['-e', 'console.error("broken file"); process.exit(3)'], {
      timeoutMs: 10_000,
    });
    assert.equal(result.code, 3);
    assert.match(result.stderr, /broken file/);
  });

  it('stops a tool that takes too long, with the programs it started', async () => {
    const pidFile = join(dir, 'child.pid');
    const script = `
      const { spawn } = require('node:child_process');
      const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
      setTimeout(() => {}, 60000);`;
    const started = Date.now();
    await assert.rejects(
      runTool(node, ['-e', script], { timeoutMs: 800 }),
      (error: ConverterStudioError) => error.code === 'toolTimeout',
    );
    assert.ok(Date.now() - started < 8000);
    if (process.platform !== 'win32') {
      const pid = Number(readFileSync(pidFile, 'utf8'));
      for (let i = 0; i < 20 && alive(pid); i++) await wait(100);
      assert.ok(!alive(pid), 'the program the tool started is stopped too');
    }
  });

  it('stops when canceled', async () => {
    const controller = new AbortController();
    const running = runTool(node, ['-e', 'setTimeout(() => {}, 60000)'], {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(running, (error: ConverterStudioError) => error.code === 'canceled');
  });

  it('does not start when already canceled', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      runTool(node, ['-e', ''], { timeoutMs: 1000, signal: controller.signal }),
      (error: ConverterStudioError) => error.code === 'canceled',
    );
  });

  it('says when a tool cannot be started', async () => {
    await assert.rejects(
      runTool(join(dir, 'no-such-tool'), [], { timeoutMs: 1000 }),
      (error: ConverterStudioError) => error.code === 'toolMissing',
    );
  });

  it('reports output as it comes (FFmpeg’s progress)', async () => {
    const seen: string[] = [];
    await runTool(node, ['-e', 'console.log("out_time_us=500000"); console.log("progress=end")'], {
      timeoutMs: 10_000,
      onStdout: (text) => seen.push(text),
    });
    assert.match(seen.join(''), /out_time_us=500000/);
  });
});

describe('toolMessage', () => {
  it('keeps the last lines that say something, not progress counters', () => {
    const message = toolMessage({
      stdout: 'frame=10\nout_time_us=1000\nprogress=continue\n',
      stderr:
        'ffmpeg version 6.1\n[mov] moov atom not found\nfile:/w/a.mp4: Invalid data found when processing input\n',
    });
    assert.equal(
      message,
      'ffmpeg version 6.1 [mov] moov atom not found file:/w/a.mp4: Invalid data found when processing input',
    );
  });

  it('cuts a long message', () => {
    const message = toolMessage({ stdout: '', stderr: 'x'.repeat(2000) });
    assert.ok(message.length <= 401 && message.startsWith('…'));
  });
});
