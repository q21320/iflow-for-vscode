import type { OutputBlock } from '../../src/protocol';

export type ToolBlock = Extract<OutputBlock, { type: 'tool' }>;

export const MAX_DIFF_LINES = 220;
export const MAX_COMMAND_LINES = 260;
export const COMMAND_TRUNCATE_LENGTH = 80;

export function getInputString(input: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const firstString = value.find((v) => typeof v === 'string' && v.trim()) as string | undefined;
      if (firstString) {
        return firstString.trim();
      }
    }
  }
  return null;
}

export function getInputNumber(input: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const n = Number(value);
      if (Number.isFinite(n)) {
        return n;
      }
    }
  }
  return null;
}

export function looksLikePatch(text: string): boolean {
  if (!text) {
    return false;
  }
  return text.includes('*** Begin Patch') ||
    text.includes('*** Update File:') ||
    text.includes('diff --git ') ||
    text.includes('@@ ');
}

export function getToolKind(block: ToolBlock): 'read' | 'write' | 'edit' | 'search' | 'command' | 'todo' | 'unknown' {
  const name = (block.name || '').toLowerCase();
  const input = block.input || {};

  if (name === 'todo_write') {
    return 'todo';
  }
  if (getInputString(input, ['command', 'cmd', 'script'])) {
    return 'command';
  }
  if (/bash|shell|terminal|exec|command|run/.test(name)) {
    return 'command';
  }
  if (/apply.?patch|edit|replace|update|modify|rewrite/.test(name) || looksLikePatch(block.output || '')) {
    return 'edit';
  }
  if (/write|create|save|new.?file/.test(name)) {
    return 'write';
  }
  if (/read|open|cat/.test(name)) {
    return 'read';
  }
  if (/grep|glob|search|find|list|ls|rg/.test(name)) {
    return 'search';
  }
  return 'unknown';
}

export function getToolLineRange(input: Record<string, unknown>): string {
  const lineStart = getInputNumber(input, ['line_start', 'lineStart', 'start_line', 'startLine']);
  const lineEnd = getInputNumber(input, ['line_end', 'lineEnd', 'end_line', 'endLine']);

  if (lineStart && lineEnd) {
    return ` (lines ${lineStart}-${lineEnd})`;
  }
  if (lineStart) {
    return ` (line ${lineStart})`;
  }
  return '';
}
