import { escapeHtml } from '../markdownRenderer';
import { shortenPath } from '../fileUtils';
import {
  getInputString,
  getToolKind,
  looksLikePatch,
  MAX_DIFF_LINES,
  type ToolBlock,
} from './toolTypes';

type DiffLine = { kind: 'add' | 'del' | 'ctx' | 'meta'; text: string; lineNo?: number };
type EditedFileDiff = { fileName: string; added: number; removed: number; lines: DiffLine[] };

export function findPatchText(block: ToolBlock): string | null {
  const output = (block.output || '').trim();
  if (looksLikePatch(output)) {
    return output;
  }

  for (const value of Object.values(block.input || {})) {
    if (typeof value === 'string' && looksLikePatch(value)) {
      return value;
    }
  }
  return null;
}

export function extractEditedFileDiffFromPatch(block: ToolBlock): EditedFileDiff | null {
  const patchText = findPatchText(block);
  if (!patchText) {
    return null;
  }

  const lines = patchText.split('\n');
  let fileName = getInputString(block.input, ['file_path', 'path', 'filePath', 'file', 'absolute_path']) || '';

  const fileMarker = lines.find((line) => line.startsWith('*** Update File: ') || line.startsWith('*** Add File: ') || line.startsWith('*** Delete File: '));
  if (fileMarker) {
    fileName = fileMarker.replace(/^(\*\*\* Update File: |\*\*\* Add File: |\*\*\* Delete File: )/, '').trim();
  } else {
    const gitMarker = lines.find((line) => line.startsWith('diff --git '));
    if (gitMarker) {
      const m = gitMarker.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (m) {
        fileName = m[2];
      }
    }
  }

  const renderedLines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let oldLine: number | null = null;
  let newLine: number | null = null;

  for (const line of lines) {
    if (!line) {
      continue;
    }
    if (line.startsWith('@@')) {
      const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (hunk) {
        oldLine = Number(hunk[1]);
        newLine = Number(hunk[2]);
      }
      continue;
    }
    if (line.startsWith('diff --git ') || line.startsWith('*** ') || line.startsWith('--- ') || line.startsWith('+++ ')) {
      continue;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      added++;
      const lineNo = newLine ?? undefined;
      renderedLines.push({ kind: 'add', text: line.substring(1), lineNo });
      if (newLine !== null) {
        newLine++;
      }
      continue;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      removed++;
      const lineNo = oldLine ?? undefined;
      renderedLines.push({ kind: 'del', text: line.substring(1), lineNo });
      if (oldLine !== null) {
        oldLine++;
      }
      continue;
    }
    if (line.startsWith(' ') || line.startsWith('|')) {
      const lineNo = newLine ?? undefined;
      renderedLines.push({ kind: 'ctx', text: line.replace(/^ /, ''), lineNo });
      if (oldLine !== null) {
        oldLine++;
      }
      if (newLine !== null) {
        newLine++;
      }
    }
  }

  if (added === 0 && removed === 0) {
    return null;
  }

  const visibleLines = renderedLines.slice(0, MAX_DIFF_LINES);
  if (renderedLines.length > MAX_DIFF_LINES) {
    visibleLines.push({ kind: 'ctx', text: `... ${renderedLines.length - MAX_DIFF_LINES} more lines` });
  }

  return {
    fileName: fileName || 'unknown file',
    added,
    removed,
    lines: visibleLines,
  };
}

export function extractEditedFileDiffFromOldNew(block: ToolBlock): EditedFileDiff | null {
  const input = block.input || {};
  const oldStr = getInputString(input, ['old_string', 'oldString', 'old_str', 'old_text', 'original', 'search']);
  const newStr = getInputString(input, ['new_string', 'newString', 'new_str', 'new_text', 'replacement', 'replace']);

  if (oldStr === null && newStr === null) {
    return null;
  }

  const fileName = getInputString(input, ['file_path', 'path', 'filePath', 'file', 'absolute_path']) || 'unknown file';
  const renderedLines: DiffLine[] = [];
  let added = 0;
  let removed = 0;

  if (oldStr) {
    const oldLines = oldStr.split('\n');
    for (const line of oldLines) {
      removed++;
      renderedLines.push({ kind: 'del', text: line });
    }
  }

  if (newStr) {
    const newLines = newStr.split('\n');
    for (const line of newLines) {
      added++;
      renderedLines.push({ kind: 'add', text: line });
    }
  }

  if (added === 0 && removed === 0) {
    return null;
  }

  const visibleLines = renderedLines.slice(0, MAX_DIFF_LINES);
  if (renderedLines.length > MAX_DIFF_LINES) {
    visibleLines.push({ kind: 'ctx', text: `... ${renderedLines.length - MAX_DIFF_LINES} more lines` });
  }

  return { fileName, added, removed, lines: visibleLines };
}

export function extractEditedFileDiff(block: ToolBlock): EditedFileDiff | null {
  return extractEditedFileDiffFromPatch(block) || extractEditedFileDiffFromOldNew(block);
}

export function renderWriteFilePreview(block: ToolBlock): string {
  if (block.status !== 'completed') {
    return '';
  }
  if (getToolKind(block) !== 'write') {
    return '';
  }

  const filePath = getInputString(block.input || {}, ['file_path', 'path', 'filePath', 'file', 'absolute_path']) || 'unknown file';
  const content = getInputString(block.input || {}, ['content', 'file_content', 'text', 'body', 'data']);
  const raw = (content || block.output || '').trim();
  if (!raw) {
    return '';
  }

  const lines = raw.split('\n');
  const visible = lines.slice(0, MAX_DIFF_LINES);
  if (lines.length > MAX_DIFF_LINES) {
    visible.push(`... ${lines.length - MAX_DIFF_LINES} more lines`);
  }

  const lineHtml = visible.map((line, idx) => `
    <div class="diff-line add">
      <span class="diff-line-no">${idx + 1}</span>
      <span class="diff-sign">+</span>
      <span class="diff-text">${escapeHtml(line)}</span>
    </div>
  `).join('');

  return `
    <div class="edited-file-preview">
      <div class="edited-file-header">
        <span class="edited-file-title">Written file</span>
        <span class="edited-file-name">${escapeHtml(shortenPath(filePath))}</span>
        <span class="edited-file-stats"><span class="stat-added">Added ${lines.length}</span></span>
      </div>
      <div class="edited-file-diff-scroll">
        ${lineHtml}
      </div>
    </div>
  `;
}

export function renderEditedFilePreview(block: ToolBlock): string {
  if (block.status !== 'completed') {
    return '';
  }

  const diff = extractEditedFileDiff(block);
  if (!diff || diff.lines.length === 0) {
    return '';
  }

  const lineHtml = diff.lines.map((line) => {
    const sign = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : '';
    return `
      <div class="diff-line ${line.kind}">
        <span class="diff-line-no">${line.lineNo ?? ''}</span>
        <span class="diff-sign">${sign}</span>
        <span class="diff-text">${escapeHtml(line.text)}</span>
      </div>
    `;
  }).join('');

  return `
    <div class="edited-file-preview">
      <div class="edited-file-header">
        <span class="edited-file-title">Edited file</span>
        <span class="edited-file-name">${escapeHtml(diff.fileName)}</span>
        <span class="edited-file-stats"><span class="stat-added">Added ${diff.added}</span> <span class="stat-removed">Removed ${diff.removed}</span></span>
      </div>
      <div class="edited-file-diff-scroll">
        ${lineHtml}
      </div>
    </div>
  `;
}
