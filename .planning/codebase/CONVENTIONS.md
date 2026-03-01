# Coding Conventions

**Analysis Date:** 2026-03-01

## Naming Patterns

**Files:**
- `camelCase.ts` for modules: `acpClientFacade.ts`, `chunkReducer.ts`, `interactionBridge.ts`
- `camelCase.ts` for utilities: `typeGuards.ts`, `errorBoundary.ts`, `visualUpdateScheduler.ts`
- `PascalCase` class names match file names: `SessionCoordinator` in `sessionCoordinator.ts`
- Test files: `<subjectName>.test.ts` in `src/test/`

**Classes:**
- PascalCase: `AcpClient`, `SessionCoordinator`, `InteractionBridge`, `OutputChannelLogger`
- Suffix pattern for role clarity: `*Facade`, `*Executor`, `*Router`, `*Mapper`, `*Reducer`, `*Coordinator`
- Fake/stub classes in tests prefixed with `Fake`: `FakeTransport`, `FakeProtocol`, `FakeMemento`

**Functions:**
- camelCase: `applyChunkToMessage`, `normalizeErrorMessage`, `classifyAppErrorCode`
- Private helpers prefixed with nothing (no underscore), just declared `private`
- Factory/builder functions: `createAssistantMessage()`, `createStore()`, `createGuard()`
- Helper functions for test data named `create*` or `base*`

**Variables:**
- camelCase: `pendingInteractions`, `timeoutHandles`, `connectionSnapshot`
- Constants: `SCREAMING_SNAKE_CASE` for module-level constants: `DEFAULT_INTERACTION_TIMEOUT_MS`, `INITIAL_CONNECTION_SNAPSHOT`
- Numeric literal separators: `120_000` (underscore separators for large numbers)

**Types and Interfaces:**
- PascalCase: `StreamChunk`, `OutputBlock`, `ConnectionSnapshot`
- Discriminated unions use string literal `type` or `chunkType` fields
- Interface suffix: no `I` prefix — just `LogContext`, `AppLogger`, `ErrorMapper`
- Options interfaces suffixed with `Options`: `InteractionBridgeOptions`, `OutputChannelLoggerOptions`
- Dependencies object interfaces suffixed with `Dependencies`: `SessionCoordinatorDependencies`, `ConversationServiceDependencies`

**Enum-like Constants:**
- Union string types preferred over TypeScript enums:
  ```typescript
  export type AppErrorCode = 'UNKNOWN' | 'MISSING_SESSION' | 'CLI_UNAVAILABLE' | ...
  export type StreamStatusPhase = 'preparing' | 'connecting' | 'waiting_first_chunk';
  ```

## Code Style

**Formatting:**
- No Prettier config detected — formatting enforced manually
- 2-space indentation (observed uniformly across all source files)
- Trailing commas in multi-line object/array literals
- Single quotes for strings in most files; some files mix with double quotes

**Linting:**
- Tool: ESLint with `typescript-eslint`, config at `eslint.config.mjs`
- Key rules enabled:
  - `@typescript-eslint/naming-convention`: imports must be camelCase or PascalCase
  - `curly`: warn — all control flow must use braces
  - `eqeqeq`: warn — strict equality (`===`) required
  - `no-throw-literal`: warn — only Error objects may be thrown
  - `semi`: warn — semicolons required

**TypeScript Settings:**
- `strict: true` in `tsconfig.json`
- Target `ES2022`, module `Node16`
- `rootDir: src`, `outDir: out`

## Import Organization

**Order (observed pattern):**
1. Node.js built-ins as namespace imports: `import * as fs from 'fs'`
2. Third-party packages: `import * as vscode from 'vscode'`
3. Internal imports: `import { ... } from '../protocol'`
4. Sibling imports: `import { ... } from './types'`

**Path Aliases:**
- None defined — all imports use relative paths

**Namespace Imports:**
- Node built-ins always imported as namespaces: `import * as fs from 'fs'`, `import * as path from 'path'`
- VSCode API: `import * as vscode from 'vscode'`
- Standard library (`assert`) in tests: `import * as assert from 'assert'`
- Application code uses named imports: `import { AppError, toAppError } from '../errorUtils'`

## Error Handling

**Patterns:**
- Classify errors into `AppErrorCode` using `classifyAppErrorCode()` in `src/errorUtils.ts`
- Wrap all errors into `AppError` via `toAppError()` before propagating
- Map errors for webview display using `DefaultErrorMapper.normalizeForWebview()` in `src/shared/errorBoundary.ts`
- Always check `err instanceof Error` before accessing `.message`:
  ```typescript
  const message = err instanceof Error ? err.message : String(err);
  ```
