import { AcpClient } from '../acpClient';
import { AuthService } from '../authService';
import { normalizeErrorMessage } from '../errorUtils';
import { ConversationStore } from '../store';
import { AttachedFile, Conversation, ExtensionMessage, IDEContext } from '../protocol';
import { PlanApprovalCoordinator } from './planApprovalCoordinator';

const PLAN_EXECUTION_REMINDER = '<system-reminder>\nPlan mode has been deactivated. The user approved the plan. You are now in execution mode. You may now freely use all tools including write_file, edit_file, run_shell_command, and other modification tools. Please proceed with the implementation.\n</system-reminder>';

interface QueuedMessage {
  content: string;
  attachedFiles: AttachedFile[];
  silent: boolean;
  ideContext?: IDEContext;
}

interface CliCheckResult {
  available: boolean;
  error: string;
}

interface SendMessagePipelineDependencies {
  store: ConversationStore;
  client: AcpClient;
  authService: AuthService;
  postMessage: (message: ExtensionMessage) => void;
  checkCliForSend: () => Promise<CliCheckResult>;
  markCliUnavailable: (diagnostics: string) => void;
  resolveWorkspaceFolder: (conversation: Conversation) => string | undefined;
  getAllWorkspaceFolderPaths: () => string[];
  getWorkspaceFileList: (cwd?: string) => Promise<string[]>;
  planApprovalCoordinator: PlanApprovalCoordinator;
  debug: (message: string) => void;
  setSessionId: (sessionId: string) => void;
}

export class SendMessagePipeline {
  constructor(private readonly deps: SendMessagePipelineDependencies) {}

  async execute(input: QueuedMessage): Promise<void> {
    const queue: QueuedMessage[] = [input];

    while (queue.length > 0) {
      const current = queue.shift();
      if (!current) {
        continue;
      }

      const followups = await this.executeSingle(current);
      queue.push(...followups);
    }
  }

  private async executeSingle(input: QueuedMessage): Promise<QueuedMessage[]> {
    this.deps.debug(
      `Send pipeline start: silent=${input.silent}, contentLength=${input.content.length}, attachedFiles=${input.attachedFiles.length}, hasIdeContext=${Boolean(input.ideContext)}`
    );

    this.deps.store.batchUpdate(() => {
      if (!input.silent) {
        this.deps.store.addUserMessage(input.content, input.attachedFiles);
      }
      this.deps.store.startAssistantMessage();
      this.deps.store.setStreaming(true);
    });

    const cli = await this.deps.checkCliForSend();
    if (!cli.available) {
      const cliError = normalizeErrorMessage(
        cli.error,
        'IFlow CLI/ACP is not available. Please ensure iFlow CLI is installed and accessible in your PATH.',
      );
      this.deps.store.batchUpdate(() => {
        this.deps.store.appendToAssistantMessage({ chunkType: 'error', message: cliError });
        this.deps.store.endAssistantMessage();
        this.deps.store.setStreaming(false);
      });
      this.deps.postMessage({ type: 'streamError', error: cliError });
      this.deps.debug('Send pipeline aborted because CLI is unavailable');
      return [];
    }

    await this.deps.authService.ensureValidToken();

    const conversation = this.deps.store.getCurrentConversation();
    if (!conversation) {
      this.deps.debug('No active conversation found; dropping send request');
      return [];
    }

    const cwd = this.deps.resolveWorkspaceFolder(conversation);
    if (cwd && !conversation.workspaceFolderUri) {
      this.deps.store.setConversationWorkspaceFolder(cwd);
    }

    const fileAllowedDirs = this.deps.getAllWorkspaceFolderPaths();
    const workspaceFiles = await this.deps.getWorkspaceFileList(cwd);
    this.deps.debug(`Prepared run context: mode=${conversation.mode}, model=${conversation.model}, cwd=${cwd ?? 'n/a'}, workspaceFiles=${workspaceFiles.length}, allowedDirs=${fileAllowedDirs.length}`);

    let runSucceeded = false;
    this.deps.planApprovalCoordinator.startRun();

    await this.deps.client.run(
      {
        prompt: input.content,
        attachedFiles: input.attachedFiles,
        mode: conversation.mode,
        think: conversation.think,
        model: conversation.model,
        workspaceFiles,
        sessionId: conversation.sessionId,
        ideContext: input.ideContext,
        cwd,
        fileAllowedDirs,
      },
      (chunk) => {
        this.deps.planApprovalCoordinator.onChunk(chunk);
        this.deps.store.appendToAssistantMessage(chunk);
        this.deps.postMessage({ type: 'streamChunk', chunk });
      },
      () => {
        runSucceeded = true;
        this.deps.debug('Run completed successfully');
        this.deps.store.batchUpdate(() => {
          this.deps.store.endAssistantMessage();
          this.deps.store.setStreaming(false);
        });
        this.deps.postMessage({ type: 'streamEnd' });
      },
      (error) => {
        const normalizedError = normalizeErrorMessage(error);
        this.deps.debug(`Run failed: ${normalizedError}`);
        if (this.shouldResetCli(normalizedError)) {
          this.deps.markCliUnavailable(normalizedError);
        }

        this.deps.store.batchUpdate(() => {
          this.deps.store.appendToAssistantMessage({ chunkType: 'error', message: normalizedError });
          this.deps.store.endAssistantMessage();
          this.deps.store.setStreaming(false);
        });
        this.deps.postMessage({ type: 'streamError', error: normalizedError });
      },
    ).then((returnedSessionId) => {
      if (returnedSessionId) {
        this.deps.debug(`Persisting ACP sessionId on conversation: ${returnedSessionId}`);
        this.deps.setSessionId(returnedSessionId);
      }
    });

    if (!runSucceeded) {
      this.deps.planApprovalCoordinator.cancelWait();
      return [];
    }

    const followup = await this.deps.planApprovalCoordinator.resolveAfterRun(
      conversation.mode,
      () => {
        this.deps.postMessage({
          type: 'streamChunk',
          chunk: {
            chunkType: 'plan_approval',
            requestId: -1,
            plan: '',
          },
        });
      },
    );

    switch (followup.kind) {
      case 'execute':
        this.deps.debug(`Plan approved by user; switching to execution mode=${followup.mode}`);
        this.deps.store.setMode(followup.mode);
        this.deps.planApprovalCoordinator.markReplaying();
        return [{
          content: PLAN_EXECUTION_REMINDER,
          attachedFiles: [],
          silent: true,
        }];

      case 'feedback':
        this.deps.debug('Plan feedback provided by user; re-running in plan mode');
        return [{
          content: followup.feedback,
          attachedFiles: [],
          silent: false,
        }];

      case 'none':
      default:
        return [];
    }
  }

  private shouldResetCli(error: string): boolean {
    return error.includes('connect')
      || error.includes('ECONNREFUSED')
      || error.includes('not found')
      || error.includes('not available');
  }
}
