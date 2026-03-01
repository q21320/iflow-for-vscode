# Codebase Structure

**Analysis Date:** 2026-03-01

## Directory Layout

```
iflow-for-vscode/
├── src/                        # Extension Host source (Node.js bundle)
│   ├── extension.ts            # VS Code activate/deactivate entry point
│   ├── panel.ts                # Independent WebviewPanel host
│   ├── sidebarProvider.ts      # Sidebar WebviewViewProvider host
│   ├── webviewHandler.ts       # Shared handler — wires all host-side services
│   ├── acpClient.ts            # Re-export facade for src/acp/client/
│   ├── acpProtocol.ts          # JSON-RPC 2.0 protocol multiplexer
│   ├── acpTransport.ts         # WebSocket transport layer
│   ├── processManager.ts       # CLI subprocess lifecycle
│   ├── cliDiscovery.ts         # Cross-platform CLI path resolution
│   ├── errorUtils.ts           # AppError class and error classification
│   ├── store.ts                # Re-export facade for src/store/
│   ├── chunkMapper.ts          # Re-export facade for src/chunkMapper/
│   ├── protocol.ts             # Re-export facade for src/protocol/
│   ├── streamStatusUtils.ts    # Stream phase display text helpers
│   │
│   ├── acp/                    # ACP communication layer
│   │   ├── client/             #   ACP client — split from single file
│   │   │   ├── acpClientFacade.ts      # Public API; owns sub-components
│   │   │   ├── acpRunExecutor.ts       # run/cancel execution logic
│   │   │   ├── acpNotificationRouter.ts # Notification dispatch + chunk routing
│   │   │   └── acpUsageExtractor.ts    # Token usage extraction
│   │   ├── sessionCoordinator.ts       # Connection state machine
│   │   ├── interactionBridge.ts        # Tool/question/plan pending Promise bridge
│   │   ├── runtimeConfigApplier.ts     # Session settings sync
│   │   ├── inactivityGuard.ts          # Subagent inactivity timeout monitor
│   │   ├── settingsRepository.ts       # Settings file persistence
│   │   ├── pathPolicy.ts               # Workspace path access control
│   │   ├── debugLogger.ts              # Debug log adapter
│   │   └── types.ts                    # ACP-specific types
│   │
│   ├── chunkMapper/            # ACP payload → StreamChunk mapping
│   │   ├── index.ts            #   ChunkMapper class (coordinator)
│   │   ├── types.ts            #   Payload interfaces and constants
│   │   ├── promptBuilder.ts    #   Prompt assembly
│   │   ├── toolChunkMapper.ts  #   Tool call chunk mapping
│   │   ├── thinkingChunkMapper.ts # Thinking block chunk mapping
│   │   └── usageChunkMapper.ts #   Token usage chunk mapping
│   │
│   ├── store/                  # Conversation state management
│   │   ├── conversationRepository.ts   # Persistence (VS Code globalState memento)
│   │   ├── runtimeStateStore.ts        # Runtime flags (CLI status, streaming)
│   │   ├── runtimeStateSource.ts       # Runtime state snapshot provider
│   │   ├── conversationService.ts      # Business commands (add message, append chunk)
│   │   ├── chunkReducer.ts             # Pure reducer: StreamChunk → Message update
│   │   ├── conversationMutations.ts    # Immutable conversation update helpers
│   │   ├── contextUsageEstimator.ts    # Token usage estimation
│   │   └── storeTypes.ts               # Store-specific types
│   │
│   ├── auth/                   # Authentication
│   │   ├── pkceFlow.ts         #   PKCE OAuth 2.0 flow
│   │   ├── tokenManager.ts     #   Token lifecycle (validate, refresh, clear)
│   │   ├── credentialsStore.ts #   Credential file persistence
│   │   ├── settingsStore.ts    #   Auth settings persistence
│   │   └── types.ts            #   Auth-specific types
│   │
│   ├── webview/                # Host-side services for the webview
│   │   ├── sendMessagePipeline.ts      # Full message send lifecycle
│   │   ├── messageRouter.ts            # Type-safe webview message dispatch
│   │   ├── htmlTemplate.ts             # Webview HTML generation
│   │   ├── cliStatusService.ts         # CLI availability check + caching
│   │   ├── planModeOrchestrator.ts     # Plan mode state machine
│   │   ├── planApprovalCoordinator.ts  # Plan approval workflow
│   │   ├── workspaceFileService.ts     # Workspace file listing + access control
│   │   ├── ideContextSyncService.ts    # IDE context (active file/selection) sync
│   │   ├── fileChangeReviewService.ts  # File change review facade
│   │   └── fileChange/                 # File change review subsystem
│   │       ├── types.ts                #   Types and constants
│   │       ├── snapshotManager.ts      #   File snapshot capture
│   │       ├── chunkTracker.ts         #   Tool chunk tracking
│   │       └── diffService.ts          #   Diff display and rollback
│   │
│   ├── process/                # CLI process helpers
│   │   ├── portDiscovery.ts    #   Port allocation
│   │   ├── startupSignals.ts   #   Startup signal parsing
│   │   └── webSocketReadinessProbe.ts  # WebSocket readiness probe
│   │
│   ├── protocol/               # Shared type definitions (both bundles)
│   │   ├── stream.ts           #   StreamChunk, OutputBlock, StreamStatusPhase
│   │   ├── conversation.ts     #   Conversation, Message, MODELS, ConversationState
│   │   ├── webviewMessages.ts  #   WebviewMessage, ExtensionMessage
│   │   ├── fileChange.ts       #   RoundFileChange, RoundFileChangeSummary
│   │   └── index.ts            #   Unified export
│   │
│   ├── shared/                 # Cross-cutting infrastructure
│   │   ├── typeGuards.ts       #   Unified type guards (use this, not inline guards)
│   │   ├── logger.ts           #   AppLogger interface + OutputChannelLogger
│   │   ├── errorBoundary.ts    #   ErrorMapper + DefaultErrorMapper
│   │   ├── visualUpdateScheduler.ts # RAF-based visual update batching
│   │   ├── subagentProgressTracker.ts # Subagent progress tracking
│   │   └── questionPanelState.ts      # Question panel state machine (shared)
│   │
│   ├── constants/
│   │   ├── runtime.ts          #   Runtime defaults (timeouts, limits)
│   │   └── ui.ts               #   UI constants
│   │
│   └── test/                   # Unit and integration tests (co-located with src)
│       ├── acpClient.test.ts
│       ├── sessionCoordinator.test.ts
│       ├── sendMessagePipeline.test.ts
│       ├── chunkReducer.test.ts
│       ├── interactionBridge.test.ts
│       ├── realCliSmoke.test.ts        # Smoke tests against real CLI
│       ├── realPlanModeSmoke.test.ts
│       ├── realToolCallSmoke.test.ts
│       └── [other *.test.ts files]
│
├── media/                      # Webview source (browser bundle)
│   ├── main.ts                 # Webview entry — IFlowApp class
│   ├── appState.ts             # Application state container
│   ├── appLifecycle.ts         # Init and message listener setup
│   ├── appMessageRouter.ts     # Extension message routing (webview side)
│   ├── appRenderer.ts          # Renderer aggregator module
│   ├── eventBinder.ts          # DOM event binding
│   ├── inputController.ts      # Text input management + file attachments
│   ├── slashMenuController.ts  # Slash command menu
│   ├── markdownRenderer.ts     # Markdown → HTML rendering
│   ├── renderCoordinator.ts    # Render scheduling
│   ├── renderDriver.ts         # String-template render driver
│   ├── streamingViewUpdater.ts # Streaming content incremental DOM update
│   ├── fileUtils.ts            # File path utilities
│   ├── webviewUtils.ts         # Webview layout constants
│   │
│   ├── renderers/              # Pure HTML string-template renderers
│   │   ├── topBarRenderer.ts
│   │   ├── messageRenderer.ts
│   │   ├── composerRenderer.ts
│   │   ├── conversationPanelRenderer.ts
│   │   ├── sharedRendererUtils.ts
│   │   ├── toolTypes.ts
│   │   ├── toolHeadline.ts
│   │   ├── toolDetailPreview.ts
│   │   ├── editPreviewRenderer.ts
│   │   ├── commandPreviewRenderer.ts
│   │   └── todoPreviewRenderer.ts
│   │
│   └── panels/                 # Interactive panel controllers
│       ├── panelControllers.ts         # Unified panel controller export
│       ├── approvalPanelController.ts  # Tool approval panel
│       ├── approvalPanelBinder.ts
│       ├── questionPanelController.ts  # Question panel
│       ├── questionPanelBinder.ts
│       ├── questionPanelView.ts
│       ├── planApprovalPanelController.ts
│       ├── planApprovalPanelBinder.ts
│       ├── panelBinders.ts
│       ├── panelRenderers.ts
│       ├── panelListenerLifecycle.ts
│       └── panelTypes.ts
│
├── dist/                       # Webpack output (generated, committed for packaging)
│   ├── extension.js            #   Extension Host bundle
│   └── webview.js              #   Webview bundle
│
├── scripts/                    # Dev/test scripts (Node.js)
│   ├── iflow-sdk-edit-test.mjs
│   ├── run-real-cli-unit-test.mjs
│   ├── plan-mode-e2e-test.mjs
│   ├── tool-call-e2e-test.mjs
│   └── _acpProbeShared.mjs
│
├── docs/                       # Developer documentation
├── coverage/                   # Test coverage output
├── out/                        # TypeScript compiler output (check mode)
├── package.json                # Extension manifest + npm scripts
├── webpack.config.js           # Dual bundle config (extension + webview)
├── tsconfig.json               # Extension Host TS config
├── tsconfig.webview.json       # Webview TS config
└── CLAUDE.md                   # Project instructions for AI assistants
```

