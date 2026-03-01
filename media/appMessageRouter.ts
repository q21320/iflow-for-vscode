import type { ConversationState, ExtensionMessage, IDEContext, RoundFileChangeSummary } from '../src/protocol';
import { reduceStreamStatus, StreamStatusSnapshot } from '../src/streamStatusUtils';
import type { InputController } from './inputController';
import type { PendingConfirmation, PendingPlanApproval, PendingQuestion } from './panels/panelTypes';

type IDEContextDismissed = { activeFile: boolean; selection: boolean };

interface AppMessageRouterDeps {
  getState: () => ConversationState | null;
  setState: (state: ConversationState) => void;
  getStreamStatus: () => StreamStatusSnapshot | null;
  setStreamStatus: (status: StreamStatusSnapshot | null) => void;
  getIDEContext: () => IDEContext;
  setIDEContext: (context: IDEContext) => void;
  getIDEContextDismissed: () => IDEContextDismissed;
  setIDEContextDismissed: (dismissed: IDEContextDismissed) => void;
  getLatestRoundChangesByConversationId: () => Map<string, RoundFileChangeSummary>;
  setLatestRoundChangesByConversationId: (value: Map<string, RoundFileChangeSummary>) => void;
  setPendingConfirmation: (value: PendingConfirmation | null) => void;
  setPendingQuestion: (value: PendingQuestion | null) => void;
  setPendingPlanApproval: (value: PendingPlanApproval | null) => void;
  inputCtrl: Pick<InputController, 'handlePickedFiles' | 'setWorkspaceFiles' | 'handleFileContents'>;
  render: (smoothScrollToBottom?: boolean) => void;
  updateRoundFileChanges: () => void;
  updateStreamingContent: () => void;
  updatePendingIndicator: () => void;
  updateIDEContextChips: () => void;
}

export class AppMessageRouter {
  private hasPendingConfirmation = false;
  private hasPendingQuestion = false;
  private hasPendingPlanApproval = false;

  constructor(private readonly deps: AppMessageRouterDeps) {}

  handle(message: ExtensionMessage): void {
    switch (message.type) {
      // Full state snapshots from extension host.
      case 'stateUpdated': {
        const previousState = this.deps.getState();
        const previousConversationId = previousState?.currentConversationId ?? null;
        const wasStreaming = previousState?.isStreaming ?? false;
        this.deps.setState(message.state);
        this.deps.setStreamStatus(reduceStreamStatus(this.deps.getStreamStatus(), {
          type: 'stateUpdated',
          isStreaming: message.state.isStreaming,
        }));

        const conversationChanged = previousConversationId !== (message.state.currentConversationId ?? null);
        if (message.state.isStreaming && wasStreaming) {
          this.deps.updateStreamingContent();
        } else if (!message.state.isStreaming && wasStreaming && !conversationChanged) {
          // Turn completion must fully refresh composer controls (Stop -> Send).
          this.deps.render();
        } else {
          this.deps.render(conversationChanged);
        }
        break;
      }

      // Workspace/file helper responses for @mention and file chips.
      case 'pickedFiles':
        this.deps.inputCtrl.handlePickedFiles(message.files);
        break;

      case 'workspaceFiles':
        this.deps.inputCtrl.setWorkspaceFiles(message.files);
        break;

      case 'fileContents':
        this.deps.inputCtrl.handleFileContents(message.files);
        break;

      case 'roundFileChanges': {
        const previous = this.deps.getLatestRoundChangesByConversationId();
        const hadSummary = previous.has(message.summary.conversationId);
        const next = new Map(previous);
        if (message.summary.changedFiles.length === 0) {
          if (!hadSummary) {
            break;
          }
          next.delete(message.summary.conversationId);
        } else {
          next.set(message.summary.conversationId, message.summary);
        }
        this.deps.setLatestRoundChangesByConversationId(next);

        const currentConversationId = this.deps.getState()?.currentConversationId ?? null;
        if (message.summary.conversationId === currentConversationId) {
          this.deps.updateRoundFileChanges();
        }
        break;
      }

      // Streaming chunks may carry interactive panel requests.
      case 'streamChunk':
        this.deps.setStreamStatus(reduceStreamStatus(this.deps.getStreamStatus(), { type: 'streamChunk' }));
        if (message.chunk.chunkType === 'tool_confirmation') {
          this.hasPendingConfirmation = true;
          this.deps.setPendingConfirmation({
            requestId: message.chunk.requestId,
            toolName: message.chunk.toolName,
            description: message.chunk.description,
          });
          this.deps.render();
        } else if (message.chunk.chunkType === 'user_question') {
          this.hasPendingQuestion = true;
          this.deps.setPendingQuestion({
            requestId: message.chunk.requestId,
            questions: message.chunk.questions,
          });
          this.deps.render();
        } else if (message.chunk.chunkType === 'plan_approval') {
          this.hasPendingPlanApproval = true;
          this.deps.setPendingPlanApproval({
            requestId: message.chunk.requestId,
            plan: message.chunk.plan,
          });
          this.deps.render();
        }
        break;

      // Lightweight status updates for pending indicator copy.
      case 'streamStatus':
        this.deps.setStreamStatus(reduceStreamStatus(this.deps.getStreamStatus(), message));
        if (this.deps.getState()?.isStreaming) {
          this.deps.updatePendingIndicator();
        }
        break;

      // Terminal stream events clear any pending panel state.
      case 'streamEnd':
      case 'streamError': {
        const hadPendingPanels = this.hasPendingConfirmation || this.hasPendingQuestion || this.hasPendingPlanApproval;
        const currentState = this.deps.getState();
        const wasStreaming = currentState?.isStreaming ?? false;
        if (currentState && wasStreaming) {
          // Defensive fallback: a final stateUpdated(false) can be dropped/delayed.
          // Terminal events must still close the streaming UI immediately.
          this.deps.setState({
            ...currentState,
            isStreaming: false,
          });
        }
        this.hasPendingConfirmation = false;
        this.hasPendingQuestion = false;
        this.hasPendingPlanApproval = false;
        this.deps.setPendingConfirmation(null);
        this.deps.setPendingQuestion(null);
        this.deps.setPendingPlanApproval(null);
        this.deps.setStreamStatus(reduceStreamStatus(this.deps.getStreamStatus(), { type: message.type }));
        if (wasStreaming || hadPendingPanels) {
          this.deps.render();
        }
        break;
      }

      // IDE context chip updates are patched incrementally.
      case 'ideContextChanged': {
        const previous = this.deps.getIDEContext();
        const next = message.context;
        const dismissed = this.deps.getIDEContextDismissed();

        if (previous.activeFile?.path !== next.activeFile?.path) {
          dismissed.activeFile = false;
        }
        if (
          previous.selection?.filePath !== next.selection?.filePath
          || previous.selection?.lineStart !== next.selection?.lineStart
          || previous.selection?.lineEnd !== next.selection?.lineEnd
          || previous.selection?.text !== next.selection?.text
        ) {
          dismissed.selection = false;
        }

        this.deps.setIDEContextDismissed(dismissed);
        this.deps.setIDEContext(next);
        this.deps.updateIDEContextChips();
        break;
      }
    }
  }
}
