# Architecture

**Analysis Date:** 2026-03-01

## Pattern Overview

**Overall:** Dual-bundle event-driven architecture with layered message-passing pipeline.

**Key Characteristics:**
- Two independent webpack bundles (Extension Host + Webview sandbox) communicating via `postMessage`
- WebSocket + JSON-RPC 2.0 transport to iFlow CLI (no SDK dependency)
- Immutable state management with pure function reducers
- Factory pattern for ACP client dependencies with composition-based layers

## Layers

**Transport Layer (WebSocket):**
- Location: `src/acpTransport.ts`
- Purpose: Raw WebSocket connection and message serialization/deserialization
- Contains: `AcpTransport` class with send/receive operations
- Depends on: Node.js `net` and WebSocket libs
- Used by: `AcpProtocol`

**Protocol Layer (JSON-RPC 2.0):**
- Location: `src/acpProtocol.ts`
- Purpose: Request/response correlation, method dispatch, notification routing
- Contains: `AcpProtocol` with request handlers, notification handlers, pending request tracking
- Depends on: `AcpTransport`
- Used by: `SessionCoordinator`, `AcpClient`

**Session & Connection Layer:**
- Location: `src/acp/sessionCoordinator.ts`
- Purpose: Connection lifecycle management, protocol instantiation, connection state snapshots
- Contains: Process startup orchestration, reconnection logic, state broadcasting
- Depends on: `AcpProtocol`, `ProcessManager`, config resolution
- Used by: `AcpClient`

**ACP Client Layer:**
- Location: `src/acp/client/acpClientFacade.ts` (main) + split modules:
  - `acpRunExecutor.ts` - Run command execution and cancellation
  - `acpNotificationRouter.ts` - Chunk routing and emission
  - `acpUsageExtractor.ts` - Token usage extraction from payloads
- Purpose: High-level CLI interaction API (run commands, manage interactions)
- Contains: Facade pattern coordinating run lifecycle, interaction bridging, state management
- Depends on: `SessionCoordinator`, `InteractionBridge`, `ChunkMapper`
- Used by: `SendMessagePipeline`, `WebviewHandler`

**Chunk Mapping Layer:**
- Location: `src/chunkMapper/` (directory with coordinator):
  - `index.ts` - `ChunkMapper` coordinator
  - `types.ts` - ACP payload types
  - `promptBuilder.ts` - Prompt assembly
  - `toolChunkMapper.ts` - Tool call mapping
  - `thinkingChunkMapper.ts` - Thinking block buffering
  - `usageChunkMapper.ts` - Token usage extraction
- Purpose: Transform ACP session update payloads into normalized `StreamChunk` objects
- Contains: Stateful mappers (thinking buffering) and pure mappers
- Depends on: Protocol types
- Used by: `AcpClient`, `SendMessagePipeline`

**Store/State Layer:**
- Location: `src/store/` directory:
  - `conversationService.ts` - Command handler for state mutations
  - `chunkReducer.ts` - Pure function: `(Message, StreamChunk) -> Message`
  - `conversationRepository.ts` - Load/save to global state
  - `contextUsageEstimator.ts` - Token usage calculation
  - `conversationMutations.ts` - Immutable update helpers
  - `runtimeStateStore.ts` - Streaming/execution state
- Purpose: Immutable session state management and persistence
- Contains: Pure reducers, batch operation tracking, title derivation
- Depends on: Protocol types
- Used by: `SendMessagePipeline`, `WebviewHandler`, Webview app

**Message Pipeline Layer:**
- Location: `src/webview/sendMessagePipeline.ts`
- Purpose: Orchestrate user message flow through validation, context building, run execution, chunk collection
- Contains: Workspace file caching, streaming interval management, error recovery logic
- Depends on: `AcpClient`, `ConversationStore`, `PlanApprovalCoordinator`, interaction bridge
- Used by: `WebviewHandler`

**Webview Handler (Facade):**
- Location: `src/webviewHandler.ts`
- Purpose: Thin adapter between VS Code webview API and internal systems
- Contains: Message routing, HTML generation, CLI status checking
- Depends on: All upper layers (store, client, pipeline)
- Used by: `IFlowPanel`, `IFlowSidebarProvider`

