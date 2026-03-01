# External Integrations

**Analysis Date:** 2026-03-01

## APIs & External Services

**iFlow Platform (iflow.cn):**
- OAuth 2.0 Authorization Endpoint - Browser-based login (PKCE flow)
  - URL: `https://iflow.cn/oauth` (constant `OAUTH_AUTH_URL` in `src/authConstants.ts`)
  - Auth: None (public authorization endpoint)
- OAuth Token Endpoint - Token exchange and refresh
  - URL: `https://iflow.cn/oauth/token` (constant `OAUTH_TOKEN_URL` in `src/authConstants.ts`)
  - Auth: `client_id` + PKCE code verifier (public client, no client secret)
- User Info Endpoint - Fetches user profile after login
  - URL: `https://iflow.cn/api/oauth/getUserInfo` (constant `OAUTH_USERINFO_URL` in `src/authConstants.ts`)
  - Auth: `Authorization: Bearer <access_token>`
- OpenAI-compatible API (optional override) - LLM API for iFlow CLI
  - URL: Configurable via `iflow.baseUrl` VS Code setting (e.g. `https://apis.iflow.cn/v1`)
  - Auth: `apiKey` from OAuth user info, written to `~/.iflow/settings.json`
  - Implementation: `src/acp/settingsRepository.ts` (`updateBaseUrl` method)

**iFlow CLI (local subprocess):**
- Protocol: Custom ACP (Agent Communication Protocol) = WebSocket + JSON-RPC 2.0
- Transport: `ws://localhost:{port}/acp` (default port 8090, configurable via `iflow.port`)
- Launch args: `node {iflowScript} --experimental-acp --port {port} [--stream]`
- Implementation: `src/acpTransport.ts` (WebSocket), `src/acpProtocol.ts` (JSON-RPC 2.0), `src/processManager.ts` (subprocess lifecycle)

## Data Storage

**Databases:**
- None - No external database used

**Credential Storage:**
- VS Code `SecretStorage` API (primary) - Stores OAuth credentials as JSON under key `iflow.oauth.credentials.v1`
  - Implementation: `src/auth/credentialsStore.ts` (`AuthCredentialsStore`)
- Legacy file fallback - `~/.iflow/oauth_creds.json` (migrated to SecretStorage on first use, then deleted)
  - Migration: `AuthCredentialsStore.migrateLegacyCredentialsIfNeeded()`

**Settings File:**
- Local JSON file at `~/.iflow/settings.json` - Stores `apiKey`, `modelName`, `baseUrl`, `selectedAuthType`
  - Implementation: `src/acp/settingsRepository.ts` (`SettingsRepository`)
  - Written by: `src/auth/settingsStore.ts` (`AuthSettingsStore`)

**Conversation State:**
- VS Code `Memento` (globalState) - Persists conversation list and current conversation ID
  - Implementation: `src/store/conversationRepository.ts` (`ConversationRepository`)

**File Storage:**
- Local filesystem (workspace files only) - Read for file attachments; max size controlled by `iflow.maxFileBytes` (default 80,000 bytes)
  - Implementation: `src/webview/workspaceFileService.ts`

**Caching:**
- In-memory only (runtime state via `src/store/runtimeStateStore.ts`)

## Authentication & Identity

**Auth Provider:**
- iFlow Platform OAuth 2.0 (PKCE public client)
  - Implementation: `src/auth/pkceFlow.ts`, `src/authService.ts`
  - Flow: Extension starts local HTTP callback server on random port → opens browser to `iflow.cn/oauth` → receives auth code → exchanges for tokens → fetches user info → stores in SecretStorage
  - Client ID: `10009311001` (default, configurable via `iflow.oauthClientId`)
  - Token refresh: Automatic when within 24 hours of expiry (`TOKEN_REFRESH_THRESHOLD_MS = 24 * 60 * 60 * 1000`)
  - State validation: CSRF protection via random `state` parameter checked in callback
  - Callback: Local HTTP server on `http://localhost:{random-port}/oauth2callback` (timeout: 2 minutes)

## Monitoring & Observability

**Error Tracking:**
- None (no Sentry, Datadog, or similar)

**Logs:**
- VS Code Output Channel named "IFlow" - General extension logs via `src/shared/logger.ts` (`OutputChannelLogger`)
- VS Code Output Channel named "IFlow Auth" - Auth-specific logs via `src/authService.ts`
- Debug logging controlled by `iflow.debugLogging` (boolean, default `false`)
- Debug session-only logging controlled by `iflow.debugSessionUpdateOnly` (boolean)

## CI/CD & Deployment

**Hosting:**
- VS Code Marketplace (published as `.vsix` by `YauMike` publisher)
- GitHub repository: `https://github.com/xsw632/iflow-for-vscode`

**CI Pipeline:**
- Not detected (no `.github/workflows/` directory in project root)

## Environment Configuration

**Required at runtime:**
- iFlow CLI installed and discoverable in PATH (or `APPDATA` on Windows)
- Node.js v22+ available (auto-detected from iflow CLI location, or configured via `iflow.nodePath`)
- OAuth credentials (acquired via login flow; stored in VS Code SecretStorage)

**VS Code extension settings (iflow.*):**
- `iflow.nodePath` - Override Node.js executable path
- `iflow.baseUrl` - Override OpenAI-compatible API base URL
- `iflow.oauthClientId` - Override OAuth client ID (default: `10009311001`)
- `iflow.port` - ACP WebSocket port (default: `8090`)
- `iflow.timeout` - Connection timeout ms (default: `60000`)
- `iflow.enableCliStream` - Enable `--stream` flag for CLI (default: `true`)
- `iflow.interactionTimeoutMs` - Permission/question interaction timeout (default: `120000`)
- `iflow.maxFileBytes` - Max file attachment bytes (default: `80000`)
- `iflow.subagentInactivityTimeoutMs` - Subagent inactivity cancel timeout (default: `300000`)

**Secrets location:**
- VS Code `SecretStorage` (encrypted OS keychain via VS Code) — key `iflow.oauth.credentials.v1`
- `~/.iflow/settings.json` — API key written here for iFlow CLI consumption (plain text)

## Webhooks & Callbacks

**Incoming:**
- Local OAuth callback server on `http://localhost:{random-port}/oauth2callback` — temporary, created during login flow, torn down immediately after receiving auth code
  - Implementation: `src/authService.ts` (`startCallbackServer` method)

**Outgoing:**
- None (all communication is outbound HTTP/HTTPS requests to iflow.cn)

---

*Integration audit: 2026-03-01*
