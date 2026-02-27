#!/usr/bin/env node
import { spawn } from 'node:child_process';

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const args = ['run', '-s', 'test:unit', '--', '--grep', 'ACP Real CLI Smoke'];

const child = spawn(npmBin, args, {
  stdio: 'inherit',
  env: {
    ...process.env,
    IFLOW_REAL_CLI_TEST: '1',
    IFLOW_ACP_STREAM: process.env.IFLOW_ACP_STREAM || '1',
    IFLOW_ACP_DUMP_ALL: process.env.IFLOW_ACP_DUMP_ALL || '0',
  },
});

child.on('exit', (code) => {
  process.exit(code ?? 1);
});
