interface AbortControllerHolder {
  current: AbortController | null;
}

export function beginPanelListenerLifecycle(
  holder: AbortControllerHolder,
  shouldAbort: () => boolean,
): AbortController {
  holder.current?.abort();

  const controller = new AbortController();
  holder.current = controller;

  const observer = new MutationObserver(() => {
    if (shouldAbort()) {
      controller.abort();
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  controller.signal.addEventListener('abort', () => {
    observer.disconnect();
    if (holder.current === controller) {
      holder.current = null;
    }
  }, { once: true });

  return controller;
}
