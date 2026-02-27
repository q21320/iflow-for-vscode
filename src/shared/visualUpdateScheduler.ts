type ScheduleFrame = (run: () => void) => number;
type CancelFrame = (token: number) => void;

export interface VisualUpdateSchedulerHandlers {
  onStreamingUpdate: () => void;
  onPendingIndicatorUpdate: () => void;
}

/**
 * Coalesces high-frequency UI updates into at most one callback per frame.
 * Streaming updates have higher priority because they also refresh pending UI.
 */
export class VisualUpdateScheduler {
  private frameToken: number | null = null;
  private queuedTask: 'none' | 'pending' | 'streaming' = 'none';

  constructor(
    private readonly scheduleFrame: ScheduleFrame,
    private readonly cancelFrame: CancelFrame,
    private readonly handlers: VisualUpdateSchedulerHandlers,
  ) {}

  scheduleStreamingUpdate(): void {
    this.queuedTask = 'streaming';
    this.ensureFrame();
  }

  schedulePendingIndicatorUpdate(): void {
    if (this.queuedTask !== 'streaming') {
      this.queuedTask = 'pending';
    }
    this.ensureFrame();
  }

  cancelAll(): void {
    if (this.frameToken !== null) {
      this.cancelFrame(this.frameToken);
      this.frameToken = null;
    }
    this.queuedTask = 'none';
  }

  private ensureFrame(): void {
    if (this.frameToken !== null) {
      return;
    }

    this.frameToken = this.scheduleFrame(() => {
      this.frameToken = null;
      const task = this.queuedTask;
      this.queuedTask = 'none';

      if (task === 'streaming') {
        this.handlers.onStreamingUpdate();
        return;
      }
      if (task === 'pending') {
        this.handlers.onPendingIndicatorUpdate();
      }
    });
  }
}