## Directory Purposes

**`src/`:**
- Purpose: Extension Host code — runs in Node.js with full VS Code API access
- Contains: All `*.ts` source for the extension bundle, plus `src/test/` unit tests
- Key files: `src/extension.ts` (entry), `src/webviewHandler.ts` (main coordinator), `src/acpClient.ts` (facade re-export)

**`src/acp/`:**
- Purpose: Full ACP communication stack — no SDK dependency
- Contains: Session management, interaction bridging, config application, path policy, debug logging
- Key files: `src/acp/client/acpClientFacade.ts`, `src/acp/sessionCoordinator.ts`, `src/acp/interactionBridge.ts`

**`src/store/`:**
- Purpose: Conversation state management — persistence, business logic, pure state reduction
- Contains: Repository (persistence), Service (commands), Reducer (pure function), RuntimeStateStore
- Key files: `src/store/conversationService.ts`, `src/store/chunkReducer.ts`

**`src/protocol/`:**
- Purpose: Shared type definitions imported by BOTH the extension bundle (`src/`) and the webview bundle (`media/`)
- Contains: Discriminated union types for all stream chunks, output blocks, webview messages, conversation state
- Key files: `src/protocol/stream.ts`, `src/protocol/webviewMessages.ts`, `src/protocol/conversation.ts`

