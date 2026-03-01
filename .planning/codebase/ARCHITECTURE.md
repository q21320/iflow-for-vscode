# Architecture

**Analysis Date:** 2026-03-01

## Pattern Overview

**Overall:** Dual-Bundle VS Code Extension with Custom ACP Communication Stack

**Key Characteristics:**
- Two webpack bundles: `dist/extension.js` (Node.js/Extension Host) and `dist/webview.js` (browser/sandboxed iframe)
- No SDK dependency — ACP protocol implemented directly via WebSocket + JSON-RPC 2.0
- Typed message envelopes via `src/protocol/` shared between both bundles
- Layered dependency injection with interface-based deps objects throughout
- Immutable state updates — all state mutations produce new objects (chunkReducer, conversationMutations, store)

## Layers

**Extension Entry (VS Code Shell):**
- Purpose: Register commands and webview providers with VS Code
- Location: `src/extension.ts`
- Contains: `activate()`, `deactivate()`, command registration
- Depends on: `src/panel.ts`, `src/sidebarProvider.ts`
- Used by: VS Code runtime

**Webview Shell (Panel/Sidebar):**
- Purpose: Create and own the VS Code webview panel/sidebar instance; delegate all logic to WebviewHandler
- Location: `src/panel.ts`, `src/sidebarProvider.ts`
- Contains: VS Code webview lifecycle (create, dispose, reveal)
- Depends on: `src/webviewHandler.ts`
- Used by: `src/extension.ts`

**WebviewHandler (Thin Facade):**
- Purpose: Shared message processing hub used by both Panel and Sidebar; wires together all host-side services
- Location: `src/webviewHandler.ts`
- Contains: Service construction, VS Code API abstraction (`WebviewHandlerDeps` interface), message dispatch
- Depends on: All host-side services (store, AcpClient, pipeline services)
- Used by: `src/panel.ts`, `src/sidebarProvider.ts`

**Message Routing (Host Side):**
- Purpose: Type-safe dispatch of incoming webview messages to handler functions
- Location: `src/webview/messageRouter.ts`
- Contains: `routeWebviewMessage()` — discriminated union dispatch
- Depends on: `src/protocol/webviewMessages.ts`
- Used by: `src/webviewHandler.ts`

**Send Message Pipeline:**
- Purpose: Orchestrates the full lifecycle of sending a user message and handling the streaming response
- Location: `src/webview/sendMessagePipeline.ts`
- Contains: Queue management, streaming state coordination, plan approval followup, performance logging
- Depends on: `ConversationStore`, `AcpClient`, `PlanApprovalCoordinator`
- Used by: `src/webviewHandler.ts`

**ACP Client Facade:**
- Purpose: Public API surface for the ACP communication layer; owns sub-components
- Location: `src/acp/client/acpClientFacade.ts` (re-exported as `src/acpClient.ts`)
- Contains: `AcpClient` class — orchestrates SessionCoordinator, RunExecutor, NotificationRouter, UsageExtractor
- Depends on: All `src/acp/` sub-modules
- Used by: `src/webviewHandler.ts`, `src/webview/sendMessagePipeline.ts`

**Session Coordinator:**
- Purpose: Manages the connection lifecycle — process launch, WebSocket connect, initialize/authenticate, session create/load
- Location: `src/acp/sessionCoordinator.ts`
- Contains: State machine with statuses: `disconnected → connecting → initializing → ready → disposed`
- Depends on: `AcpTransport`, `AcpProtocol`, `ProcessManager`, `RuntimeConfigApplier`, `InteractionBridge`
- Used by: `src/acp/client/acpClientFacade.ts`

**ACP Protocol Layer:**
- Purpose: JSON-RPC 2.0 client/server multiplexer over a transport
- Location: `src/acpProtocol.ts`
- Contains: Request/response correlation, server-method handlers, notification handlers, receive loop
- Depends on: `src/acpTransport.ts`
- Used by: `src/acp/sessionCoordinator.ts`

**ACP Transport Layer:**
- Purpose: Raw WebSocket framing — send/receive string messages
- Location: `src/acpTransport.ts`
- Contains: WebSocket connect/disconnect, buffered message queue for async receive
- Depends on: Node.js `ws` package
- Used by: `src/acpProtocol.ts`

**Interaction Bridge:**
- Purpose: Bridges server-initiated requests (tool approval, questions, plan approval, fs operations) to pending Promise resolutions
- Location: `src/acp/interactionBridge.ts`
- Contains: `registerServerHandlers()` wires JSON-RPC server methods; approval/answer methods resolve pending Promises; timeout auto-cancels stale requests
- Depends on: `src/acpProtocol.ts`, `src/acp/pathPolicy.ts`
- Used by: `src/acp/client/acpClientFacade.ts`, `src/acp/sessionCoordinator.ts`

