export interface PendingConfirmation {
  requestId: number;
  toolName: string;
  description: string;
}

export interface PendingQuestion {
  requestId: number;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiSelect: boolean;
  }>;
}

export interface PendingPlanApproval {
  requestId: number;
  plan: string;
}

export type ApprovalOutcome = "allow" | "alwaysAllow" | "reject";

export function isApprovalOutcome(
  value: string | undefined,
): value is ApprovalOutcome {
  return value === "allow" || value === "alwaysAllow" || value === "reject";
}

export type PlanOption = "smart" | "default" | "keep";

export function isPlanOption(value: string | undefined): value is PlanOption {
  return value === "smart" || value === "default" || value === "keep";
}
