import * as cp from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { unique } from "./shared/arrayUtils";
import {
  getVersionManagerDirs,
  collectBinaryFromVersionManagerDir,
  pushIfDefined,
} from "./cliDiscovery";

type Logger = (message: string) => void;

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
  const isWindows = process.platform === "win32";
  const nodeExe = isWindows ? "node.exe" : "node";
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

function inferNodePathFromScript(
  iflowScript: string | undefined,
  nodeExe: string,
): string | null {
  if (!iflowScript) {
    return null;
  }
  const normalized = path.normalize(iflowScript);
  const marker = `${path.sep}lib${path.sep}node_modules${path.sep}`;
  const markerIdx = normalized.lastIndexOf(marker);
  if (markerIdx > 0) {
    const prefix = normalized.slice(0, markerIdx);
    const nodePath = path.join(prefix, "bin", nodeExe);
    if (fs.existsSync(nodePath)) {
      return nodePath;
    }
  }
  return null;
}

function findNodePathWindows(log: Logger): Promise<string | null> {
  return new Promise((resolve) => {
    cp.exec("where node", { timeout: 5000 }, (error, stdout) => {
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

  pushIfDefined(
    candidates,
    nvmSymlink ? path.join(nvmSymlink, "node.exe") : undefined,
  );
  pushIfDefined(
    candidates,
    localAppData
      ? path.join(localAppData, "Volta", "bin", "node.exe")
      : undefined,
  );
  pushIfDefined(
    candidates,
    programFiles ? path.join(programFiles, "nodejs", "node.exe") : undefined,
  );
  pushIfDefined(
    candidates,
    userProfile
      ? path.join(userProfile, "AppData", "Local", "fnm", "node-versions")
      : undefined,
  );

  return [...new Set(candidates)].flatMap((candidate) => {
    if (candidate.toLowerCase().endsWith(".exe")) {
      return [candidate];
    }
    return collectNodeExeFromVersionRoot(candidate, "installation");
  });
}

function collectNodeExeFromVersionRoot(
  baseDir: string,
  ...nested: string[]
): string[] {
  try {
    if (!fs.existsSync(baseDir)) {
      return [];
    }
    return fs
      .readdirSync(baseDir)
      .sort((a, b) =>
        b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }),
      )
      .map((entry) => path.join(baseDir, entry, ...nested, "node.exe"))
      .filter((candidate) => fs.existsSync(candidate));
  } catch {
    return [];
  }
}

function findNodePathUnix(log: Logger): Promise<string | null> {
  return new Promise((resolve) => {
    cp.exec("which node", { timeout: 5000 }, (error, stdout) => {
      if (!error && stdout.trim()) {
        resolve(stdout.trim());
        return;
      }

      const shell = process.env.SHELL || "/bin/bash";
      cp.execFile(
        shell,
        ["-lc", "command -v node"],
        { timeout: 10000 },
        (err2, stdout2) => {
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
        },
      );
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

  pushIfDefined(candidates, nvmBin ? path.join(nvmBin, "node") : undefined);
  pushIfDefined(candidates, pnpmHome ? path.join(pnpmHome, "node") : undefined);
  pushIfDefined(
    candidates,
    voltaHome ? path.join(voltaHome, "bin", "node") : undefined,
  );
  pushIfDefined(
    candidates,
    npmPrefix ? path.join(npmPrefix, "bin", "node") : undefined,
  );

  for (const known of [
    "/usr/local/bin/node",
    "/opt/homebrew/bin/node",
    "/usr/bin/node",
    "/bin/node",
    path.join(home, ".volta", "bin", "node"),
  ]) {
    candidates.push(known);
  }

  candidates.push(
    ...getVersionManagerDirs(home).flatMap(({ baseDir, nestedBinSegments }) =>
      collectBinaryFromVersionManagerDir(baseDir, "node", ...nestedBinSegments),
    ),
  );

  return unique(candidates);
}
