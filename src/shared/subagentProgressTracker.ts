import { StreamChunk } from '../protocol';

const LAUNCH_AGENT_LABEL_PATTERN = /launch agent\(/i;
const STEP_TEXT_MAX_LENGTH = 96;

export interface ActiveSubagentProgress {
  taskToolCallId: string;
  startedAtMs: number;
  lastStep: string;
  lastStepAtMs: number;
}

export class SubagentProgressTracker {
  private activeProgress: ActiveSubagentProgress | null = null;
  private readonly knownToolSteps = new Map<string, string>();
  private readonly subagentTaskToolCallIds = new Set<string>();

  get active(): ActiveSubagentProgress | null {
    return this.activeProgress;
  }

  reset(): boolean {
    const changed = this.activeProgress !== null || this.knownToolSteps.size > 0 || this.subagentTaskToolCallIds.size > 0;
    this.activeProgress = null;
    this.knownToolSteps.clear();
    this.subagentTaskToolCallIds.clear();
    return changed;
  }

  onChunk(chunk: StreamChunk, nowMs = Date.now()): boolean {
    switch (chunk.chunkType) {
      case 'tool_start':
        return this.handleToolStart(chunk, nowMs);
      case 'tool_end':
        return this.handleToolEnd(chunk, nowMs);
      default:
        return false;
    }
  }

  private handleToolStart(chunk: Extract<StreamChunk, { chunkType: 'tool_start' }>, nowMs: number): boolean {
    const stepText = this.describeToolStep(chunk.name, chunk.label, chunk.input);

    if (chunk.toolCallId) {
      this.knownToolSteps.set(chunk.toolCallId, stepText);
    }

    if (this.isSubagentTaskStart(chunk)) {
      if (!chunk.toolCallId) {
        return false;
      }

      this.subagentTaskToolCallIds.add(chunk.toolCallId);

      const nextProgress: ActiveSubagentProgress = this.activeProgress?.taskToolCallId === chunk.toolCallId
        ? {
          ...this.activeProgress,
          lastStep: stepText,
          lastStepAtMs: nowMs,
        }
        : {
          taskToolCallId: chunk.toolCallId,
          startedAtMs: nowMs,
          lastStep: stepText,
          lastStepAtMs: nowMs,
        };
      const changed = !this.activeProgress
        || this.activeProgress.taskToolCallId !== nextProgress.taskToolCallId
        || this.activeProgress.lastStep !== nextProgress.lastStep;
      this.activeProgress = nextProgress;
      return changed;
    }

    if (!this.activeProgress) {
      return false;
    }

    this.activeProgress = {
      ...this.activeProgress,
      lastStep: stepText,
      lastStepAtMs: nowMs,
    };
    return true;
  }

  private handleToolEnd(chunk: Extract<StreamChunk, { chunkType: 'tool_end' }>, nowMs: number): boolean {
    if (!chunk.toolCallId) {
      return false;
    }

    const endedTaskToolCall = this.subagentTaskToolCallIds.has(chunk.toolCallId);
    if (endedTaskToolCall) {
      this.subagentTaskToolCallIds.delete(chunk.toolCallId);
      this.knownToolSteps.delete(chunk.toolCallId);
      if (this.activeProgress?.taskToolCallId === chunk.toolCallId) {
        this.activeProgress = null;
        return true;
      }
      return false;
    }

    if (!this.activeProgress) {
      this.knownToolSteps.delete(chunk.toolCallId);
      return false;
    }

    const knownStep = this.knownToolSteps.get(chunk.toolCallId);
    this.knownToolSteps.delete(chunk.toolCallId);

    if (!knownStep) {
      return false;
    }

    const finalizedStep = `${knownStep} (${chunk.status === 'completed' ? 'done' : 'failed'})`;
    this.activeProgress = {
      ...this.activeProgress,
      lastStep: this.truncateStepText(finalizedStep),
      lastStepAtMs: nowMs,
    };
    return true;
  }

  private isSubagentTaskStart(chunk: Extract<StreamChunk, { chunkType: 'tool_start' }>): boolean {
    if (chunk.name !== 'task') {
      return false;
    }

    if (typeof chunk.input.subagent_type === 'string' && chunk.input.subagent_type.trim().length > 0) {
      return true;
    }

    if (typeof chunk.label === 'string' && LAUNCH_AGENT_LABEL_PATTERN.test(chunk.label)) {
      return true;
    }

    return false;
  }

  private describeToolStep(name: string, label: string | undefined, input: Record<string, unknown>): string {
    const cleanLabel = typeof label === 'string' ? label.trim() : '';
    if (cleanLabel.length > 0) {
      return this.truncateStepText(cleanLabel);
    }

    const hints = ['file_path', 'path', 'url', 'element', 'filename', 'command', 'description', 'time'];
    for (const key of hints) {
      const value = input[key];
      if (typeof value === 'string' && value.trim().length > 0) {
        return this.truncateStepText(`${name} · ${value.trim()}`);
      }
      if (typeof value === 'number' && Number.isFinite(value)) {
        return this.truncateStepText(`${name} · ${value}`);
      }
    }

    return this.truncateStepText(name);
  }

  private truncateStepText(text: string): string {
    if (text.length <= STEP_TEXT_MAX_LENGTH) {
      return text;
    }
    return `${text.slice(0, STEP_TEXT_MAX_LENGTH - 3)}...`;
  }
}

export function formatSubagentProgressText(progress: ActiveSubagentProgress, nowMs = Date.now()): string {
  const elapsedSec = Math.max(0, Math.floor((nowMs - progress.startedAtMs) / 1000));
  const idleSec = Math.max(0, Math.floor((nowMs - progress.lastStepAtMs) / 1000));
  const lastStep = progress.lastStep.trim();

  const parts: string[] = [`Sub-agent running ${elapsedSec}s`];
  if (idleSec > 0) {
    parts.push(`No new steps ${idleSec}s`);
  }

  if (!lastStep) {
    return parts.join(' · ');
  }
  parts.push(`Last step: ${lastStep}`);
  return parts.join(' · ');
}
