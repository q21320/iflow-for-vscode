import type { ConversationState, ExtensionMessage, IDEContext } from '../src/protocol';
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
  setPendingConfirmation: (value: PendingConfirmation | null) => void;
  setPendingQuestion: (value: PendingQuestion | null) => void;
  setPendingPlanApproval: (value: PendingPlanApproval | null) => void;
  inputCtrl: Pick<InputController, 'handlePickedFiles' | 'setWorkspaceFiles' | 'handleFileContents'>;
  render: (smoothScrollToBottom?: boolean) => void;
  updateStreamingContent: () => void;
  updatePendingIndicator: () => void;
  updateIDEContextChips: () => void;
}

export class AppMessageRouter {
  constructor(private readonly deps: AppMessageRouterDeps) {}

  handle(message: ExtensionMessage): void {
    switch (message.type) {
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
        } else {
          this.deps.render(conversationChanged);
        }
        break;
      }

      case 'pickedFiles':
        this.deps.inputCtrl.handlePickedFiles(message.files);
        break;

      case 'workspaceFiles':
        this.deps.inputCtrl.setWorkspaceFiles(message.files);
        break;

      case 'fileContents':
        this.deps.inputCtrl.handleFileContents(message.files);
        break;

      case 'streamChunk':
        this.deps.setStreamStatus(reduceStreamStatus(this.deps.getStreamStatus(), { type: 'streamChunk' }));
        if (message.chunk.chunkType === 'tool_confirmation') {
          this.deps.setPendingConfirmation({
            requestId: message.chunk.requestId,
            toolName: message.chunk.toolName,
            description: message.chunk.description,
          });
          this.deps.render();
        } else if (message.chunk.chunkType === 'user_question') {
          this.deps.setPendingQuestion({
            requestId: message.chunk.requestId,
            questions: message.chunk.questions,
          });
          this.deps.render();
        } else if (message.chunk.chunkType === 'plan_approval') {
          this.deps.setPendingPlanApproval({
            requestId: message.chunk.requestId,
            plan: message.chunk.plan,
          });
          this.deps.render();
        }
        break;

      case 'streamStatus':
        this.deps.setStreamStatus(reduceStreamStatus(this.deps.getStreamStatus(), message));
        if (this.deps.getState()?.isStreaming) {
          this.deps.updatePendingIndicator();
        }
        break;

      case 'streamEnd':
      case 'streamError':
        this.deps.setPendingConfirmation(null);
        this.deps.setPendingQuestion(null);
        this.deps.setPendingPlanApproval(null);
        this.deps.setStreamStatus(reduceStreamStatus(this.deps.getStreamStatus(), { type: message.type }));
        break;

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
