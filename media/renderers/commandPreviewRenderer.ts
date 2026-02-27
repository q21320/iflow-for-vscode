import { escapeHtml } from '../markdownRenderer';
import {
  getInputString,
  MAX_COMMAND_LINES,
  type ToolBlock,
} from './toolTypes';

export function extractCommandPreview(block: ToolBlock): { command: string; lines: string[] } | null {
  const toolName = (block.name || '').toLowerCase();
  const command = getInputString(block.input || {}, ['command', 'cmd', 'script']);
  const output = (block.output || '').trim();
  const looksLikeCommandTool = toolName.includes('bash') || toolName.includes('shell') || toolName.includes('command') || command !== null;

  if (!looksLikeCommandTool) {
    return null;
  }
  if (!command && !output) {
    return null;
  }

  const lines = output ? output.split('\n') : (block.status === 'running' ? ['Running...'] : ['(no output)']);
  const visible = lines.slice(0, MAX_COMMAND_LINES);
  if (lines.length > MAX_COMMAND_LINES) {
    visible.push(`... ${lines.length - MAX_COMMAND_LINES} more lines`);
  }

  return {
    command: command || 'shell command',
    lines: visible,
  };
}

export function renderCommandPreview(block: ToolBlock): string {
  const preview = extractCommandPreview(block);
  if (!preview) {
    return '';
  }

  const linesHtml = preview.lines.map((line, idx) => `
    <div class="command-line">
      <span class="command-line-no">${idx + 1}</span>
      <span class="command-line-text">${escapeHtml(line)}</span>
    </div>
  `).join('');

  return `
    <div class="command-preview">
      <div class="command-preview-header">
        <span class="command-preview-title">Bash command</span>
        <code class="command-preview-cmd">${escapeHtml(preview.command)}</code>
      </div>
      <div class="command-output-scroll">
        ${linesHtml}
      </div>
    </div>
  `;
}