- Async server handlers wrap in try/catch and return `{ error: message }` objects (never throw):
  ```typescript
  try {
    // ...
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    this.log(`fs/read_text_file failed: ${message}`);
    return { error: message };
  }
  ```
- Errors in cancelled interactions are caught and logged (never re-thrown from `resolveCancelled`)

## Immutability

**Core convention: never mutate existing objects — always return new copies.**

This is enforced throughout `src/store/chunkReducer.ts` (pure reducer):
```typescript
// Always spread to create new object
const blocks = [...message.blocks];
blocks[idx] = { ...current, content: current.content + chunk.content };
return { ...message, blocks };
```

Conversation mutations (`src/store/conversationMutations.ts`) use the same pattern:
```typescript
const conversations = [...state.conversations];
conversations[index] = updated;
return { nextState: { ...state, conversations } as TState, updatedConversation: updated };
```

Test for immutability: `chunkReducer.test.ts` explicitly freezes objects and verifies no mutation:
```typescript
Object.freeze(original);
Object.freeze(original.blocks);
const updated = applyChunkToMessage(original, chunk);
assert.notStrictEqual(updated, original);
```

## Logging

**Framework:** Custom `AppLogger` interface defined at `src/shared/logger.ts`

**Interface:**
```typescript
interface AppLogger {
  child(context: Partial<LogContext>): AppLogger;
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, error?: unknown, extra?: Record<string, unknown>): void;
}
```

**Implementation:** `OutputChannelLogger` — logs to VS Code output channel with format:
`[ISO_TIMESTAMP] [LEVEL] [COMPONENT] message {extra_json}`

**Pattern:** Pass logger as constructor dependency (injection), create child loggers with context:
```typescript
constructor(private readonly log: (message: string) => void) {}
// or for AppLogger
this.logger = logger.child({ component: 'SessionCoordinator' });
```

**Debug logging:** Gated by config `iflow.debugLogging` — use `logger.debug()` for verbose traces.

## Comments

**When to Comment:**
- Protocol-level comments for non-obvious behaviors: `// Some ACP runtimes emit an early anonymous start...`
- Section dividers in test files: `// ── Integration: mapper + reducer ──────────────────────────────`
- Brief JSDoc only on public API functions: `/** Read a vscode config value with fallback. */`
- Test hooks annotated: `// Backward-compat test hook.`

**JSDoc/TSDoc:**
- Minimal — used only on exported public-facing functions
- No `@param` / `@returns` annotations in the observed code

## Function Design

**Size:** Functions kept short (<50 lines). Private helper functions extracted for lookup operations:
```typescript
function findToolBlockIndexByCallId(blocks: OutputBlock[], toolCallId: string): number { ... }
function findLatestRunningAnonymousToolIndexByName(blocks: OutputBlock[], toolName: string): number { ... }
```

**Parameters:** Dependencies injected via constructor options objects (`deps` pattern):
```typescript
constructor(private readonly deps: SessionCoordinatorDependencies) {}
```
Single-object `options` param for optional configuration:
```typescript
constructor(..., options: InteractionBridgeOptions = {}) {
  this.interactionTimeoutMs = options.interactionTimeoutMs ?? 120_000;
}
```

**Return Values:**
- Discriminated union types for results
- Return `null` (not `undefined`) for absent values: `currentSessionId: string | null`
- Mutation operations return `void`; query operations return typed results

## Module Design

**Exports:**
- Named exports only — no default exports anywhere in the codebase
- Classes exported: `export class SessionCoordinator { ... }`
- Functions exported: `export function applyChunkToMessage(...) { ... }`

**Barrel Files:**
- Old single-file entry points kept as barrel re-exports for backward compatibility:
  - `src/acpClient.ts` re-exports from `src/acp/client/acpClientFacade.ts`
  - `src/protocol.ts` re-exports from `src/protocol/index.ts`
  - `src/chunkMapper.ts` re-exports from `src/chunkMapper/index.ts`
  - `src/store.ts` re-exports from `src/store/` sub-modules

**Types Files:**
- Each major subdirectory has a `types.ts` for domain-specific types: `src/acp/types.ts`, `src/store/storeTypes.ts`, `src/chunkMapper/types.ts`
- Cross-cutting protocol types live in `src/protocol/` with `index.ts` barrel

---

*Convention analysis: 2026-03-01*
