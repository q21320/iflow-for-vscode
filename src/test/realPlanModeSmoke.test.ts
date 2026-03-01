import * as assert from "assert";
import * as path from "path";
import { runNodeScript } from "./realCliTestHelper";

suite("ACP Real CLI Plan Mode Smoke", () => {
  test("runs scripts/plan-mode-e2e-test.mjs with real iflow cli", async function () {
    if (process.env.IFLOW_REAL_CLI_TEST !== "1") {
      this.skip();
    }

    this.timeout(240_000);

    const rootDir = path.resolve(__dirname, "..", "..");
    const scriptPath = path.join(
      rootDir,
      "scripts",
      "plan-mode-e2e-test.mjs",
    );
    const result = await runNodeScript(rootDir, scriptPath, {
      ...process.env,
      IFLOW_ACP_PORT: process.env.IFLOW_ACP_PORT || "8124",
      IFLOW_ACP_PHASE_TIMEOUT_MS:
        process.env.IFLOW_ACP_PHASE_TIMEOUT_MS || "60000",
      IFLOW_ACP_DUMP_ALL: process.env.IFLOW_ACP_DUMP_ALL || "0",
    });

    const output = `${result.stdout}\n${result.stderr}`;
    assert.strictEqual(
      result.code,
      0,
      `plan mode E2E test failed (code=${String(result.code)})\n${output}`,
    );
    assert.match(output, /\[plan-e2e\] summary/);
    assert.match(output, /session\/update count/);
  });
});
