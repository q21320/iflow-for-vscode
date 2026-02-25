import { StreamStatusPhase } from './protocol';

export interface StreamStatusSnapshot {
  phase: StreamStatusPhase;
  elapsedMs: number;
}

export type StreamStatusEvent =
  | { type: 'stateUpdated'; isStreaming: boolean }
  | { type: 'streamStatus'; phase: StreamStatusPhase; elapsedMs: number }
  | { type: 'streamChunk' }
  | { type: 'streamEnd' }
  | { type: 'streamError' };

export function reduceStreamStatus(
  current: StreamStatusSnapshot | null,
  event: StreamStatusEvent,
): StreamStatusSnapshot | null {
  switch (event.type) {
    case 'stateUpdated':
      return event.isStreaming ? current : null;
    case 'streamStatus':
      return {
        phase: event.phase,
        elapsedMs: event.elapsedMs,
      };
    case 'streamChunk':
    case 'streamEnd':
    case 'streamError':
      return null;
    default:
      return current;
  }
}

export function formatStreamStatusText(_status: StreamStatusSnapshot | null): string {
  return 'Flowing...';
}
