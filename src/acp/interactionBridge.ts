import * as fs from "fs";
import * as path from "path";
import { StreamChunk } from "../protocol";
import { AcpProtocol } from "../acpProtocol";
import {
  PendingInteraction,
  PendingPlan,
  PendingQuestion,
  PendingPermission,
  PermissionOption,
} from "./types";
import { isObject } from "../shared/typeGuards";
import { normalizeErrorMessage } from "../errorUtils";

interface ToolCallParams {
  toolCall?: {
    title?: string;
    toolName?: string;
    kind?: string;
  };
  options?: PermissionOption[];
}

interface QuestionOption {
  label?: string;
  description?: string;
}

interface QuestionPrompt {
  question?: string;
  header?: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
}

interface QuestionParams {
  questions?: QuestionPrompt[];
}

interface PlanParams {
  plan?: string;
}

interface InteractionBridgeOptions {
  interactionTimeoutMs?: number;
  enableLegacyQuestionBridge?: boolean;
  enableLegacyPlanExitBridge?: boolean;
}

export class InteractionBridge {
  private pendingInteractions = new Map<number, PendingInteraction>();
  private readonly timeoutHandles = new Map<
    number,
    ReturnType<typeof setTimeout>
  >();
  private readonly createdAt = new Map<number, number>();
  private readonly interactionTimeoutMs: number;
  private readonly enableLegacyQuestionBridge: boolean;
  private readonly enableLegacyPlanExitBridge: boolean;
  private currentMode: string = "default";

  constructor(
    private readonly emitChunk: (chunk: StreamChunk) => void,
    private readonly ensureAllowedPath: (rawPath: string) => string,
    private readonly log: (message: string) => void,
    options: InteractionBridgeOptions = {},
  ) {
    this.interactionTimeoutMs = options.interactionTimeoutMs ?? 120_000;
    this.enableLegacyQuestionBridge =
      options.enableLegacyQuestionBridge ?? false;
    this.enableLegacyPlanExitBridge =
      options.enableLegacyPlanExitBridge ?? false;
  }

  clearPendingInteractions(reason = "interaction bridge reset"): void {
    for (const [id, pending] of this.pendingInteractions.entries()) {
      this.clearTimer(id);
      this.resolveCancelled(id, pending, reason);
    }

    this.pendingInteractions.clear();
    this.createdAt.clear();
  }

  setMode(mode: string): void {
    this.currentMode = mode;
  }

  // Backward-compat test hook.
  getPendingInteractionsForTests(): Map<number, PendingInteraction> {
    return this.pendingInteractions;
  }

  // Backward-compat test hook.
  replacePendingInteractionsForTests(
    map: Map<number, PendingInteraction>,
  ): void {
    this.clearPendingInteractions("test map replaced");
    this.pendingInteractions = map;

    const now = Date.now();
    for (const id of map.keys()) {
      this.createdAt.set(id, now);
    }
  }

  registerServerHandlers(protocol: AcpProtocol): void {
    protocol.onServerMethod(
      "session/request_permission",
      async (id: number, params: unknown) => {
        const toolParams = (isObject(params) ? params : {}) as ToolCallParams;
        const toolName =
          toolParams.toolCall?.toolName ??
          toolParams.toolCall?.title ??
          "unknown";
          
        // In smart mode, auto-approve tool calls without showing confirmation
        if (this.currentMode === "smart") {
          const options = toolParams.options ?? [];
          const optionId = this.pickPermissionOptionId(
            options,
            ["allow_once", "allow_always"]
          );
          
          if (optionId) {
            return { outcome: { outcome: "selected", optionId } };
          } else {
            return { outcome: { outcome: "cancelled" } };
          }
        }

        // In other modes, show confirmation dialog
        this.emitChunk({
          chunkType: "tool_confirmation",
          requestId: id,
          toolName,
          description: toolParams.toolCall?.title ?? toolName,
          confirmationType: toolParams.toolCall?.kind ?? "other",
        });

        return new Promise((resolve) => {
          const pending: PendingPermission = {
            kind: "permission",
            resolve,
            options: toolParams.options ?? [],
          };
          this.registerPendingInteraction(id, pending);
        });
      },
    );

    if (this.enableLegacyQuestionBridge) {
      protocol.onServerMethod(
        "_iflow/user/questions",
        async (id: number, params: unknown) => {
          const questionParams = (
            isObject(params) ? params : {}
          ) as QuestionParams;
          const mappedQuestions = (questionParams.questions ?? []).map((q) => ({
            question: q.question ?? "",
            header: q.header ?? "Question",
            options: (q.options ?? []).map((opt) => ({
              label: opt.label ?? "",
              description: opt.description ?? "",
            })),
            multiSelect: q.multiSelect ?? false,
          }));

          this.emitChunk({
            chunkType: "user_question",
            requestId: id,
            questions: mappedQuestions,
          });

          return new Promise((resolve) => {
            const pending: PendingQuestion = { kind: "question", resolve };
            this.registerPendingInteraction(id, pending);
          });
        },
      );
    }

    if (this.enableLegacyPlanExitBridge) {
      protocol.onServerMethod(
        "_iflow/plan/exit",
        async (id: number, params: unknown) => {
          const planParams = (isObject(params) ? params : {}) as PlanParams;

          this.emitChunk({
            chunkType: "plan_approval",
            requestId: id,
            plan: planParams.plan ?? "",
          });

          return new Promise((resolve) => {
            const pending: PendingPlan = { kind: "plan", resolve };
            this.registerPendingInteraction(id, pending);
          });
        },
      );
    }

    protocol.onServerMethod(
      "fs/read_text_file",
      async (_id: number, params: unknown) => {
        try {
          if (!isObject(params) || typeof params.path !== "string") {
            return { error: "Invalid read_text_file params" };
          }

          const safePath = this.ensureAllowedPath(params.path);
          const content = await fs.promises.readFile(safePath, "utf-8");
          return { content };
        } catch (err: unknown) {
          const message = normalizeErrorMessage(err);
          this.log(`fs/read_text_file failed: ${message}`);
          return { error: message };
        }
      },
    );

    protocol.onServerMethod(
      "fs/write_text_file",
      async (_id: number, params: unknown) => {
        try {
          if (
            !isObject(params) ||
            typeof params.path !== "string" ||
            typeof params.content !== "string"
          ) {
            return { error: "Invalid write_text_file params" };
          }

          const safePath = this.ensureAllowedPath(params.path);
          await fs.promises.mkdir(path.dirname(safePath), { recursive: true });
          await fs.promises.writeFile(safePath, params.content, "utf-8");
          return null;
        } catch (err: unknown) {
          const message = normalizeErrorMessage(err);
          this.log(`fs/write_text_file failed: ${message}`);
          return { error: message };
        }
      },
    );
  }

