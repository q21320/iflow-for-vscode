import { ConversationMode, StreamChunk } from '../protocol';
import { ApprovedMode, PlanApprovalOption, PlanModeOrchestrator } from './planModeOrchestrator';

export type PlanFollowup =
  | { kind: 'none' }
  | { kind: 'execute'; mode: ApprovedMode }
  | { kind: 'feedback'; feedback: string };

export class PlanApprovalCoordinator {
  constructor(private readonly orchestrator: PlanModeOrchestrator) {}

  startRun(): void {
    this.orchestrator.onRunStart();
  }

  onChunk(chunk: StreamChunk): void {
    if (chunk.chunkType === 'plan_approval') {
      this.orchestrator.onPlanApprovalChunk();
    }
  }

  registerSyntheticApproval(option: PlanApprovalOption, feedback?: string): void {
    this.orchestrator.registerApproval(option, feedback);
  }

  registerServerApproval(option: PlanApprovalOption, feedback?: string): boolean {
    return this.orchestrator.registerApproval(option, feedback);
  }

  async resolveAfterRun(
    mode: ConversationMode,
    emitSyntheticApproval: () => void,
  ): Promise<PlanFollowup> {
    if (mode !== 'plan') {
      this.orchestrator.reset();
      return { kind: 'none' };
    }

    if (!this.orchestrator.hasPlanApprovalChunk()) {
      emitSyntheticApproval();
      await this.orchestrator.waitForSyntheticApproval();
    }

    const decision = this.orchestrator.consumeDecision();
    this.orchestrator.reset();

    if (!decision) {
      return { kind: 'none' };
    }

    if (decision.approvedMode) {
      return {
        kind: 'execute',
        mode: decision.approvedMode,
      };
    }

    if (decision.feedback) {
      return {
        kind: 'feedback',
        feedback: decision.feedback,
      };
    }

    return { kind: 'none' };
  }

  markReplaying(): void {
    this.orchestrator.markReplaying();
  }

  cancelWait(): void {
    this.orchestrator.cancelWait();
  }
}
