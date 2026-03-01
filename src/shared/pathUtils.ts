import * as path from "path";

export function normalizePathForComparison(inputPath: string): string {
  return process.platform === "win32" ? inputPath.toLowerCase() : inputPath;
}

export function isSubPath(parentPath: string, childPath: string): boolean {
  const parent = normalizePathForComparison(parentPath);
  const child = normalizePathForComparison(childPath);
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}
