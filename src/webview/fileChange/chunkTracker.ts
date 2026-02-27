import { StreamChunk } from '../../protocol';
import {
  ActiveRunContext,
  isMutatingTool,
  normalizeMaybeArrayToStrings,
  parsePatchPaths,
  unique,
} from './types';
import { SnapshotManager } from './snapshotManager';

export class FileChangeChunkTracker {
  constructor(private readonly snapshotManager: SnapshotManager) {}

  onChunk(activeRun: ActiveRunContext, chunk: StreamChunk): void {
    if (chunk.chunkType === 'tool_start') {
      this.handleToolStart(activeRun, chunk);
      return;
    }

    if (chunk.chunkType === 'tool_end') {
      this.handleToolEnd(activeRun, chunk);
    }
  }

  handleToolStart(
    activeRun: ActiveRunContext,
    chunk: Extract<StreamChunk, { chunkType: 'tool_start' }>,
  ): void {
    if (!isMutatingTool(chunk.name)) {
      return;
    }

    const candidates = this.extractPathsFromToolInput(chunk.input);
    const normalized = unique(
      candidates
        .map((entry) => this.snapshotManager.normalizeCandidatePath(activeRun, entry))
        .filter((entry): entry is string => Boolean(entry)),
    );

    if (normalized.length === 0) {
      return;
    }

    for (const filePath of normalized) {
      this.snapshotManager.captureSnapshotIfNeeded(activeRun, filePath);
    }

    if (chunk.toolCallId) {
      activeRun.toolCallPaths.set(chunk.toolCallId, normalized);
      return;
    }

    activeRun.anonymousToolPaths.push(normalized);
  }

  handleToolEnd(
    activeRun: ActiveRunContext,
    chunk: Extract<StreamChunk, { chunkType: 'tool_end' }>,
  ): void {
    if (chunk.status !== 'completed') {
      return;
    }

    let filePaths: string[] | undefined;
    if (chunk.toolCallId) {
      filePaths = activeRun.toolCallPaths.get(chunk.toolCallId);
      activeRun.toolCallPaths.delete(chunk.toolCallId);
    } else {
      filePaths = activeRun.anonymousToolPaths.pop();
    }

    if (!filePaths) {
      return;
    }

    for (const filePath of filePaths) {
      activeRun.changedPaths.add(filePath);
    }
  }

  extractPathsFromToolInput(input: Record<string, unknown>): string[] {
    const paths: string[] = [];
    const directPathKeys = [
      'file_path',
      'filePath',
      'path',
      'absolute_path',
      'file',
      'target_file',
    ];

    for (const key of directPathKeys) {
      paths.push(...normalizeMaybeArrayToStrings(input[key]));
    }

    for (const value of Object.values(input)) {
      if (typeof value === 'string') {
        paths.push(...parsePatchPaths(value));
      }
    }

    return unique(paths);
  }
}