**Webview Renderer Layer (media/):**
- Location: `media/renderers/` directory:
  - `messageRenderer.ts` - Chat message list
  - `composerRenderer.ts` - Input + context chips
  - `topBarRenderer.ts` - Header controls
  - `conversationPanelRenderer.ts` - Session sidebar
  - `editPreviewRenderer.ts` - File diff previews
  - Tool-specific renderers (command, todo, etc)
- Purpose: Convert state to HTML strings
- Contains: Template strings, no DOM manipulation
- Used by: `media/main.ts` render coordinator

**Webview Event Binding Layer:**
- Location: `media/eventBinder.ts`, `media/inputController.ts`, `media/slashMenuController.ts`
- Purpose: Attach DOM listeners and coordinate user interactions
- Contains: Event delegation, text input state, slash menu parsing
- Used by: `media/main.ts`

**Interaction Bridge (Async Flow Control):**
- Location: `src/acp/interactionBridge.ts`
- Purpose: Pending Promise coordination for tool confirmations, user questions, plan approvals
- Contains: Request tracking, timeout management, response delivery
- Depends on: Protocol types
- Used by: `AcpClient`, `SendMessagePipeline`

## Data Flow

**Main User Message → CLI → Webview Render Loop:**

```
1. User input (media/main.ts)
   ↓
2. postMessage('sendMessage') → extension host
   ↓
3. WebviewHandler receives message
   ↓
4. SendMessagePipeline.execute()
   ├─ Validate + build prompt (ChunkMapper)
   ├─ Add IDE context + attached files
   └─ AcpClient.run(command, session)
   ↓
5. SessionCoordinator.startRun()
   ├─ Start CLI process if needed (ProcessManager)
   ├─ Create WebSocket connection
   └─ Create AcpProtocol instance
   ↓
6. AcpClient sends run request via AcpProtocol
   ↓
7. CLI streams SessionUpdate payloads
   ↓
8. AcpProtocol notifies AcpNotificationRouter
   ↓
9. AcpNotificationRouter.routeStreamChunk()
   ├─ ChunkMapper transforms payload → StreamChunk[]
   ├─ ConversationService.appendChunk() (pure reduce)
   └─ postMessage('streamChunk') to webview
   ↓
10. Webview main.ts receives message
    ├─ AppState.update(chunk)
    ├─ VisualUpdateScheduler batches DOM updates
    └─ Renderer update → display

END of stream:
11. AcpClient finishes, resolves run Promise
12. SendMessagePipeline.finalize()
    ├─ Clear streaming status
    └─ postMessage('streamEnd')
```

**State Management:**

- **Extension Host:** `ConversationService` holds mutable `PersistedConversationState`
  - Persisted to `globalState` via `ConversationRepository`
  - Pure reducer `applyChunkToMessage()` applied to current message
  - Batch mutations tracked via `batchDepth` to defer persistence

- **Webview:** `AppState` mirrors state received from host
  - Updated via `stateUpdated` extension message
  - No persistence (state source of truth is host)
  - Incremental updates only (never full refresh)

**Error Handling Chain:**

```
CLI error → AcpProtocol receives error notification
         → AcpNotificationRouter emits error chunk
         → AppError classification in errorUtils.ts
         → postMessage('streamError') with normalized message
         → Webview displays user-friendly error
```

## Key Abstractions

**StreamChunk (Union Type):**
- Purpose: Normalized representation of CLI streaming output
- Examples: `{chunkType: 'text', content}`, `{chunkType: 'tool_start', name, input}`, `{chunkType: 'usage', promptTokens}`
- Pattern: Discriminated union (exhaustive pattern matching in switch statements)

**OutputBlock (Union Type):**
- Purpose: Rendered representation in messages (more complete than StreamChunk)
- Relation: `chunkReducer` transforms chunks into blocks (accumulates tool output, thinking content)
- Examples: `{type: 'code', language, content}`, `{type: 'tool', name, input, output, status}`

**Conversation:**
- Purpose: Container for a session with a model
- Fields: `id`, `title`, `messages[]`, `mode` (default/yolo/plan), `model`, `sessionId`, `workspaceFolderUri`
- Immutable updates via `updateConversationById()` in `conversationMutations.ts`

