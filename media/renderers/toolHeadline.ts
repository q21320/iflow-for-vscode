import { getFileName, humanizeToolName, shortenPath } from '../fileUtils';
import {
  COMMAND_TRUNCATE_LENGTH,
  getInputString,
  getToolKind,
  getToolLineRange,
  type ToolBlock,
} from './toolTypes';

const PATH_KEYS = ['file_path', 'path', 'filePath', 'file', 'absolute_path'] as const;

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
      if (pending > 0) parts.push(`${pending} 待办`);
      if (inProgress > 0) parts.push(`${inProgress} 进行中`);
      if (completed > 0) parts.push(`${completed} 已完成`);
      return `计划 · ${parts.join(', ') || '空'}`;
    }
    return '计划';
  }

  if (toolKind === 'read' || toolName.includes('read')) {
    const path = getInputString(input, [...PATH_KEYS]);
    if (path) {
      const lineRange = getToolLineRange(input);
      return `读取 ${getFileName(path)}${lineRange}`;
    }
    const label = (block.label || '').trim();
    return label || '读取';
  }

  if (toolKind === 'write') {
    const path = getInputString(input, [...PATH_KEYS]);
    if (path) {
      return `写入 ${getFileName(path)}`;
    }
    const label = (block.label || '').trim();
    return label || '写入';
  }

  if (toolKind === 'edit') {
    const path = getInputString(input, [...PATH_KEYS]);
    if (path) {
      return `编辑 ${getFileName(path)}`;
    }
    const label = (block.label || '').trim();
    return label || '编辑';
  }

  const label = (block.label || '').trim();
  if (label) {
    return label;
  }

  if (toolKind === 'search' && toolName.includes('glob')) {
    const pattern = getInputString(input, ['pattern', 'glob']);
    return pattern ? `Glob pattern: "${pattern}"` : '全局模式匹配';
  }

  if (toolKind === 'search' && toolName.includes('grep')) {
    const pattern = getInputString(input, ['pattern', 'query', 'search']);
    const scope = getInputString(input, ['path', 'cwd', 'directory', 'file_path']);
    if (pattern && scope) {
      return `全局搜索 "${pattern}" (在 ${shortenPath(scope)})`;
    }
    if (pattern) {
      return `全局搜索 "${pattern}"`;
    }
    return '全局搜索';
  }

  const command = getInputString(input, ['command', 'cmd']);
  if (command) {
    return `运行 ${command.length > COMMAND_TRUNCATE_LENGTH ? `${command.slice(0, COMMAND_TRUNCATE_LENGTH - 3)}...` : command}`;
  }

  const path = getInputString(input, ['file_path', 'path', 'filePath', 'absolute_path']);
  if (path) {
    return `${humanizeToolName(block.name)} ${shortenPath(path)}`;
  }

  return humanizeToolName(block.name);
}
