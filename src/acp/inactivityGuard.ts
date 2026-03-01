import { SUBAGENT_INACTIVITY_CHECK_INTERVAL_MS } from '../constants/runtime';
import { isObject } from '../shared/typeGuards';

export interface InProgressTool {
  name: string;
  title: string;
  toolCallId?: string;
}

export class InactivityGuard {
  private interval: NodeJS.Timeout | null = null;
  private lastActivityTime = Date.now();
  private lastInProgressTool: InProgressTool | null = null;
  private triggered = false;

  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: (tool: InProgressTool | null) => void,
    private readonly log: (message: string) => void,
    private readonly checkIntervalMs = SUBAGENT_INACTIVITY_CHECK_INTERVAL_MS,
  ) {}

  markActivity(update: unknown): void {
    this.lastActivityTime = Date.now();
    if (!isObject(update)) {
      return;
    }

    const isToolUpdate = update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update';
    if (!isToolUpdate || typeof update.toolName !== 'string') {
      return;
    }

    const status = typeof update.status === 'string'
      ? update.status
      : update.sessionUpdate === 'tool_call'
        ? 'pending'
        : 'in_progress';
    const toolCallId = typeof update.toolCallId === 'string'
      ? update.toolCallId
      : null;

    if (status === 'pending' || status === 'in_progress') {
      this.lastInProgressTool = {
        name: update.toolName,
        title: typeof update.title === 'string' ? update.title : '',
        ...(toolCallId ? { toolCallId } : {}),
      };
      return;
    }

    if (status !== 'completed' && status !== 'failed') {
      return;
    }

    if (!this.lastInProgressTool) {
      return;
    }

    const sameToolCall = toolCallId
      ? this.lastInProgressTool.toolCallId === toolCallId
      : this.lastInProgressTool.name === update.toolName;
    if (sameToolCall) {
      this.lastInProgressTool = null;
    }
  }

  start(isRunning: () => boolean): void {
    this.stop();
    this.triggered = false;
    this.lastActivityTime = Date.now();

    if (this.timeoutMs <= 0) {
      return;
    }

    this.interval = setInterval(() => {
      if (!isRunning() || this.triggered) {
        return;
      }
      if (Date.now() - this.lastActivityTime < this.timeoutMs) {
        return;
      }

      this.triggered = true;
      this.log(
        `Inactivity detected (${Math.round(this.timeoutMs / 1000)}s). ` +
        `Last tool: ${this.lastInProgressTool?.name ?? 'none'}. Cancelling...`
      );
      this.onTimeout(this.lastInProgressTool);
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  get didTrigger(): boolean {
    return this.triggered;
  }

  get lastTool(): InProgressTool | null {
    return this.lastInProgressTool;
  }
}
