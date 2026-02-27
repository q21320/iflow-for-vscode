import * as assert from 'assert';
import * as cp from 'child_process';
import * as path from 'path';

function runNodeScript(
  cwd: string,
  scriptPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = cp.spawn(process.execPath, [scriptPath], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

suite('ACP Real CLI Smoke', () => {
  test('runs scripts/iflow-sdk-edit-test.mjs with real iflow cli', async function () {
    if (process.env.IFLOW_REAL_CLI_TEST !== '1') {
      this.skip();
    }

    this.timeout(180_000);

    const rootDir = path.resolve(__dirname, '..', '..');
    const scriptPath = path.join(rootDir, 'scripts', 'iflow-sdk-edit-test.mjs');
    const result = await runNodeScript(rootDir, scriptPath, {
      ...process.env,
      IFLOW_ACP_PORT: process.env.IFLOW_ACP_PORT || '8123',
      IFLOW_ACP_STREAM: process.env.IFLOW_ACP_STREAM || '1',
      IFLOW_ACP_DUMP_ALL: process.env.IFLOW_ACP_DUMP_ALL || '0',
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.strictEqual(
      result.code,
      0,
      `real CLI smoke test failed (code=${String(result.code)})\n${output}`,
    );
    assert.match(output, /\[probe\] summary/);
    assert.match(output, /session\/update notifications:\s*\d+/);
  });
});
