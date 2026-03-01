# Codebase Structure

**Analysis Date:** 2026-03-01

## Directory Layout

```
iflow-for-vscode/
├── src/                          # Extension Host (Node.js, full VS Code API)
│   ├── extension.ts              # Main entry point, command registration
│   ├── panel.ts                  # Independent panel webview container
│   ├── sidebarProvider.ts        # Sidebar webview view provider
│   ├── webviewHandler.ts         # Shared webview message handler + HTML builder
│   │
│   ├── protocol/                 # Shared type definitions (both bundles)
│   │   ├── stream.ts             # StreamChunk, OutputBlock, StreamStatusPhase
│   │   ├── conversation.ts       # Conversation, Message, Model definitions
│   │   ├── webviewMessages.ts    # WebviewMessage, ExtensionMessage unions
│   │   ├── fileChange.ts         # RoundFileChange, diff types
│   │   └── index.ts              # Unified export
│   │
│   ├── acp/                      # ACP protocol client + session management
│   │   ├── client/               # ACP client split modules
│   │   │   ├── acpClientFacade.ts    # Public API + lifecycle
│   │   │   ├── acpRunExecutor.ts     # Run/cancel execution
│   │   │   ├── acpNotificationRouter.ts  # Chunk emission
│   │   │   └── acpUsageExtractor.ts  # Token usage parsing
│   │   ├── sessionCoordinator.ts # Connection lifecycle, protocol factory
│   │   ├── interactionBridge.ts  # Pending Promise coordination
│   │   ├── debugLogger.ts        # Debug output adapter
│   │   ├── inactivityGuard.ts    # Subagent timeout monitoring
│   │   ├── runtimeConfigApplier.ts   # Config sync to CLI
│   │   ├── settingsRepository.ts # Settings persistence
│   │   ├── pathPolicy.ts         # Path access control
│   │   └── types.ts              # ACP-specific types
│   │
│   ├── acpProtocol.ts            # JSON-RPC 2.0 protocol layer
│   ├── acpTransport.ts           # WebSocket transport
│   │
│   ├── chunkMapper/              # ACP payload → StreamChunk transformation
│   │   ├── index.ts              # ChunkMapper coordinator
│   │   ├── types.ts              # Payload interfaces
│   │   ├── promptBuilder.ts      # Prompt assembly
│   │   ├── toolChunkMapper.ts    # Tool call mapping
│   │   ├── thinkingChunkMapper.ts    # Thinking block buffering
│   │   └── usageChunkMapper.ts   # Token usage extraction
│   │
│   ├── store/                    # Session state (immutable)
│   │   ├── conversationService.ts    # Command handler + public API
│   │   ├── conversationRepository.ts # Persistence layer
│   │   ├── chunkReducer.ts       # Pure: (Message, StreamChunk) → Message
│   │   ├── conversationMutations.ts  # Immutable update helpers
│   │   ├── contextUsageEstimator.ts  # Token usage calculation
│   │   ├── runtimeStateStore.ts  # Streaming/execution state
│   │   ├── runtimeStateSource.ts # State snapshot provider
│   │   └── storeTypes.ts         # Store-specific types
│   │
│   ├── webview/                  # Webview-facing Host services
│   │   ├── sendMessagePipeline.ts    # User message flow orchestration
│   │   ├── fileChangeReviewService.ts  # File diff facade
│   │   ├── fileChange/           # File change diff subsystem
│   │   │   ├── types.ts          # Diff types
│   │   │   ├── snapshotManager.ts    # Snapshot capture
│   │   │   ├── chunkTracker.ts   # Tool chunk tracking
│   │   │   └── diffService.ts    # Diff display + rollback
│   │   ├── messageRouter.ts      # Webview message dispatch
│   │   ├── htmlTemplate.ts       # Webview HTML generation
│   │   ├── cliStatusService.ts   # CLI availability checking
│   │   ├── planModeOrchestrator.ts   # Plan mode state machine
│   │   ├── planApprovalCoordinator.ts  # Plan approval workflow
│   │   ├── workspaceFileService.ts    # Workspace file enumeration
│   │   └── ideContextSyncService.ts   # IDE context updates
│   │
│   ├── process/                  # CLI process management
│   │   ├── portDiscovery.ts      # Port allocation
│   │   ├── startupSignals.ts     # CLI startup signal parsing
│   │   └── webSocketReadinessProbe.ts  # WebSocket readiness check
│   ├── processManager.ts         # Process lifecycle orchestration
│   ├── cliDiscovery.ts           # Cross-platform CLI path discovery
│   ├── nodeDiscovery.ts          # Cross-platform Node.js discovery
│   │
│   ├── shared/                   # Cross-cutting utilities
│   │   ├── logger.ts             # AppLogger interface + OutputChannelLogger
│   │   ├── typeGuards.ts         # Type narrowing utilities
│   │   ├── visualUpdateScheduler.ts   # RAF-based update batching
│   │   ├── jsonFileStore.ts      # JSON file persistence
│   │   ├── pathUtils.ts          # Path manipulation
│   │   ├── arrayUtils.ts         # Array utilities
│   │   ├── questionPanelState.ts # Question panel state machine
│   │   └── subagentProgressTracker.ts # Subagent progress tracking
│   │
│   ├── constants/                # Configuration constants
│   │   ├── runtime.ts            # Default timeouts, limits
│   │   └── ui.ts                 # UI thresholds
│   │
│   ├── errorUtils.ts             # AppError + classification
│   ├── markdownUrlPolicy.ts      # Markdown link validation
│   ├── streamStatusUtils.ts      # Stream status text formatting
│   ├── thinkingParser.ts         # Thinking block extraction
│   │
│   ├── types/                    # (Legacy directory, minimal use)
│   │
│   ├── test/                     # Unit tests
│   │   ├── *.test.ts             # Test files parallel to src
│   │   └── fixtures/             # Test data
│   │
│   ├── acpClient.ts              # Re-export: acp/client/
│   ├── chunkMapper.ts            # Re-export: chunkMapper/
│   ├── protocol.ts               # Re-export: protocol/
│   └── store.ts                  # Re-export: store/
│
├── media/                        # Webview (sandbox, limited access)
│   ├── main.ts                   # Webview entry, app orchestration
│   ├── appState.ts               # Mutable app state container
│   ├── appLifecycle.ts           # Initialization + message setup
│   ├── appMessageRouter.ts       # Extension message routing
│   ├── eventBinder.ts            # DOM event binding + delegation
│   ├── inputController.ts        # Text input state management
│   ├── slashMenuController.ts    # Slash command menu parser
│   │
│   ├── renderers/                # HTML generation (no DOM manipulation)
│   │   ├── messageRenderer.ts    # Chat message list HTML
│   │   ├── composerRenderer.ts   # Input + IDE context HTML
│   │   ├── topBarRenderer.ts     # Header controls HTML
│   │   ├── conversationPanelRenderer.ts  # Conversation list HTML
│   │   ├── editPreviewRenderer.ts  # File edit diff preview
│   │   ├── commandPreviewRenderer.ts  # Command output preview
│   │   ├── todoPreviewRenderer.ts  # Plan/todo preview
│   │   ├── toolHeadline.ts       # Tool call title generation
│   │   ├── toolDetailPreview.ts  # Tool input rendering
│   │   ├── toolTypes.ts          # Tool category definitions
│   │   └── sharedRendererUtils.ts  # Shared rendering helpers
│   │
│   ├── panels/                   # Interaction modal controllers
│   │   ├── approvalPanelController.ts  # Tool approval modal
│   │   ├── questionPanelController.ts  # User question modal
│   │   ├── planApprovalPanelController.ts  # Plan approval modal
│   │   ├── panelRenderers.ts     # Modal HTML generation
│   │   ├── panelBinders.ts       # Panel event listeners (legacy alias)
│   │   ├── panelListenerLifecycle.ts  # Panel setup/teardown
│   │   ├── panelTypes.ts         # Panel-specific types
│   │   ├── questionPanelView.ts  # Question modal DOM view
│   │   ├── questionPanelBinder.ts  # Listener binding
│   │   ├── approvalPanelBinder.ts  # Listener binding
│   │   └── planApprovalPanelBinder.ts  # Listener binding
│   │
│   ├── markdownRenderer.ts       # Markdown → HTML conversion
│   ├── renderCoordinator.ts      # Render scheduling + batching
│   ├── renderDriver.ts           # Template render executor
│   ├── streamingViewUpdater.ts   # Streaming content DOM updates
│   ├── fileUtils.ts              # File path utilities
│   ├── webviewUtils.ts           # UI constants + helpers
│   │
│   ├── styles.css                # Main stylesheet
│   ├── iflow_favicon.svg         # Icon
│   └── *.png                     # Images
│
├── dist/                         # Compiled output (webpack bundles)
│   ├── extension.js              # Extension bundle
│   └── webview.js                # Webview bundle
│
├── node_modules/                 # Dependencies
├── coverage/                      # Test coverage reports
├── package.json                  # NPM dependencies + scripts
├── tsconfig.json                 # TypeScript configuration
├── webpack.config.js             # Webpack build configuration
├── .eslintrc.json                # ESLint configuration
├── CLAUDE.md                      # Project architecture guide
└── README.md                      # Public documentation
```

