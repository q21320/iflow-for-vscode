import { WebviewMessage } from '../protocol';

type Handler<T extends WebviewMessage['type']> = (
  message: Extract<WebviewMessage, { type: T }>
) => Promise<void> | void;

export type MessageHandlers = {
  [K in WebviewMessage['type']]?: Handler<K>;
};

export async function routeWebviewMessage(
  message: WebviewMessage,
  handlers: MessageHandlers,
  onUnhandled?: (messageType: WebviewMessage['type']) => void,
): Promise<boolean> {
  const handler = handlers[message.type] as Handler<typeof message.type> | undefined;
  if (!handler) {
    onUnhandled?.(message.type);
    return false;
  }
  await handler(message as Extract<WebviewMessage, { type: typeof message.type }>);
  return true;
}
