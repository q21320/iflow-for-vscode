import * as fs from 'fs';
import * as path from 'path';
import { ActiveRunContext, FileSnapshot, isSubPath } from './types';

export class SnapshotManager {
  normalizeCandidatePath(activeRun: ActiveRunContext, candidate: string): string | null {
    if (!candidate) {
      return null;
    }

    const absolutePath = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(activeRun.cwd ?? '', candidate);

    if (!this.isAllowedPath(activeRun, absolutePath)) {
      return null;
    }

    return absolutePath;
  }

  isAllowedPath(activeRun: ActiveRunContext, absolutePath: string): boolean {
    return activeRun.allowedDirs.some((allowedDir) => isSubPath(allowedDir, absolutePath));
  }

  captureSnapshotIfNeeded(activeRun: ActiveRunContext, absolutePath: string): void {
    if (activeRun.snapshots.has(absolutePath)) {
      return;
    }

    const existedBefore = fs.existsSync(absolutePath);
    const beforeContent = existedBefore
      ? fs.readFileSync(absolutePath, 'utf-8')
      : '';
    const displayPath = this.getDisplayPath(activeRun, absolutePath);

    const snapshot: FileSnapshot = {
      absolutePath,
      displayPath,
      existedBefore,
      beforeContent,
    };

    activeRun.snapshots.set(absolutePath, snapshot);
  }

  getDisplayPath(activeRun: ActiveRunContext, absolutePath: string): string {
    const candidates: string[] = [];
    if (activeRun.cwd && isSubPath(activeRun.cwd, absolutePath)) {
      candidates.push(path.relative(activeRun.cwd, absolutePath));
    }

    for (const allowedDir of activeRun.allowedDirs) {
      if (isSubPath(allowedDir, absolutePath)) {
        candidates.push(path.relative(allowedDir, absolutePath));
      }
    }

    const filtered = candidates.filter(
      (entry) => Boolean(entry) && !entry.startsWith('..'),
    );
    if (filtered.length > 0) {
      filtered.sort((a, b) => a.length - b.length);
      return filtered[0];
    }

    return absolutePath;
  }
}