## Directory Purposes

**src/** (Extension Host)
- Purpose: Main extension logic (runs in Node.js, has full VS Code API access)
- Contains: Protocol implementation, ACP client, state management, process management
- Key files: `extension.ts` (entry), `webviewHandler.ts` (facade), `webviewHandler.ts` (communication hub)

**src/protocol/**
- Purpose: Shared type definitions for both bundles (included in both webpack bundles)
- Contains: Message types, conversation models, stream chunk definitions
- Key files: `index.ts` (unified export)

**src/acp/**
- Purpose: ACP (iFlow CLI) communication protocol implementation
- Contains: WebSocket transport, JSON-RPC layer, session management, interaction coordination
- Key files: `client/acpClientFacade.ts` (public API), `sessionCoordinator.ts` (lifecycle)

**src/chunkMapper/**
- Purpose: Transform ACP session updates into normalized StreamChunk objects
- Contains: Stateful mappers (thinking), pure mappers (text/code), prompt builders
- Key pattern: Coordinator pattern with specialized mappers

**src/store/**
- Purpose: Immutable session state management and persistence
- Contains: Pure reducers, batch operation tracking, repository layer
- Key files: `conversationService.ts` (command handler), `chunkReducer.ts` (pure reducer)

**src/webview/**
- Purpose: Host-side services for webview interaction (bridging gap between webview and ACP)
- Contains: Message pipeline, file diff management, CLI status checking, plan mode orchestration
- Key files: `sendMessagePipeline.ts` (main data flow), `fileChange/` (subsystem)

**src/process/**
- Purpose: CLI process lifecycle management
- Contains: Port discovery, process startup, readiness probing
- Key files: `processManager.ts` (orchestrator)

**src/shared/**
- Purpose: Cross-cutting infrastructure (logging, utilities, type guards)
- Contains: AppLogger interface, array/path utilities, type guards, scheduling
- Key files: `logger.ts` (logging), `typeGuards.ts` (type narrowing)

**media/** (Webview)
- Purpose: User interface (runs in sandboxed iframe, no direct VS Code API)
- Contains: Renderers (HTML generation), event binding (user input), state mirroring
- Key files: `main.ts` (entry), `appState.ts` (state container)

**media/renderers/**
- Purpose: Convert state to HTML strings (no DOM manipulation)
- Contains: Message list, composer, previews, modals
- Key pattern: String template generation, no side effects

**media/panels/**
- Purpose: Modal dialog controllers (tool approval, user questions, plan approval)
- Contains: Rendering, event binding, lifecycle management
- Key files: `panelControllers.ts` (factory), `panelRenderers.ts` (HTML)

**dist/**
- Purpose: Compiled webpack output
- Contains: Two bundles (extension.js for host, webview.js for sandbox)

**coverage/**
- Purpose: Test coverage reports
- Generated: By `npm run test:coverage`

## Key File Locations

**Entry Points:**
- `src/extension.ts` - Extension activation (VS Code loads)
- `src/panel.ts` - Panel webview creation
- `src/sidebarProvider.ts` - Sidebar webview resolution
- `media/main.ts` - Webview initialization

**Configuration:**
- `src/constants/runtime.ts` - Timeouts, limits, defaults
- `src/constants/ui.ts` - UI thresholds
- `package.json` - Dependencies, scripts, build config

**Core Logic:**
- `src/acp/client/acpClientFacade.ts` - Run execution, interaction handling
- `src/webview/sendMessagePipeline.ts` - Message processing flow
- `src/store/conversationService.ts` - State command handler
- `src/store/chunkReducer.ts` - State updates

**Testing:**
- `src/test/*.test.ts` - Test files (co-located with source)

## Naming Conventions

**Files:**
- `*Service.ts` - Stateful service class (conversationService, cliStatusService)
- `*Controller.ts` - Input/interaction controller (inputController, panelControllers)
- `*Router.ts` - Message/event routing (appMessageRouter, acpNotificationRouter)
- `*Coordinator.ts` - Orchestration of multiple subsystems (sessionCoordinator, planApprovalCoordinator)
- `*Executor.ts` - Execution of a specific operation (acpRunExecutor)
- `*Provider.ts` - VS Code WebviewViewProvider or data provider
- `*Handler.ts` - Event/request handler
- `*Reducer.ts` - Pure function transforming state (chunkReducer)
- `*Manager.ts` - Lifecycle management (processManager)
- `*Repository.ts` - Data access abstraction (conversationRepository)
- `*Extractor.ts` - Data extraction/parsing (acpUsageExtractor)
- `*Utils.ts` - Utility functions (errorUtils, pathUtils)
- `*Bridge.ts` - Adapter between subsystems (interactionBridge)
- `*Policy.ts` - Policy/validation enforcement (pathPolicy)

**Directories:**
- `acp/` - ACP (iFlow CLI) communication
- `chunkMapper/` - Chunk mapping and transformation
- `store/` - State management (immutable)
- `webview/` - Webview-related host services
- `process/` - Process management
- `shared/` - Cross-cutting utilities
- `protocol/` - Type definitions
- `constants/` - Configuration constants
- `renderers/` - HTML rendering
- `panels/` - Modal controllers
- `test/` - Test files

## Where to Add New Code

**New Feature (User-Facing):**
- Primary code: Create in `src/` under appropriate subsystem (acp, webview, store)
- Webview UI: Add renderer in `media/renderers/` + event binding in `media/eventBinder.ts`
- Tests: Parallel to implementation file with `.test.ts` suffix
- Types: Add to `src/protocol/` if shared, else co-locate with implementation

**New Tool/Command Integration:**
- Interaction handling: Add to `src/acp/interactionBridge.ts` request types
- Chunk mapping: Add case to `src/chunkMapper/` appropriate mapper
- Rendering: Add to `media/renderers/toolDetailPreview.ts` or new file
- Error classification: Add pattern to `src/errorUtils.ts` `classifyAppErrorCode()`

**New Service/Module:**
- Location pattern: `src/[subsystem]/[name]Service.ts`
- Export: Add to `src/acp/client/acpClientFacade.ts` if it's a public API
- Logging: Inject logger via constructor dependency
- Error handling: Use `toAppError()` for categorization

**Utilities:**
- Shared: `src/shared/` (array, path, type guards)
- Subsystem-specific: Co-locate with subsystem
- Webview utilities: `media/` only if not reusable in host

**Test:**
- Co-locate: `src/module/name.ts` → `src/module/name.test.ts`
- Fixtures: `src/test/fixtures/` for shared test data
- Mocks: Create inline or in `src/test/mocks/` if reused

## Special Directories

**src/types/**
- Purpose: Legacy directory (mostly unused post-refactoring)
- Status: Minimal new code should go here; prefer distributed types

**dist/**
- Purpose: Webpack build output
- Generated: By `npm run compile`
- Committed: Yes (required for VS Code marketplace)

**coverage/**
- Purpose: Test coverage reports
- Generated: By `npm run test:coverage`
- Committed: Partially (summary only, tmp files ignored)

**node_modules/**
- Purpose: Installed dependencies
- Generated: By `npm install`
- Committed: No (.gitignore)

---

*Structure analysis: 2026-03-01*
