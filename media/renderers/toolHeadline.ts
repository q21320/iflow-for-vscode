import { getFileName, humanizeToolName, shortenPath } from '../fileUtils';
import {
  COMMAND_TRUNCATE_LENGTH,
  getInputString,
  getToolKind,
  getToolLineRange,
  type ToolBlock,
} from './toolTypes';

export function getToolHeadline(block: ToolBlock): string {
  const toolName = (block.name || '').toLowerCase();
  const input = block.input || {};
  const toolKind = getToolKind(block);

  if (toolKind === 'todo') {
    const todos = input.todos as Array<{ task?: string; content?: string; status?: string }> | undefined;
    if (Array.isArray(todos) && todos.length > 0) {
      const pending = todos.filter((t) => (t.status || 'pending') === 'pending').length;
      const inProgress = todos.filter((t) => t.status === 'in_progress').length;
      const completed = todos.filter((t) => t.status === 'completed').length;
      const parts: string[] = [];
      if (pending > 0) parts.push(`${pending} pending`);
      if (inProgress > 0) parts.push(`${inProgress} in progress`);
      if (completed > 0) parts.push(`${completed} completed`);
      return `Plan · ${parts.join(', ') || 'empty'}`;
    }
    return 'Plan';
  }

  if (toolKind === 'read' || toolName.includes('read')) {
    const path = getInputString(input, ['file_path', 'path', 'filePath', 'file', 'absolute_path']);
    if (path) {
      const lineRange = getToolLineRange(input);
      return `Read ${getFileName(path)}${lineRange}`;
    }
  }

  if (toolKind === 'write') {
    const path = getInputString(input, ['file_path', 'path', 'filePath', 'file', 'absolute_path']);
    if (path) {
      return `Write ${getFileName(path)}`;
    }
  }

  if (toolKind === 'edit') {
    const path = getInputString(input, ['file_path', 'path', 'filePath', 'file', 'absolute_path']);
    if (path) {
      return `Edit ${getFileName(path)}`;
    }
  }

  const label = (block.label || '').trim();
  if (label) {
    return label;
  }

  if (toolKind === 'read') {
    return 'Read';
  }

  if (toolKind === 'search' && toolName.includes('glob')) {
    const pattern = getInputString(input, ['pattern', 'glob']);
    return pattern ? `Glob pattern: "${pattern}"` : 'Glob';
  }

  if (toolKind === 'search' && toolName.includes('grep')) {
    const pattern = getInputString(input, ['pattern', 'query', 'search']);
    const scope = getInputString(input, ['path', 'cwd', 'directory', 'file_path']);
    if (pattern && scope) {
      return `Grep "${pattern}" (in ${shortenPath(scope)})`;
    }
    if (pattern) {
      return `Grep "${pattern}"`;
    }
    return 'Grep';
  }

  if (toolKind === 'write') {
    return 'Write File';
  }

  if (toolKind === 'edit') {
    return 'Edit File';
  }

  const command = getInputString(input, ['command', 'cmd']);
  if (command) {
    return `Run ${command.length > COMMAND_TRUNCATE_LENGTH ? `${command.slice(0, COMMAND_TRUNCATE_LENGTH - 3)}...` : command}`;
  }

  const path = getInputString(input, ['file_path', 'path', 'filePath', 'absolute_path']);
  if (path) {
    return `${humanizeToolName(block.name)} ${shortenPath(path)}`;
  }

  return humanizeToolName(block.name);
}
