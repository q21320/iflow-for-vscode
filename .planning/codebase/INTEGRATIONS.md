# External Integrations

**Analysis Date:** 2026-03-01

## APIs & External Services

**iFlow CLI (Self-Hosted):**
- Service: iFlow command-line interface (spun up as subprocess on demand)
- What it's used for: AI code completion, tool execution, chat streaming
- SDK/Client: Custom ACP (WebSocket + JSON-RPC 2.0) implementation
- Protocol: JSON-RPC 2.0 over WebSocket (`ws://localhost:{port}/acp`)
- Auth: Multiple auth methods supported via `authenticate` RPC method
  - `oauth-iflow` (preferred - OAuth 2.0 with PKCE)
  - `iflow` (API-key authentication)
  - `openai-compatible` (OpenAI-compatible endpoint)
  - Custom external auth methods (determined by CLI capability)

**OpenAI-Compatible API (Optional):**
- Service: OpenAI-compatible LLM endpoint (specified via `iflow.baseUrl` setting)
- What it's used for: Model inference (overrides CLI-configured endpoint if set)
- Config env var: `iflow.baseUrl` (extension setting, not environment variable)
- Used in: `RuntimeConfigApplier` (`src/acp/runtimeConfigApplier.ts`)

## Data Storage

**Databases:**
- None detected. Extension uses VS Code's built-in storage only.

**File Storage:**
- VS Code Memento (globalState) - Persistent conversation history
  - No external database required
  - Stored in VS Code's internal storage (encrypted by platform)
- Local filesystem (`~/.iflow/settings.json`) - User preferences
  - Format: JSON
  - Client: `JsonFileStore` (`src/shared/jsonFileStore.ts`)
  - Contents: selectedAuthType, modelName, baseUrl

**Caching:**
- In-memory conversation state via `ConversationStore` (`src/store/`)
- Mtime-based file caching for `~/.iflow/settings.json` to avoid redundant reads

## Authentication & Identity

**Auth Provider:**
- Hybrid (multiple supported):
  - **oauth-iflow** (OAuth 2.0 with PKCE) - Preferred when available
  - **iflow** (API-key) - Legacy fallback
  - **openai-compatible** - LLM endpoint auth
  - Custom external auth (determined by CLI)

**Implementation:**
- Auth happens through ACP RPC call: `protocol.sendRequest("authenticate", { methodId })`
- No local credential storage in extension (credentials managed by CLI)
- Settings repository stores only the selected auth type preference (not secrets)
- Authentication timeout: `iflow.oauthRequestTimeoutMs` (default 10 seconds)

**OAuth Client Configuration:**
- Client ID: `iflow.oauthClientId` (default "10009311001")
- Type: PKCE public client (no client secret)
- Managed by CLI, not extension

## Monitoring & Observability

**Error Tracking:**
- None detected. No Sentry, Honeycomb, or similar integration.

**Logs:**
- VS Code output channel: "IFlow" channel
- Logger implementation: `AppLogger` interface (`src/shared/logger.ts`)
- OutputChannelLogger adapter for VS Code integration
- Debug logging: Controllable via `iflow.debugLogging` setting
- Session updates logging: `iflow.debugSessionUpdateOnly` (show only ACP updates)

**Metrics/Usage Tracking:**
- Token usage extracted from ACP responses (no external tracking)
- Stored in memory during session (not sent externally)
- Implementation: `AcpUsageExtractor` (`src/acp/client/acpUsageExtractor.ts`)

## CI/CD & Deployment

**Hosting:**
- VS Code Marketplace (extension distribution)
- GitHub repository: `https://github.com/xsw632/iflow-for-vscode.git`

**CI Pipeline:**
- None detected in codebase (likely configured in GitHub Actions, not visible here)

**Build & Package:**
- `npm run compile` - Development build (webpack)
- `npm run package` - Production build (webpack with hidden source maps)
- `npm run vscode:prepublish` - Marketplace preparation

## Environment Configuration

**Required Extension Settings:**
```json
{
  "iflow.nodePath": "string | null",           // Node.js v22+ binary path
  "iflow.baseUrl": "string | null",             // OpenAI-compatible API endpoint override
  "iflow.oauthClientId": "string",              // Default: "10009311001"
  "iflow.oauthRequestTimeoutMs": "number",      // Default: 10000 (10 sec)
  "iflow.port": "number",                       // Default: 8090 (WebSocket server)
  "iflow.timeout": "number",                    // Default: 60000 (connection timeout)
  "iflow.enableCliStream": "boolean",           // Default: true (streaming chunks)
  "iflow.interactionTimeoutMs": "number",       // Default: 120000 (pending interactions)
  "iflow.maxFileBytes": "number",               // Default: 80000 (attachment size limit)
  "iflow.autoIncludeWorkspaceFiles": "boolean", // Default: false
  "iflow.workspaceFilesLimit": "number",        // Default: 80 (max files in context)
  "iflow.streamRenderIntervalMs": "number",     // Default: 50 (UI refresh cadence)
  "iflow.debugLogging": "boolean",              // Default: false
  "iflow.debugSessionUpdateOnly": "boolean",    // Default: false (ACP log filter)
  "iflow.subagentInactivityTimeoutMs": "number" // Default: 300000 (5 min, 0 to disable)
}
```

**Secrets Location:**
- No extension-managed secrets detected
- OAuth tokens and credentials managed entirely by iFlow CLI
- VS Code's built-in credential storage (via keychain/credential manager) not used by extension

## Webhooks & Callbacks

**Incoming:**
- None detected. Extension does not expose HTTP endpoints.

**Outgoing:**
- WebSocket bidirectional communication with iFlow CLI
  - RPC methods sent: `run`, `cancel`, `session/cancel`, `authenticate`
  - Notifications received: `stream/chunk`, `_iflow/*` (internal CLI events)

## File Change Review System

**Local Integration:**
- File snapshots captured before/after tool execution
- Diff generation via `diffService.ts` (`src/webview/fileChange/diffService.ts`)
- Temporary files created with token-based naming in VS Code's temp directory
- VS Code's built-in `vscode.diff` command invoked for visual diff display

## Process Management

**CLI Process Lifecycle:**
- iFlow CLI spawned as child process via Node.js `child_process.spawn`
- Port auto-discovery: Automatic unused port allocation or user-configured via `iflow.port`
- Startup signal detection: Monitors stdout for "WebSocket service on port" message
- Graceful shutdown: Process termination on extension deactivation
- Force kill timeout: 5 seconds (SIGTERM → SIGKILL)

**Node.js Discovery (Cross-Platform):**
- Auto-detection from iFlow CLI bin directory
- NVM, pnpm, Volta, fnm, npm-based installations scanned
- Windows specific: APPDATA paths, Program Files/nodejs
- Unix specific: Standard locations (/usr/local/bin, /opt/homebrew/bin, etc.)
- User override via `iflow.nodePath` setting (v22+ required)

---

*Integration audit: 2026-03-01*
