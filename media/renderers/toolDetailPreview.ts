import { renderTodoWritePreview } from './todoPreviewRenderer';
import { renderEditedFilePreview, renderWriteFilePreview } from './editPreviewRenderer';
import { renderCommandPreview } from './commandPreviewRenderer';
import type { ToolBlock } from './toolTypes';

export function renderToolDetailPreview(block: ToolBlock): string {
  const todo = renderTodoWritePreview(block);
  if (todo) {
    return todo;
  }
  const edited = renderEditedFilePreview(block);
  if (edited) {
    return edited;
  }
  const written = renderWriteFilePreview(block);
  if (written) {
    return written;
  }
  return renderCommandPreview(block);
}
