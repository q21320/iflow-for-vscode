import * as fs from 'fs';
import * as path from 'path';

export class PathPolicy {
  private allowedDirs: string[] = [];
  private baseDir: string = process.cwd();

  setBaseDir(baseDir: string): void {
    this.baseDir = baseDir;
  }

  setAllowedDirs(candidates: string[]): void {
    const normalized = new Set<string>();
    for (const dir of candidates) {
      try {
        normalized.add(this.canonicalizePath(dir));
      } catch {
        normalized.add(path.resolve(dir));
      }
    }
    this.allowedDirs = [...normalized];
  }

  reset(): void {
    this.allowedDirs = [];
    this.baseDir = process.cwd();
  }

  ensureAllowedPath(rawPath: string): string {
    const absolute = path.isAbsolute(rawPath) ? rawPath : path.resolve(this.baseDir, rawPath);
    const canonical = this.canonicalizePath(absolute);

    if (this.allowedDirs.length === 0) {
      throw new Error('Access denied: no allowed directories configured');
    }

    const allowed = this.allowedDirs.some((dir) => this.isSubPath(dir, canonical));
    if (!allowed) {
      throw new Error(`Access denied: ${rawPath} is outside allowed directories`);
    }

    return canonical;
  }

  private toComparablePath(inputPath: string): string {
    return process.platform === 'win32' ? inputPath.toLowerCase() : inputPath;
  }

  private isSubPath(parent: string, child: string): boolean {
    const rel = path.relative(this.toComparablePath(parent), this.toComparablePath(child));
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  private findNearestExistingPath(inputPath: string): string {
    let current = path.resolve(inputPath);

    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) {
        throw new Error(`Path does not exist: ${inputPath}`);
      }
      current = parent;
    }

    return current;
  }

  private canonicalizePath(inputPath: string): string {
    const absolute = path.resolve(inputPath);

    if (fs.existsSync(absolute)) {
      return fs.realpathSync(absolute);
    }

    const nearestExisting = this.findNearestExistingPath(absolute);
    const realNearest = fs.realpathSync(nearestExisting);
    const suffix = path.relative(nearestExisting, absolute);
    return path.resolve(realNearest, suffix);
  }
}
