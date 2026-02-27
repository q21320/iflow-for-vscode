import type { ExtensionMessage } from '../src/protocol';

export class AppLifecycle {
  private composerResizeObserver: ResizeObserver | null = null;
  private messageHandler: ((event: MessageEvent) => void) | null = null;
  private documentClickHandler: ((event: MouseEvent) => void) | null = null;

  setupMessageHandler(onMessage: (message: ExtensionMessage) => void): void {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
    }

    this.messageHandler = (event: MessageEvent) => {
      onMessage(event.data as ExtensionMessage);
    };

    window.addEventListener('message', this.messageHandler);
  }

  setupDocumentClickHandler(onDocumentClick: (target: EventTarget | null) => void): void {
    if (this.documentClickHandler) {
      document.removeEventListener('click', this.documentClickHandler);
    }

    this.documentClickHandler = (event: MouseEvent) => {
      onDocumentClick(event.target);
    };

    document.addEventListener('click', this.documentClickHandler);
  }

  setupComposerLayoutObserver(onResize: () => void): void {
    this.composerResizeObserver?.disconnect();
    this.composerResizeObserver = null;

    const composer = document.querySelector('.composer') as HTMLElement | null;
    if (!composer) {
      return;
    }

    if (typeof ResizeObserver === 'undefined') {
      onResize();
      return;
    }

    this.composerResizeObserver = new ResizeObserver(() => {
      onResize();
    });
    this.composerResizeObserver.observe(composer);
    onResize();
  }

  dispose(): void {
    this.composerResizeObserver?.disconnect();
    this.composerResizeObserver = null;

    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }

    if (this.documentClickHandler) {
      document.removeEventListener('click', this.documentClickHandler);
      this.documentClickHandler = null;
    }
  }
}
