import type { ExtensionMessage } from "../src/protocol";
import {
  reduceStreamStatus,
} from "../src/streamStatusUtils";
import type { InputController } from "./inputController";
import type { AppState } from "./appState";

interface AppMessageRouterDeps {
  appState: AppState;
  inputCtrl: Pick<
    InputController,
    "handlePickedFiles" | "setWorkspaceFiles" | "handleFileContents"
  >;
  render: (smoothScrollToBottom?: boolean) => void;
  updateRoundFileChanges: () => void;
  updateStreamingContent: () => void;
  updatePendingIndicator: () => void;
  updateIDEContextChips: () => void;
}

export class AppMessageRouter {
  constructor(private readonly deps: AppMessageRouterDeps) {}

  handle(message: ExtensionMessage): void {
    const { appState } = this.deps;

    switch (message.type) {
      case "stateUpdated": {
        const previousConversationId =
          appState.state?.currentConversationId ?? null;
        const wasStreaming = appState.state?.isStreaming ?? false;
        appState.state = message.state;
        appState.streamStatus = reduceStreamStatus(appState.streamStatus, {
          type: "stateUpdated",
          isStreaming: message.state.isStreaming,
        });

        const conversationChanged =
          previousConversationId !==
          (message.state.currentConversationId ?? null);
        if (message.state.isStreaming && wasStreaming) {
          this.deps.updateStreamingContent();
        } else if (
          !message.state.isStreaming &&
          wasStreaming &&
          !conversationChanged
        ) {
          this.deps.render();
        } else {
          this.deps.render(conversationChanged);
        }
        break;
      }

      case "pickedFiles":
        this.deps.inputCtrl.handlePickedFiles(message.files);
        break;

      case "workspaceFiles":
        this.deps.inputCtrl.setWorkspaceFiles(message.files);
        break;

      case "fileContents":
        this.deps.inputCtrl.handleFileContents(message.files);
        break;

      case "roundFileChanges": {
        const previous = appState.latestRoundChangesByConversationId;
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
        appState.latestRoundChangesByConversationId = next;

        const currentConversationId =
          appState.state?.currentConversationId ?? null;
        if (message.summary.conversationId === currentConversationId) {
          this.deps.updateRoundFileChanges();
        }
        break;
      }

      case "streamChunk":
        appState.streamStatus = reduceStreamStatus(appState.streamStatus, {
          type: "streamChunk",
        });
        if (message.chunk.chunkType === "tool_confirmation") {
          appState.pendingConfirmation = {
            requestId: message.chunk.requestId,
            toolName: message.chunk.toolName,
            description: message.chunk.description,
          };
          this.deps.render();
        } else if (message.chunk.chunkType === "user_question") {
          appState.pendingQuestion = {
            requestId: message.chunk.requestId,
            questions: message.chunk.questions,
          };
          this.deps.render();
        } else if (message.chunk.chunkType === "plan_approval") {
          appState.pendingPlanApproval = {
            requestId: message.chunk.requestId,
            plan: message.chunk.plan,
          };
          this.deps.render();
        }
        break;

      case "streamStatus":
        appState.streamStatus = reduceStreamStatus(
          appState.streamStatus,
          message,
        );
        if (appState.state?.isStreaming) {
          this.deps.updatePendingIndicator();
        }
        break;

      case "streamEnd":
      case "streamError": {
        const hadPendingPanels =
          appState.pendingConfirmation !== null ||
          appState.pendingQuestion !== null ||
          appState.pendingPlanApproval !== null;
        const wasStreaming = appState.state?.isStreaming ?? false;
        if (appState.state && wasStreaming) {
          appState.state = {
            ...appState.state,
            isStreaming: false,
          };
        }
        appState.pendingConfirmation = null;
        appState.pendingQuestion = null;
        appState.pendingPlanApproval = null;
        appState.streamStatus = reduceStreamStatus(appState.streamStatus, {
          type: message.type,
        });
        if (wasStreaming || hadPendingPanels) {
          this.deps.render();
        }
        break;
      }

      case "ideContextChanged": {
        const previous = appState.ideContext;
        const next = message.context;
        const prev = appState.ideContextDismissed;

        const activeFileChanged =
          previous.activeFile?.path !== next.activeFile?.path;
        const selectionChanged =
          previous.selection?.filePath !== next.selection?.filePath ||
          previous.selection?.lineStart !== next.selection?.lineStart ||
          previous.selection?.lineEnd !== next.selection?.lineEnd ||
          previous.selection?.text !== next.selection?.text;

        if (activeFileChanged || selectionChanged) {
          appState.ideContextDismissed = {
            activeFile: activeFileChanged ? false : prev.activeFile,
            selection: selectionChanged ? false : prev.selection,
          };
        }

        appState.ideContext = next;
        this.deps.updateIDEContextChips();
        break;
      }

      case "configurationChanged": {
        if (message.models) {
          appState.models = message.models;
          this.deps.render();
        }
        break;
      }
    }
  }
}
