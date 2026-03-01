import { ConversationMode, ModelType } from '../protocol';
import { RunOptions } from './types';
import { AcpProtocol } from '../acpProtocol';
import * as path from 'path';

const PLAN_MODE_INSTRUCTIONS = `
Plan mode is active.
You must stay in planning-only mode.
Do not execute modifying actions (no file writes/edits, no state-changing shell commands, no commits).
Use read-only analysis and provide a concrete implementation plan, then wait for user approval.
`.trim();

const MODEL_ID_MAP: Partial<Record<ModelType, string>> = {
  'GLM-4.7': 'glm-4.7',
  'GLM-5': 'glm-5',
  'DeepSeek-V3.2': 'deepseek-v3.2-chat',
  'iFlow-ROME-30BA3B(Preview)': 'iFlow-ROME-30BA3B',
  'Qwen3-Coder-Plus': 'qwen3-coder-plus',
  'Kimi-K2-Thinking': 'kimi-k2-thinking',
  'MiniMax-M2.5': 'minimax-m2.5',
  'MiniMax-M2.1': 'minimax-m2.1',
  'Kimi-K2-0905': 'kimi-k2-0905',
  'Kimi-K2.5': 'kimi-k2.5',
};

export class RuntimeConfigApplier {
  constructor(private readonly log: (message: string) => void) {}

  buildSessionSettings(options: RunOptions): Record<string, unknown> {
    const sessionSettings: Record<string, unknown> = {
      permission_mode: options.mode,
    };

    if (options.mode === 'plan') {
      sessionSettings.append_system_prompt = PLAN_MODE_INSTRUCTIONS;
    } else {
      // Explicitly clear any prior plan-only system reminder when reloading
      // an existing session from plan mode back to execution/chat modes.
      sessionSettings.append_system_prompt = '';
    }

    if (options.fileAllowedDirs && options.fileAllowedDirs.length > 0) {
      sessionSettings.add_dirs = options.fileAllowedDirs;
    }

    return sessionSettings;
  }

  async applySessionRuntimeSettings(
    protocol: AcpProtocol,
    sessionId: string,
    options: RunOptions,
  ): Promise<void> {
    await protocol.sendRequest('session/set_mode', {
      sessionId,
      modeId: options.mode,
    });

    const modelCandidates = this.modelIdCandidates(options.model);
    let modelUpdated = false;

    for (const modelId of modelCandidates) {
      try {
        await protocol.sendRequest('session/set_model', {
          sessionId,
          modelId,
        });
        modelUpdated = true;
        break;
      } catch (err) {
        this.log(`session/set_model failed for '${modelId}': ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    if (!modelUpdated) {
      this.log(`session/set_model could not apply model '${options.model}', falling back to CLI settings file`);
    }

    const thinkPayload: Record<string, unknown> = {
      sessionId,
      thinkEnabled: options.think,
    };
    if (options.think) {
      thinkPayload.thinkConfig = 'think';
    }

    await protocol.sendRequest('session/set_think', thinkPayload);
  }

  private modelIdCandidates(model: ModelType): string[] {
    const mapped = MODEL_ID_MAP[model];
    if (mapped && mapped !== model) {
      return [mapped, model];
    }
    return [model];
  }
}

export function needsReconnect(currentCwd: string | null, nextCwd: string | null): boolean {
  return currentCwd !== nextCwd;
}

export function normalizeCwd(input: string | undefined): string | null {
  if (!input) {
    return null;
  }

  const normalized = path.normalize(input);
  const root = path.parse(normalized).root;
  const withoutTrailingSep = normalized.length > root.length
    ? normalized.replace(/[\\/]+$/, '')
    : normalized;

  if (process.platform === 'win32') {
    return withoutTrailingSep.toLowerCase();
  }

  return withoutTrailingSep;
}

export type SessionMode = ConversationMode;
