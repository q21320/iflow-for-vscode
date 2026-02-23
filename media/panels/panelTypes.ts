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
