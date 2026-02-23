import { ConversationMode } from '../protocol';

export type ApprovedMode = Extract<ConversationMode, 'smart' | 'default'>;
export type PlanApprovalOption = 'smart' | 'default' | 'keep' | 'feedback';
export type OrchestratorState = 'idle' | 'running' | 'waiting_approval' | 'replaying';

export interface PlanDecision {
  option: PlanApprovalOption;
  approvedMode: ApprovedMode | null;
  feedback: string | null;
}

export class PlanModeOrchestrator {
  private state: OrchestratorState = 'idle';
  private decision: PlanDecision | null = null;
  private syntheticWaitResolve: ((decision: PlanDecision | null) => void) | null = null;
  private planApprovalEmitted = false;

  onRunStart(): void {
    this.state = 'running';
    this.decision = null;
    this.syntheticWaitResolve = null;
    this.planApprovalEmitted = false;
  }

  onPlanApprovalChunk(): void {
    this.planApprovalEmitted = true;
  }

  hasPlanApprovalChunk(): boolean {
    return this.planApprovalEmitted;
  }

  registerApproval(option: PlanApprovalOption, feedback?: string): boolean {
    const approvedMode = option === 'smart' || option === 'default'
      ? option
      : null;
    const trimmedFeedback = option === 'feedback' && typeof feedback === 'string'
      ? feedback.trim()
      : '';

    this.decision = {
      option,
      approvedMode,
      feedback: trimmedFeedback.length > 0 ? trimmedFeedback : null,
    };

    if (this.syntheticWaitResolve) {
      this.syntheticWaitResolve(this.decision);
      this.syntheticWaitResolve = null;
      this.state = 'running';
    }

    return approvedMode !== null;
  }

  async waitForSyntheticApproval(): Promise<PlanDecision | null> {
    if (this.decision) {
      return this.decision;
    }

    this.state = 'waiting_approval';
    return new Promise<PlanDecision | null>((resolve) => {
      this.syntheticWaitResolve = resolve;
    });
  }

  consumeDecision(): PlanDecision | null {
    const current = this.decision;
    this.decision = null;
    return current;
  }

  markReplaying(): void {
    this.state = 'replaying';
  }

  cancelWait(): void {
    if (this.syntheticWaitResolve) {
      this.syntheticWaitResolve(null);
      this.syntheticWaitResolve = null;
    }
    if (this.state === 'waiting_approval') {
      this.state = 'running';
    }
  }

  reset(): void {
    this.state = 'idle';
    this.decision = null;
    this.planApprovalEmitted = false;
    this.cancelWait();
  }

  getStateForTests(): OrchestratorState {
    return this.state;
  }
}
