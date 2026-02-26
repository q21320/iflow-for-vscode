import { ConversationMode, ModelType } from '../protocol';
import { RunOptions } from './types';
import { AcpProtocol } from '../acpProtocol';
import * as path from 'path';

/**
 * Plan mode workflow instructions appended to the system prompt when the
 * session mode is 'plan'. The ACP path does not inject these automatically.
 */
const PLAN_MODE_INSTRUCTIONS = `
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits, run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supercedes any other instructions you have received.

## Enhanced Planning Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions.

1. Focus on understanding the user's request and the code associated with their request
2. Use read-only tools (read_file, glob, list_directory, search_file_content) to explore the codebase
3. If you need clarification, use the ask_user_question tool to ask structured questions with predefined options

### Phase 2: Planning
Goal: Come up with an approach to solve the problem identified in phase 1.
- Provide any background context that may help with the task
- Create a detailed plan using todo_write

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use the ask_user_question tool to ask the user any remaining questions

### Phase 4: Final Plan
Once you have all the information you need, provide your synthesized recommendation including:
- Recommended approach with rationale
- Key insights from different perspectives

### Phase 5: Call exit_plan_mode
CRITICAL: At the very end of your turn, once you are happy with your final plan, you MUST call the exit_plan_mode tool. This is mandatory.
Your turn should ONLY end by calling exit_plan_mode. Do NOT end your turn with just text - always call exit_plan_mode as the final action.
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