  async approveToolCall(requestId: number, outcome: string): Promise<void> {
    const pending = this.consumePending(requestId, "permission");
    if (!pending) {
      return;
    }

    const optionId = this.pickPermissionOptionId(
      pending.options,
      outcome === "alwaysAllow"
        ? ["allow_always", "allow_once"]
        : ["allow_once", "allow_always"],
    );

    if (optionId) {
      pending.resolve({ outcome: { outcome: "selected", optionId } });
      return;
    }

    pending.resolve({ outcome: { outcome: "cancelled" } });
  }

  async rejectToolCall(requestId: number): Promise<void> {
    const pending = this.consumePending(requestId, "permission");
    if (!pending) {
      return;
    }

    pending.resolve({ outcome: { outcome: "cancelled" } });
  }

  async answerQuestions(
    requestId: number,
    answers: Record<string, string | string[]>,
  ): Promise<void> {
    const pending = this.consumePending(requestId, "question");
    if (!pending) {
      return;
    }

    pending.resolve({ answers });
  }

  async approvePlan(requestId: number, approved: boolean): Promise<void> {
    const pending = this.consumePending(requestId, "plan");
    if (!pending) {
      return;
    }

    pending.resolve({ approved });
  }

  private registerPendingInteraction(
    id: number,
    pending: PendingInteraction,
  ): void {
    const existing = this.pendingInteractions.get(id);
    if (existing) {
      this.clearTimer(id);
      this.resolveCancelled(
        id,
        existing,
        `replaced by newer interaction #${id}`,
      );
    }

    this.pendingInteractions.set(id, pending);
    this.createdAt.set(id, Date.now());

    const timeoutHandle = setTimeout(() => {
      this.expirePendingInteraction(id);
    }, this.interactionTimeoutMs);
    this.timeoutHandles.set(id, timeoutHandle);
  }

  private expirePendingInteraction(id: number): void {
    const pending = this.pendingInteractions.get(id);
    if (!pending) {
      return;
    }

    this.pendingInteractions.delete(id);
    this.clearTimer(id);
    const startedAt = this.createdAt.get(id) ?? Date.now();
    this.createdAt.delete(id);

    const elapsed = Date.now() - startedAt;
    const message = `Interaction request #${id} (${pending.kind}) timed out after ${elapsed}ms`;
    this.log(message);
    this.emitChunk({ chunkType: "warning", message });

    this.resolveCancelled(id, pending, "interaction timeout");
  }

  private clearTimer(id: number): void {
    const timer = this.timeoutHandles.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timeoutHandles.delete(id);
    }
  }

  private consumePending<TKind extends PendingInteraction["kind"]>(
    id: number,
    kind: TKind,
  ): Extract<PendingInteraction, { kind: TKind }> | null {
    const pending = this.pendingInteractions.get(id);
    if (!pending || pending.kind !== kind) {
      return null;
    }

    this.pendingInteractions.delete(id);
    this.createdAt.delete(id);
    this.clearTimer(id);
    return pending as Extract<PendingInteraction, { kind: TKind }>;
  }

  private resolveCancelled(
    id: number,
    pending: PendingInteraction,
    reason: string,
  ): void {
    try {
      switch (pending.kind) {
        case "permission":
          pending.resolve({ outcome: { outcome: "cancelled" } });
          break;
        case "question":
          pending.resolve({ answers: {} });
          break;
        case "plan":
          pending.resolve({ approved: false });
          break;
      }
    } catch (err: unknown) {
      const message = normalizeErrorMessage(err);
      this.log(`Failed to resolve cancelled interaction #${id}: ${message}`);
    }

    this.log(
      `Resolved pending interaction #${id} (${pending.kind}) as cancelled: ${reason}`,
    );
  }

  private pickPermissionOptionId(
    options: PermissionOption[],
    preferredKinds: string[],
  ): string | null {
    for (const kind of preferredKinds) {
      const match = options.find(
        (opt) => opt.kind === kind && typeof opt.optionId === "string",
      );
      if (match) {
        return match.optionId;
      }
    }

    return null;
  }
}