**Chunk Mapper:**
- Purpose: Translates raw ACP notification payloads into typed `StreamChunk` objects
- Location: `src/chunkMapper/index.ts` (re-exported as `src/chunkMapper.ts`)
- Contains: `ChunkMapper` class dispatching to `toolChunkMapper`, `thinkingChunkMapper`, `usageChunkMapper`, `promptBuilder`
- Depends on: `src/protocol/stream.ts`
- Used by: `src/acp/client/acpNotificationRouter.ts`

**Conversation Store:**
- Purpose: Unified public facade over persisted conversation state + runtime state; notifies webview on change
- Location: `src/store/` (facade at `src/store.ts`)
- Contains: `ConversationStore` → delegates to `ConversationService` (business logic) + `RuntimeStateStore` (runtime flags) + `ConversationRepository` (persistence via VS Code globalState memento)
- Depends on: `src/store/chunkReducer.ts`, `src/store/conversationMutations.ts`
- Used by: `src/webviewHandler.ts`, `src/webview/sendMessagePipeline.ts`

**Chunk Reducer:**
- Purpose: Pure function — applies a `StreamChunk` to an immutable `Message`, producing a new `Message`
- Location: `src/store/chunkReducer.ts`
- Contains: `applyChunkToMessage(message, chunk): Message` — handles all chunk types
- Depends on: `src/protocol/stream.ts`, `src/protocol/conversation.ts`
- Used by: `src/store/conversationService.ts`

**Process Manager:**
- Purpose: Spawns and monitors the iFlow CLI child process; detects available port
- Location: `src/processManager.ts`
- Contains: Auto-detect CLI path, spawn subprocess, wait for WebSocket readiness, port discovery
- Depends on: `src/cliDiscovery.ts`, `src/process/portDiscovery.ts`, `src/process/startupSignals.ts`, `src/process/webSocketReadinessProbe.ts`
- Used by: `src/acp/sessionCoordinator.ts`

**Webview (media/) — Main App:**
- Purpose: Entry point for the sandboxed webview; orchestrates UI state, rendering, and VS Code API bridge
- Location: `media/main.ts`
- Contains: `IFlowApp` class — owns `AppState`, `AppMessageRouter`, `VisualUpdateScheduler`, `InputController`, `SlashMenuController`
- Depends on: All `media/` modules, shared types from `src/protocol/`
- Used by: VS Code webview iframe (loaded via `dist/webview.js`)

**App Message Router (Webview):**
- Purpose: Routes `ExtensionMessage` events from the extension host to UI state mutations and render schedules
- Location: `media/appMessageRouter.ts`
- Contains: `AppMessageRouter.handle()` — handles `stateUpdated`, `streamChunk`, `streamEnd`, `streamError`, `ideContextChanged`, `roundFileChanges`, etc.
- Depends on: `media/appState.ts`, panel controllers
- Used by: `media/main.ts`

**Renderers (Webview):**
- Purpose: Pure string-template HTML renderers for each UI region
- Location: `media/renderers/`
- Contains: `messageRenderer.ts`, `composerRenderer.ts`, `topBarRenderer.ts`, `conversationPanelRenderer.ts`, tool preview renderers
- Depends on: `src/protocol/` types
- Used by: `media/main.ts` (via `media/appRenderer.ts`)

**Panel Controllers (Webview):**
- Purpose: Manage interactive approval/question/plan panels within the webview
- Location: `media/panels/`
- Contains: `approvalPanelController.ts`, `questionPanelController.ts`, `planApprovalPanelController.ts`
- Depends on: `media/panels/panelTypes.ts`, `media/panels/panelRenderers.ts`
- Used by: `media/appMessageRouter.ts`, `media/eventBinder.ts`

## Data Flow

**User Message → CLI → Streamed Response:**

1. User types in webview textarea → `IFlowApp.sendMessage()` in `media/main.ts`
2. `vscode.postMessage({ type: 'sendMessage', ... })` crosses the webview boundary
3. `WebviewHandler.handleMessage()` in `src/webviewHandler.ts` receives it
4. `routeWebviewMessage()` dispatches to `handleSendMessage()`
5. `SendMessagePipeline.execute()` in `src/webview/sendMessagePipeline.ts`:
   - Adds user message to store; creates pending assistant message
   - Calls `AcpClient.run()` with conversation options
6. `AcpClient.run()` → `AcpRunExecutor.run()`:
   - Calls `SessionCoordinator.ensureConnected()` — starts CLI process if needed, connects WebSocket, initializes session
   - Sends `session/run` JSON-RPC request via `AcpProtocol`
7. Server notifications arrive → `AcpNotificationRouter` → `ChunkMapper` → typed `StreamChunk`
8. `StreamChunk` flows via `onChunk` callback → `ConversationStore.appendToAssistantMessage()` → `applyChunkToMessage()` (pure reducer)
9. `postMessage({ type: 'streamChunk', chunk })` sent to webview
10. `AppMessageRouter.handle()` in webview receives `streamChunk` → schedules DOM update via `VisualUpdateScheduler`
11. `streamingViewUpdater.ts` applies incremental DOM patches for performance
12. On `streamEnd`, store finalizes message, webview renders complete state

**Interaction (Tool Approval) Flow:**

