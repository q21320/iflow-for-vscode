import { escapeHtml } from '../markdownRenderer';
import { getToolKind, type ToolBlock } from './toolTypes';

export function renderTodoWritePreview(block: ToolBlock): string {
  if (getToolKind(block) !== 'todo') {
    return '';
  }

  const todos = block.input?.todos as Array<{ task?: string; content?: string; status?: string }> | undefined;
  if (!Array.isArray(todos) || todos.length === 0) {
    return '';
  }

  const entriesHtml = todos.map((entry) => {
    const text = entry.task || entry.content || '';
    const status = entry.status || 'pending';
    let icon: string;
    let statusClass: string;
    switch (status) {
      case 'completed':
        icon = '✓';
        statusClass = 'completed';
        break;
      case 'in_progress':
        icon = '⏳';
        statusClass = 'in-progress';
        break;
      default:
        icon = '☐';
        statusClass = 'pending';
    }
    return `
      <div class="plan-entry ${statusClass}">
        <span class="plan-entry-icon ${statusClass}">${icon}</span>
        <span class="plan-entry-text">${escapeHtml(text)}</span>
      </div>
    `;
  }).join('');

  return `
    <div class="plan-entries">
      ${entriesHtml}
    </div>
  `;
}
