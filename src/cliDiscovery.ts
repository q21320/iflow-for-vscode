import * as cp from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type Logger = (message: string) => void;

// ── Cross-platform iFlow CLI discovery ────────────────────────────

/**
 * Find iFlow CLI path across platforms.
 * Unix: tries `which iflow`, then falls back to a login shell to pick up nvm/fnm.
 * Windows: tries `where iflow`, then checks common npm global paths.
 */
export async function findIFlowPathCrossPlatform(log: Logger): Promise<string | null> {
  if (process.platform === 'win32') {
    return findIFlowPathWindows(log);
  }
  return findIFlowPathUnix(log);
}

function findIFlowPathWindows(log: Logger): Promise<string | null> {
  return new Promise((resolve) => {
    cp.exec('where iflow 2>NUL & where iflow.ps1 2>NUL & where iflow.cmd 2>NUL', { timeout: 5000 }, (error, stdout) => {
      const lines = (stdout || '').trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      if (lines.length > 0) {
        // Prefer .ps1 > .cmd > others (PowerShell wrappers are most reliable on modern Windows)
        const ps1 = lines.find(l => l.toLowerCase().endsWith('.ps1'));
        const cmd = lines.find(l => l.toLowerCase().endsWith('.cmd'));
        const picked = ps1 || cmd || lines[0];
        log(`[Windows discovery] 'where' returned ${lines.length} result(s): ${lines.join(', ')}`);
        log(`[Windows discovery] picked: ${picked}`);
        resolve(picked);
        return;
      }
      // Fallback: check common Windows npm global location
      const appData = process.env.APPDATA;
      if (appData) {
        for (const ext of ['.ps1', '.cmd', '']) {
          const candidate = path.join(appData, 'npm', `iflow${ext}`);
          if (fs.existsSync(candidate)) {
            log(`[Windows discovery] fallback found: ${candidate}`);
            resolve(candidate);
            return;
          }
        }
      }
      for (const candidate of collectWindowsIFlowCandidates()) {
        if (fs.existsSync(candidate)) {
          log(`[Windows discovery] fallback found: ${candidate}`);
          resolve(candidate);
          return;
        }
      }
      log('[Windows discovery] iflow CLI not found via "where" or APPDATA fallback');
      resolve(null);
    });
  });
}

function collectWindowsIFlowCandidates(): string[] {
  const appData = process.env.APPDATA;
  const localAppData = process.env.LOCALAPPDATA;
  const nvmSymlink = process.env.NVM_SYMLINK;
  const userProfile = process.env.USERPROFILE;
  const programFiles = process.env.ProgramFiles;

  const candidates: string[] = [];
  const pushIfDefined = (value: string | undefined): void => {
    if (value) {
      candidates.push(value);
    }
  };

  for (const ext of ['.ps1', '.cmd', '']) {
    pushIfDefined(appData ? path.join(appData, 'npm', `iflow${ext}`) : undefined);
    pushIfDefined(userProfile ? path.join(userProfile, 'AppData', 'Roaming', 'npm', `iflow${ext}`) : undefined);
    pushIfDefined(localAppData ? path.join(localAppData, 'Volta', 'bin', `iflow${ext}`) : undefined);
    pushIfDefined(nvmSymlink ? path.join(nvmSymlink, `iflow${ext}`) : undefined);
    pushIfDefined(programFiles ? path.join(programFiles, 'nodejs', `iflow${ext}`) : undefined);
  }

  return [...new Set(candidates)];
}

function findIFlowPathUnix(log: Logger): Promise<string | null> {
  return new Promise((resolve) => {
    // First try: direct 'which' with inherited PATH (works when launched from terminal)
    cp.exec('which iflow', { timeout: 5000 }, (error, stdout) => {
      if (!error && stdout.trim()) {
        resolve(stdout.trim());
        return;
      }
      // Second try: login shell to pick up nvm/fnm/volta initialization
      const shell = process.env.SHELL || '/bin/bash';
      cp.execFile(shell, ['-lc', 'command -v iflow'], { timeout: 10000 }, (err2, stdout2) => {
        if (!err2 && stdout2.trim()) {
          resolve(stdout2.trim());
        } else {
          const fallback = findIFlowPathUnixFromKnownLocations();
          if (fallback) {
            log(`[Unix discovery] fallback found at known location: ${fallback}`);
            resolve(fallback);
            return;
          }
          resolve(null);
        }
      });
    });
  });
}

