export interface FullRenderOptions {
  app: HTMLElement;
  clearInputOnNextRender: boolean;
  html: string;
  bindListeners: () => void;
  onRestoreInput: (input: HTMLTextAreaElement) => void;
  onScrollToBottom: (smooth: boolean) => void;
  smoothScrollToBottom: boolean;
}

interface SavedInputState {
  value: string;
  selectionStart: number;
  selectionEnd: number;
}

function captureInputState(clearInput: boolean): SavedInputState {
  const prevInput = document.getElementById('message-input') as HTMLTextAreaElement | null;
  return {
    value: clearInput ? '' : (prevInput?.value ?? ''),
    selectionStart: prevInput?.selectionStart ?? 0,
    selectionEnd: prevInput?.selectionEnd ?? 0,
  };
}

function restoreInputState(savedInput: SavedInputState, onRestoreInput: (input: HTMLTextAreaElement) => void): void {
  if (!savedInput.value) {
    return;
  }

  const input = document.getElementById('message-input') as HTMLTextAreaElement | null;
  if (!input) {
    return;
  }

  input.value = savedInput.value;
  input.selectionStart = savedInput.selectionStart;
  input.selectionEnd = savedInput.selectionEnd;
  onRestoreInput(input);
}

export function performFullRender(options: FullRenderOptions): void {
  const savedInput = captureInputState(options.clearInputOnNextRender);

  options.app.style.visibility = 'hidden';
  options.app.innerHTML = options.html;
  options.bindListeners();
  restoreInputState(savedInput, options.onRestoreInput);
  options.onScrollToBottom(options.smoothScrollToBottom);

  requestAnimationFrame(() => {
    options.app.style.visibility = 'visible';
  });
}
