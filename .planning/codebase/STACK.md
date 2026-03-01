# Technology Stack

**Analysis Date:** 2026-03-01

## Languages

**Primary:**
- TypeScript 5.9.3 - Source code for both extension host and webview
- JavaScript - Configuration files and build scripts

**Secondary:**
- HTML/CSS - Webview UI templates (generated via TypeScript template strings)

## Runtime

**Environment:**
- Node.js v22+ (required for iFlow CLI integration, configured via `iflow.nodePath` setting)
- VS Code ^1.82.0 (extension host environment)
- Browser (Webview sandboxed iframe context)

**Package Manager:**
- npm (npm workspaces not used; monolithic dependency list)
- Lockfile: `package-lock.json` (present)

## Frameworks

**Core:**
- VS Code Extension API 1.82.0 - Extension host integration
- WebSocket (ws 8.18.0) - ACP protocol transport layer

**Build/Bundling:**
- Webpack 5.104.1 - Dual-bundle compilation (extension + webview)
- ts-loader 9.5.4 - TypeScript loader for Webpack
- ts-node (implied via test setup) - TypeScript execution for tests

**Testing:**
- Mocha 11.7.4 - Test runner (TDD UI style)
- c8 9.1.0 - Code coverage reporter
- @vscode/test-cli 0.0.11 - VS Code extension testing framework
- @vscode/test-electron 2.5.2 - Electron host for integration testing

**Linting/Code Quality:**
- ESLint 9.39.2 - Linting via flat config (eslint.config.mjs)
- typescript-eslint 8.52.0 - TypeScript-aware ESLint rules

## Key Dependencies

**Critical:**
- ws 8.18.0 - WebSocket client for ACP JSON-RPC 2.0 protocol (core communication)

**Infrastructure:**
- @types/vscode 1.82.0 - VS Code API type definitions
- @types/node 22.x - Node.js type definitions
- @types/ws 8.5.13 - WebSocket type definitions
- @types/mocha 10.0.10 - Mocha test framework types

## Configuration

**Environment:**
- VS Code workspace settings (`.vscode/settings.json` likely present)
- Extension manifest: `package.json` with `contributes` section
- Runtime config: `~/.iflow/settings.json` (user home directory, created at runtime)

**Build:**
- `webpack.config.js` - Dual-target configuration (Node.js extension + web Webview)
- `tsconfig.json` - Extension host compilation (target: ES2022, module: Node16, strict mode enabled)
- `tsconfig.webview.json` - Webview compilation (target: ES2022, module: ES2022, DOM lib included)
- `eslint.config.mjs` - Flat config format with @typescript-eslint plugin

**Test:**
- `test/unit/vscode-shim.js` - Shim for VS Code modules in unit tests
- Mocha runs tests via `out/test/**/*.test.js` (compiled output)
- Coverage via c8 with JSON summary output to `coverage/coverage-summary.json`

## Platform Requirements

**Development:**
- Node.js v22+ (strictly required, checked at runtime)
- npm v10+ (inferred from package.json structure)
- TypeScript 5.9.3 installed locally (dev dependency)
- Webpack CLI v6.0.1 (for build tasks)

**Production:**
- VS Code 1.82.0 or later (host environment)
- Node.js v22+ available on system (for iFlow CLI invocation)
- WebSocket support (ws package bundled)

**Extension Packaging:**
- VSCE (vscode-publish) for marketplace publishing (not listed as dev dependency; assumed externally managed)

## File Storage & Persistence

**VS Code Memento:**
- `vscode.Memento` (globalState) - Conversation history and state persistence
- Used via `ConversationRepository` (`src/store/conversationRepository.ts`)
- STORAGE_KEY: `iflow.conversations` (implicitly used)

**Local File System:**
- `~/.iflow/settings.json` - User settings (model, auth type, API base URL)
- Managed via `JsonFileStore` (`src/shared/jsonFileStore.ts`)
- Includes mtime-based caching to avoid redundant reads

**Temporary Files:**
- File diff review snapshots created in VS Code's temp directory (with token-based naming)
- Managed by `FileChangeReviewService` (`src/webview/fileChange/`)

## Security & Signing

**No external PKI/HSM integration detected.** VS Code extension signing handled by marketplace.

---

*Stack analysis: 2026-03-01*