1. CLI sends `session/request_permission` server-initiated JSON-RPC request
2. `InteractionBridge.registerServerHandlers()` handler fires → emits `tool_confirmation` StreamChunk
3. Webview receives `streamChunk` → `AppMessageRouter` sets `pendingConfirmation` in `AppState`
4. `composerRenderer.ts` renders approval panel
5. User approves/rejects → webview posts `{ type: 'toolApproval', requestId, outcome }`
6. `WebviewHandler` routes to `AcpClient.approveToolCall()` / `rejectToolCall()`
7. `InteractionBridge` resolves the pending Promise with approval result
8. `AcpProtocol.sendResult()` responds to the server-initiated request

**State Management:**

- Extension host owns authoritative state in `ConversationStore`
- On every state change, `ConversationStore` calls `postMessage({ type: 'stateUpdated', state })`
- Webview `AppState` holds a local copy of `ConversationState` received via `stateUpdated`
- During streaming, individual `streamChunk` messages bypass full state sync for performance; full state sync happens on `streamEnd`
- All mutations produce new objects — `chunkReducer.ts` returns new `Message`, `conversationMutations.ts` returns new `PersistedConversationState`

## Key Abstractions

**StreamChunk (Discriminated Union):**
- Purpose: Typed representation of every incremental output unit from the CLI
- Definition: `src/protocol/stream.ts`
- Pattern: `{ chunkType: 'text' | 'tool_start' | 'tool_end' | 'thinking_start' | 'plan_approval' | ... }`

**ExtensionMessage / WebviewMessage (Typed Envelopes):**
- Purpose: All cross-boundary messages between extension host and webview
- Definition: `src/protocol/webviewMessages.ts`
- Pattern: Discriminated unions dispatched by `type` field; `routeWebviewMessage()` on host side, `AppMessageRouter` on webview side

**AppError (Typed Error):**
- Purpose: Unified error classification across the ACP stack
- Definition: `src/errorUtils.ts`
- Pattern: `AppError` with `code: AppErrorCode` — `UNKNOWN | MISSING_SESSION | CLI_UNAVAILABLE | VALIDATION_FAILED | JSON_RPC_ERROR | IO_ERROR | SECURITY_DENIED | TIMEOUT`

**Dependency Injection via Deps Objects:**
- Purpose: All major classes accept a typed `deps` or named-parameter object instead of concrete dependencies
- Examples: `WebviewHandlerDeps` in `src/webviewHandler.ts`, `SessionCoordinatorDependencies` in `src/acp/sessionCoordinator.ts`, `SendMessagePipelineDependencies` in `src/webview/sendMessagePipeline.ts`
- Pattern: Enables testing via mock deps without subclassing or monkey-patching

## Entry Points

**Extension Host:**
- Location: `src/extension.ts`
- Triggers: VS Code `activate()` event
- Responsibilities: Register commands (`iflow-for-vscode.openPanel`, `iflow-for-vscode.lockGroup`), register sidebar webview providers (primary + secondary)

**Webview:**
- Location: `media/main.ts`
- Triggers: `DOMContentLoaded` event in the webview iframe
- Responsibilities: Instantiate `IFlowApp`, post `{ type: 'ready' }` to extension host, enter render loop

**Webpack Entry Points:**
- Extension bundle: `src/extension.ts` → `dist/extension.js` (Node.js target)
- Webview bundle: `media/main.ts` → `dist/webview.js` (web target)
- Config: `webpack.config.js`

## Error Handling

**Strategy:** Classify errors at boundaries using `toAppError()`, surface user-friendly messages to webview via `streamError` message type, log full details via debug logger.

**Patterns:**
- All errors normalized through `src/errorUtils.ts:toAppError()` → `AppError` with typed `code`
- `DefaultErrorMapper.normalizeForWebview()` in `src/shared/errorBoundary.ts` translates error codes to user-facing messages
- `SendMessagePipeline` catches all run errors, calls `store.batchUpdate()` to finalize streaming state, then posts `streamError` to webview
- `InteractionBridge` auto-cancels timed-out pending interactions with a `warning` StreamChunk
- `SessionCoordinator` tears down transport on any connection error, resets to `disconnected` state

## Cross-Cutting Concerns

**Logging:** All components receive a `log: (message: string) => void` dependency; implementation is `AcpDebugLogger` (`src/acp/debugLogger.ts`) backed by VS Code output channel, gated by `iflow.debugLogging` config. Use `AppLogger` interface from `src/shared/logger.ts`.

**Validation:** Path access validated by `PathPolicy` (`src/acp/pathPolicy.ts`) — `ensureAllowedPath()` throws `SECURITY_DENIED` for out-of-workspace paths. Input validated at webview message boundary in `WebviewHandler.handleMessage()`.

**Authentication:** ACP session authentication handled in `SessionCoordinator.ensureConnected()` — iterates auth methods in priority order (`oauth-iflow`, `iflow`, `openai-compatible`); PKCE OAuth flow available in `src/auth/pkceFlow.ts`.

---

*Architecture analysis: 2026-03-01*
