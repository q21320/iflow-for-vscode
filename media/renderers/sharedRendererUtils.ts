import type { ConversationMode } from '../../src/protocol';
import { escapeHtml } from '../markdownRenderer';
import { getFileIcon, getFileIconClass } from '../fileUtils';

export function timeAgo(timestamp: number, now: number): string {
  const diff = now - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

export function renderFileIcon(path: string, extraClass = ''): string {
  const classes = ['file-icon', getFileIconClass(path)];
  if (extraClass) {
    classes.push(extraClass);
  }
  return `<span class="${classes.join(' ')}" aria-hidden="true">${escapeHtml(getFileIcon(path))}</span>`;
}

export function getModeLabel(mode: ConversationMode): string {
  switch (mode) {
    case 'default': return 'Chat';
    case 'yolo': return 'YOLO';
    case 'plan': return 'Plan';
    case 'smart': return 'Smart';
    default: return 'Chat';
  }
}

export function getPieSlicePath(cx: number, cy: number, r: number, percent: number, usedTokens: number): string {
  if (usedTokens === 0) return '';
  if (percent >= 100) {
    return `M${cx - r},${cy} a${r},${r} 0 1,1 ${r * 2},0 a${r},${r} 0 1,1 -${r * 2},0`;
  }
  const clampedPercent = Math.max(percent, 0.5);
  const angle = (clampedPercent / 100) * 360;
  const rad = (angle - 90) * Math.PI / 180;
  const x = cx + r * Math.cos(rad);
  const y = cy + r * Math.sin(rad);
  const largeArc = angle > 180 ? 1 : 0;
  return `M${cx},${cy} L${cx},${cy - r} A${r},${r} 0 ${largeArc},1 ${x.toFixed(2)},${y.toFixed(2)} Z`;
}