**`src/shared/`:**
- Purpose: Cross-cutting infrastructure used throughout `src/`
- Contains: Unified type guards, logger interface, error mapper, visual update scheduler
- Key files: `src/shared/typeGuards.ts`, `src/shared/logger.ts`, `src/shared/errorBoundary.ts`

**`src/webview/`:**
- Purpose: Extension-Host-side services that support the webview (NOT the webview code itself)
- Contains: Message pipeline, routing, HTML template, workspace file service, plan mode orchestration, file change review
- Key files: `src/webview/sendMessagePipeline.ts`, `src/webview/messageRouter.ts`

**`media/`:**
- Purpose: Webview source — runs in sandboxed browser context with no direct VS Code API
- Contains: App entry, state, renderers, event binding, panel controllers
- Key files: `media/main.ts`, `media/appMessageRouter.ts`, `media/appState.ts`

**`media/renderers/`:**
- Purpose: Pure HTML string-template renderers for each UI region; no DOM side-effects
- Contains: One file per major UI section; return HTML strings for injection via `renderDriver.ts`

**`media/panels/`:**
- Purpose: Controllers for interactive overlay panels (tool approval, questions, plan approval)
- Contains: Controller + binder + view per panel type; `panelTypes.ts` defines shared types

**`src/test/`:**
- Purpose: Unit and integration tests; co-located with source under `src/`
- Contains: `*.test.ts` files (one per module tested); smoke tests using real CLI (`realCli*.test.ts`)

## Key File Locations

**Entry Points:**
- `src/extension.ts`: VS Code `activate()`/`deactivate()`
- `media/main.ts`: Webview `IFlowApp` bootstrap

**Configuration:**
- `webpack.config.js`: Dual bundle build config
- `tsconfig.json`: Extension Host TypeScript config
- `tsconfig.webview.json`: Webview TypeScript config
- `package.json`: Extension manifest (`contributes`, `activationEvents`, `main`)

**Core Logic:**
- `src/webviewHandler.ts`: Host-side coordination hub
- `src/acp/client/acpClientFacade.ts`: ACP client public API
- `src/acp/sessionCoordinator.ts`: Connection lifecycle state machine
- `src/acp/interactionBridge.ts`: Server-initiated request bridging
- `src/webview/sendMessagePipeline.ts`: Message send + stream lifecycle
- `src/store/conversationService.ts`: Conversation business commands
- `src/store/chunkReducer.ts`: Pure state reducer

**Shared Types:**
- `src/protocol/stream.ts`: `StreamChunk`, `OutputBlock` union types
- `src/protocol/webviewMessages.ts`: `WebviewMessage`, `ExtensionMessage` union types
- `src/protocol/conversation.ts`: `Conversation`, `Message`, `ConversationState`