function findIFlowPathUnixFromKnownLocations(): string | null {
  for (const candidate of collectUnixIFlowCandidates()) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function collectUnixIFlowCandidates(): string[] {
  const home = process.env.HOME || os.homedir();
  const nvmBin = process.env.NVM_BIN;
  const pnpmHome = process.env.PNPM_HOME;
  const voltaHome = process.env.VOLTA_HOME;
  const npmPrefix = process.env.npm_config_prefix;

  const candidates: string[] = [];
  const pushIfDefined = (value: string | undefined): void => {
    if (value) {
      candidates.push(value);
    }
  };

  pushIfDefined(nvmBin ? path.join(nvmBin, 'iflow') : undefined);
  pushIfDefined(pnpmHome ? path.join(pnpmHome, 'iflow') : undefined);
  pushIfDefined(voltaHome ? path.join(voltaHome, 'bin', 'iflow') : undefined);
  pushIfDefined(npmPrefix ? path.join(npmPrefix, 'bin', 'iflow') : undefined);

  for (const known of [
    '/usr/local/bin/iflow',
    '/opt/homebrew/bin/iflow',
    '/usr/bin/iflow',
    '/bin/iflow',
    path.join(home, '.local', 'bin', 'iflow'),
    path.join(home, '.npm-global', 'bin', 'iflow'),
    path.join(home, '.volta', 'bin', 'iflow'),
    path.join(home, '.yarn', 'bin', 'iflow'),
    path.join(home, '.config', 'yarn', 'global', 'node_modules', '.bin', 'iflow'),
    path.join(home, '.local', 'share', 'pnpm', 'iflow'),
    path.join(home, 'Library', 'pnpm', 'iflow'),
  ]) {
    candidates.push(known);
  }

  candidates.push(
    ...collectIfloFromVersionManagerDirs(path.join(home, '.nvm', 'versions', 'node'), 'bin'),
    ...collectIfloFromVersionManagerDirs(path.join(home, '.fnm', 'node-versions'), 'installation', 'bin'),
    ...collectIfloFromVersionManagerDirs(path.join(home, '.asdf', 'installs', 'nodejs'), 'bin'),
    ...collectIfloFromVersionManagerDirs(path.join(home, '.local', 'share', 'mise', 'installs', 'node'), 'bin'),
  );

  return [...new Set(candidates)];
}

function collectIfloFromVersionManagerDirs(baseDir: string, ...nestedBinSegments: string[]): string[] {
  try {
    if (!fs.existsSync(baseDir)) {
      return [];
    }
    return fs.readdirSync(baseDir)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
      .map((entry) => path.join(baseDir, entry, ...nestedBinSegments, 'iflow'))
      .filter((candidate) => fs.existsSync(candidate));
  } catch {
    return [];
  }
}

// ── Cross-platform script resolution ──────────────────────────────

/**
 * Resolve the actual JavaScript entry point from an iflow executable path.
 * Uses fs.realpathSync (cross-platform) instead of `readlink -f`.
 * On Windows, parses .cmd wrapper to extract the JS path.
 */
export function resolveIFlowScriptCrossPlatform(iflowPath: string, log: Logger): string | null {
  const lower = iflowPath.toLowerCase();
  const dir = path.dirname(iflowPath);
  const isWrapperInput = lower.endsWith('.ps1') || lower.endsWith('.cmd');

  // Try .ps1 PowerShell wrapper first.
  const ps1Path = lower.endsWith('.ps1') ? iflowPath : null;
  const ps1Sibling = !ps1Path ? path.join(dir, 'iflow.ps1') : null;
  const ps1File = ps1Path || (ps1Sibling && fs.existsSync(ps1Sibling) ? ps1Sibling : null);
  if (ps1File) {
    const result = parsePs1Wrapper(ps1File, log);
    if (result) {
      log(`[script resolve] extracted JS from .ps1: ${result}`);
      return result;
    }
  }

  // Try .cmd batch wrapper.
  const cmdPath = lower.endsWith('.cmd') ? iflowPath : null;
  const cmdSibling = !cmdPath ? path.join(dir, 'iflow.cmd') : null;
  const cmdFile = cmdPath || (cmdSibling && fs.existsSync(cmdSibling) ? cmdSibling : null);
  if (cmdFile) {
    const result = parseCmdWrapper(cmdFile, log);
    if (result) {
      log(`[script resolve] extracted JS from .cmd: ${result}`);
      return result;
    }
  }

  if (isWrapperInput) {
    log(`[script resolve] wrapper parsing failed: ${iflowPath}`);
    return null;
  }

  // Unix or fallback: resolve symlinks via Node.js native API
  try {
    const resolved = fs.realpathSync(iflowPath);
    log(`[script resolve] realpathSync: ${iflowPath} -> ${resolved}`);
    return resolved;
  } catch {
    log(`[script resolve] realpathSync failed for ${iflowPath}, using original path`);
    return iflowPath;
  }
}

/** Parse a Windows .cmd batch wrapper to extract the JS entry point. */
function parseCmdWrapper(cmdPath: string, log: Logger): string | null {
  try {
    const content = fs.readFileSync(cmdPath, 'utf-8');
    const match = content.match(/"([^"]*\.js)"/);
    if (match) {
      const dir = path.dirname(cmdPath);
      const jsPathRaw = match[1]
        .replace(/%~dp0\\/gi, dir + path.sep)
        .replace(/%~dp0/gi, dir + path.sep)
        .replace(/%dp0%\\/gi, dir + path.sep)
        .replace(/%dp0%/gi, dir + path.sep);

      const jsPath = path.normalize(
        jsPathRaw
          .replace(/\\/g, path.sep)
          .replace(/\//g, path.sep),
      );
      if (fs.existsSync(jsPath)) {
        return jsPath;
      }
      log(`[.cmd parse] JS path extracted but does not exist: ${jsPath}`);
    }
  } catch {
    log(`[.cmd parse] failed to read: ${cmdPath}`);
  }
  return null;
}

/** Parse a Windows .ps1 PowerShell wrapper to extract the JS entry point. */
function parsePs1Wrapper(ps1Path: string, log: Logger): string | null {
  try {
    const content = fs.readFileSync(ps1Path, 'utf-8');
    // Match patterns like: "$basedir/node_modules/@iflow-ai/iflow-cli/bundle/entry.js"
    // Use a more specific regex that directly matches node_modules path, ignoring $exe variable
    // Limit path length to 200 chars to avoid matching invalid content
    const match = content.match(/\$basedir[/\\](node_modules[/\\][^"']{0,200}?\.js)/);
    if (match) {
      const dir = path.dirname(ps1Path);
      const jsPath = path.join(dir, match[1].replace(/\//g, path.sep));
      if (fs.existsSync(jsPath)) {
        return jsPath;
      }
      log(`[.ps1 parse] JS path extracted but does not exist: ${jsPath}`);
    } else {
      // Fallback: try the original pattern for compatibility
      const fallbackMatch = content.match(/"\$basedir[/\\](.*?\.js)"/);
      if (fallbackMatch) {
        const dir = path.dirname(ps1Path);
        const jsPath = path.join(dir, fallbackMatch[1].replace(/\//g, path.sep));
        // Filter out paths containing variables like $exe
        if (!jsPath.includes('$') && fs.existsSync(jsPath)) {
          return jsPath;
        }
      }
    }
  } catch (err) {
    log(`[.ps1 parse] failed to read ${ps1Path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return null;
}

// ── Node.js path derivation ───────────────────────────────────────

/**
 * Derive the Node.js binary path from the iflow CLI location.
 * Uses the ORIGINAL (pre-realpath) iflow path because nvm places both
 * `node` and `iflow` symlinks in the same bin/ directory.
 */
export async function deriveNodePathFromIFlow(
  iflowPath: string,
  log: Logger,
  iflowScript?: string,
): Promise<string | null> {
  const isWindows = process.platform === 'win32';
  const nodeExe = isWindows ? 'node.exe' : 'node';
  const binDir = path.dirname(iflowPath);
  const candidatePath = path.join(binDir, nodeExe);

  if (fs.existsSync(candidatePath)) {
    log(`Auto-detected node at: ${candidatePath}`);
    return candidatePath;
  }

  const inferredFromScript = inferNodePathFromScript(iflowScript, nodeExe);
  if (inferredFromScript) {
    log(`Auto-detected node from iFlow script location: ${inferredFromScript}`);
    return inferredFromScript;
  }

  // Windows fallback: iflow.cmd may be in %APPDATA%\npm while node.exe is elsewhere
  if (isWindows) {
    return findNodePathWindows(log);
  }

  const unixFallback = await findNodePathUnix(log);
  if (unixFallback) {
    return unixFallback;
  }

  log(`Node not found alongside iflow at ${binDir}`);
  return null;
}

function inferNodePathFromScript(iflowScript: string | undefined, nodeExe: string): string | null {
  if (!iflowScript) {
    return null;
  }
  const normalized = path.normalize(iflowScript);
  const marker = `${path.sep}lib${path.sep}node_modules${path.sep}`;
  const markerIdx = normalized.lastIndexOf(marker);
  if (markerIdx > 0) {
    const prefix = normalized.slice(0, markerIdx);
    const nodePath = path.join(prefix, 'bin', nodeExe);
    if (fs.existsSync(nodePath)) {
      return nodePath;
    }
  }
  return null;
}

function findNodePathWindows(log: Logger): Promise<string | null> {
  return new Promise((resolve) => {
    cp.exec('where node', { timeout: 5000 }, (error, stdout) => {
      if (!error && stdout.trim()) {
        resolve(stdout.trim().split(/\r?\n/)[0]);
      } else {
        const candidates = collectWindowsNodeCandidates();
        for (const candidate of candidates) {
          if (fs.existsSync(candidate)) {
            log(`[Windows node discovery] fallback found: ${candidate}`);
            resolve(candidate);
            return;
          }
        }
        resolve(null);
      }
    });
  });
}

function collectWindowsNodeCandidates(): string[] {
  const localAppData = process.env.LOCALAPPDATA;
  const nvmSymlink = process.env.NVM_SYMLINK;
  const programFiles = process.env.ProgramFiles;
  const userProfile = process.env.USERPROFILE;

  const candidates: string[] = [];
  const pushIfDefined = (value: string | undefined): void => {
    if (value) {
      candidates.push(value);
    }
  };

  pushIfDefined(nvmSymlink ? path.join(nvmSymlink, 'node.exe') : undefined);
  pushIfDefined(localAppData ? path.join(localAppData, 'Volta', 'bin', 'node.exe') : undefined);
  pushIfDefined(programFiles ? path.join(programFiles, 'nodejs', 'node.exe') : undefined);
  pushIfDefined(userProfile ? path.join(userProfile, 'AppData', 'Local', 'fnm', 'node-versions') : undefined);

  return [...new Set(candidates)]
    .flatMap((candidate) => {
      if (candidate.toLowerCase().endsWith('.exe')) {
        return [candidate];
      }
      return collectNodeExeFromVersionRoot(candidate, 'installation');
    });
}

function collectNodeExeFromVersionRoot(baseDir: string, ...nested: string[]): string[] {
  try {
    if (!fs.existsSync(baseDir)) {
      return [];
    }
    return fs.readdirSync(baseDir)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }))
      .map((entry) => path.join(baseDir, entry, ...nested, 'node.exe'))
      .filter((candidate) => fs.existsSync(candidate));
  } catch {
    return [];
  }
}

function findNodePathUnix(log: Logger): Promise<string | null> {
  return new Promise((resolve) => {
    cp.exec('which node', { timeout: 5000 }, (error, stdout) => {
      if (!error && stdout.trim()) {
        resolve(stdout.trim());
        return;
      }

      const shell = process.env.SHELL || '/bin/bash';
      cp.execFile(shell, ['-lc', 'command -v node'], { timeout: 10000 }, (err2, stdout2) => {
        if (!err2 && stdout2.trim()) {
          resolve(stdout2.trim());
          return;
        }

        for (const candidate of collectUnixNodeCandidates()) {
          if (fs.existsSync(candidate)) {
            log(`[Unix node discovery] fallback found: ${candidate}`);
            resolve(candidate);
            return;
          }
        }
        resolve(null);
      });
    });
  });
}

function collectUnixNodeCandidates(): string[] {
  const home = process.env.HOME || os.homedir();
  const nvmBin = process.env.NVM_BIN;
  const pnpmHome = process.env.PNPM_HOME;
  const voltaHome = process.env.VOLTA_HOME;
  const npmPrefix = process.env.npm_config_prefix;

  const candidates: string[] = [];
  const pushIfDefined = (value: string | undefined): void => {
    if (value) {
      candidates.push(value);
    }
  };

  pushIfDefined(nvmBin ? path.join(nvmBin, 'node') : undefined);
  pushIfDefined(pnpmHome ? path.join(pnpmHome, 'node') : undefined);
  pushIfDefined(voltaHome ? path.join(voltaHome, 'bin', 'node') : undefined);
  pushIfDefined(npmPrefix ? path.join(npmPrefix, 'bin', 'node') : undefined);

  for (const known of [
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/bin/node',
    '/bin/node',
    path.join(home, '.volta', 'bin', 'node'),
  ]) {
    candidates.push(known);
  }

  candidates.push(
    ...collectIfloFromVersionManagerDirs(path.join(home, '.nvm', 'versions', 'node'), 'bin')
      .map((iflowPath) => path.join(path.dirname(iflowPath), 'node')),
    ...collectIfloFromVersionManagerDirs(path.join(home, '.fnm', 'node-versions'), 'installation', 'bin')
      .map((iflowPath) => path.join(path.dirname(iflowPath), 'node')),
    ...collectIfloFromVersionManagerDirs(path.join(home, '.asdf', 'installs', 'nodejs'), 'bin')
      .map((iflowPath) => path.join(path.dirname(iflowPath), 'node')),
    ...collectIfloFromVersionManagerDirs(path.join(home, '.local', 'share', 'mise', 'installs', 'node'), 'bin')
      .map((iflowPath) => path.join(path.dirname(iflowPath), 'node')),
  );

  return [...new Set(candidates)];
}