**Message:**
- Purpose: Single turn in conversation
- Fields: `id`, `role` (user/assistant), `content`, `blocks[]`, `attachedFiles[]`, `streaming`
- Immutable: blocks are copied before modification in `applyChunkToMessage()`

**AppError:**
- Purpose: Categorized error representation
- Location: `src/errorUtils.ts`
- Pattern: Code classification (UNKNOWN, CLI_UNAVAILABLE, VALIDATION_FAILED, TIMEOUT, etc)
- Usage: Guide user recovery actions

**ConnectionSnapshot:**
- Purpose: Immutable view of connection state
- Contains: `status`, `isConnected`, `sessionId`, `connectedCwd`, `lastError`
- Pattern: Broadcast to subscribers via `onConnectionStateChange` listener

## Entry Points

**Extension Activation:**
- Location: `src/extension.ts`
- Triggers: VS Code loads extension
- Responsibilities:
  - Register `iflow-for-vscode.openPanel` command
  - Register sidebar webview providers (primary + secondary)
  - Manage command subscriptions

**Panel Creation:**
- Location: `src/panel.ts` (`IFlowPanel.createOrShow()`)
- Triggers: User clicks command or sidebar provider resolved
- Responsibilities:
  - Create VS Code WebviewPanel
  - Instantiate `WebviewHandler`
  - Bind webview listeners
  - Set initial HTML

**Sidebar Creation:**
- Location: `src/sidebarProvider.ts` (`IFlowSidebarProvider.resolveWebviewView()`)
- Triggers: VS Code shows sidebar view
- Responsibilities: Same as panel but for persistent sidebar view

**Webview Initialization:**
- Location: `media/main.ts` (Webview script entry)
- Triggers: WebviewPanel/Sidebar HTML loads
- Responsibilities:
  - Acquire VS Code API
  - Create `IFlowApp` instance
  - Attach listeners via `eventBinder.ts`
  - Start render loop

**WebviewHandler Setup:**
- Location: `src/webviewHandler.ts`
- Triggers: Called from `IFlowPanel`/`IFlowSidebarProvider` constructor
- Responsibilities:
  - Initialize `AcpClient`
  - Initialize `ConversationStore`
  - Set up message listeners
  - Generate HTML template
  - Register disposal callbacks

## Error Handling

**Strategy:** Explicit, categorized error propagation with user-facing messaging.

**Patterns:**

- **On ACP Connection Failure:**
  - `SessionCoordinator` catches transport errors
  - `toAppError()` classifies (CLI_UNAVAILABLE, TIMEOUT, etc)
  - Broadcast via `onConnectionStateChange` listener
  - `SendMessagePipeline` catches and posts `streamError` message

- **On Chunk Processing Failure:**
  - `ChunkMapper` logs but does not throw (graceful degradation)
  - `applyChunkToMessage()` safe-checks block indices before mutation

- **On Invalid User Input:**
  - `SendMessagePipeline.execute()` validates before run
  - Message validation in webview via type guards

- **On File Access:**
  - `PathPolicy.ensureAllowedPath()` blocks unauthorized paths
  - Returns `SECURITY_DENIED` error code

- **On Interaction Timeout:**
  - `InteractionBridge` awaits response with timeout
  - Rejects promise on timeout → caught in `SendMessagePipeline`

## Cross-Cutting Concerns

**Logging:**
- Framework: `src/shared/logger.ts` interface `AppLogger`
- Pattern: Child loggers with context propagation (component, sessionId, conversationId)
- Implementation: `OutputChannelLogger` writes to VS Code output channel
- Usage: All major components receive logger in constructor dependencies

**Validation:**
- Type guards: `src/shared/typeGuards.ts` exports `isObject()` for payload validation
- Schema: Implicit via TypeScript union types (StreamChunk, Message, etc)
- CLI validation: Implicit in ACP protocol (server rejects invalid payloads)

**Authentication:**
- Pattern: `InteractionBridge` holds pending promises for approval/question interactions
- Resolved when webview user responds (postMessage `toolApproval`, `questionAnswer`, `planApproval`)
- Timeout: `DEFAULT_INTERACTION_TIMEOUT_MS` from constants

**File Access Control:**
- `PathPolicy` in `src/acp/pathPolicy.ts` validates against workspace folders
- Blocks paths outside allowed directories
- Enforced at tool execution time

---

*Architecture analysis: 2026-03-01*