**Error Handling:**
- `src/errorUtils.ts`: `AppError`, `toAppError()`, `classifyAppErrorCode()`
- `src/shared/errorBoundary.ts`: `ErrorMapper`, `DefaultErrorMapper`

**Testing:**
- `src/test/*.test.ts`: All unit tests
- `src/test/realCli*.test.ts`: Smoke tests requiring a live CLI

## Naming Conventions

**Files:**
- `camelCase.ts` for all TypeScript files (e.g., `sessionCoordinator.ts`, `chunkReducer.ts`)
- `*.test.ts` suffix for test files (e.g., `sessionCoordinator.test.ts`)
- `index.ts` for module barrel/facade files within subdirectories

**Classes:**
- `PascalCase` (e.g., `AcpClient`, `SessionCoordinator`, `ConversationService`, `InteractionBridge`)

**Interfaces / Types:**
- `PascalCase` for exported types (e.g., `StreamChunk`, `WebviewMessage`, `AppError`)
- `PascalCase + Deps` suffix for dependency injection objects (e.g., `WebviewHandlerDeps`, `SessionCoordinatorDependencies`)

**Functions:**
- `camelCase` for all functions (e.g., `applyChunkToMessage`, `routeWebviewMessage`, `toAppError`)

**Constants:**
- `SCREAMING_SNAKE_CASE` for module-level constants (e.g., `DEFAULT_STREAM_RENDER_INTERVAL_MS`, `CLI_VERSION_TIMEOUT_MS`)

**Re-export Facades:**
- Original single-file path retained as a one-line re-export after splitting to subdirectory
- Examples: `src/acpClient.ts` re-exports from `src/acp/client/`, `src/store.ts` re-exports from `src/store/`, `src/chunkMapper.ts` re-exports from `src/chunkMapper/`

## Where to Add New Code

**New ACP Protocol Feature:**
- Protocol/session logic: `src/acp/sessionCoordinator.ts`
- New server-method handler: `src/acp/interactionBridge.ts` → `registerServerHandlers()`
- New ACP payload → chunk mapping: `src/chunkMapper/` (add new file or extend `index.ts`)
- New chunk type: `src/protocol/stream.ts` (union), then `src/store/chunkReducer.ts` (reducer case)

**New Webview Message Type:**
- Type definition: `src/protocol/webviewMessages.ts` (add to `WebviewMessage` or `ExtensionMessage` union)
- Host-side handler: `src/webview/messageRouter.ts` (add handler key), `src/webviewHandler.ts` (implement)
- Webview-side handler: `media/appMessageRouter.ts`

**New Host-Side Service:**
- Create file in `src/webview/` (e.g., `src/webview/myService.ts`)
- Inject into `WebviewHandler` constructor in `src/webviewHandler.ts`
- File size target: under 500 lines; split if larger

**New Webview UI Component:**
- Renderer: `media/renderers/myComponentRenderer.ts` (returns HTML string)
- Panel controller (if interactive): `media/panels/myPanelController.ts` + binder
- Event binding: `media/eventBinder.ts`

**New Store Operation:**
- Business command: `src/store/conversationService.ts`
- Immutable helper: `src/store/conversationMutations.ts`
- Public facade method: `src/store.ts` (or the `ConversationStore` class in `src/store/`)

**New Test:**
- Co-locate at `src/test/<moduleName>.test.ts`
- Real CLI smoke test: `src/test/realCli<feature>Smoke.test.ts`

**Shared Constants:**
- Runtime defaults (timeouts, limits): `src/constants/runtime.ts`
- UI layout constants: `src/constants/ui.ts`
- Webview layout constants: `media/webviewUtils.ts`

**New Type Guard:**
- Add to `src/shared/typeGuards.ts` — do NOT define inline type guards in individual files

## Special Directories

**`dist/`:**
- Purpose: Webpack output — `extension.js` and `webview.js`
- Generated: Yes (by `npm run compile`)
- Committed: Yes (required for VS Code extension packaging)

**`out/`:**
- Purpose: TypeScript compiler output for type-checking only
- Generated: Yes
- Committed: No

**`coverage/`:**
- Purpose: Jest coverage reports (HTML, lcov, JSON)
- Generated: Yes (by `npm run test:coverage`)
- Committed: No (only `coverage-summary.json` appears tracked)

**`src/test/`:**
- Purpose: All unit and integration tests
- Generated: No
- Committed: Yes

**`scripts/`:**
- Purpose: Developer scripts for real-CLI testing and ACP probing
- Generated: No
- Committed: Yes

---

*Structure analysis: 2026-03-01*
