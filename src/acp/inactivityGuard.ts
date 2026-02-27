import { SUBAGENT_INACTIVITY_CHECK_INTERVAL_MS } from '../constants/runtime';
import { isObject } from '../shared/typeGuards';

export interface InProgressTool {
  name: string;
  title: string;
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

    if (
      update.sessionUpdate === 'tool_call_update'
      && update.status === 'in_progress'
      && typeof update.toolName === 'string'
    ) {
      this.lastInProgressTool = {
        name: update.toolName,
        title: typeof update.title === 'string' ? update.title : '',
      };
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
