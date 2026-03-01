# Coding Conventions

**Analysis Date:** 2026-03-01

## Naming Patterns

**Files:**
- Kebab-case for files: `session-coordinator.ts`, `chunk-reducer.ts`
- Controllers, services, and utilities use descriptive compound names: `interactionBridge.ts`, `acpClientFacade.ts`
- Test files colocate with source: `*.test.ts` adjacent to source in `src/test/`
- Type definition files: `types.ts`, `panelTypes.ts`, `storeTypes.ts`

**Functions:**
- camelCase for all function declarations and exports
- Private helper functions: `findLastBlockIndex()`, `copyBlocks()`, `getConfig()`
- Public methods in classes use camelCase: `getCurrentConversation()`, `appendToAssistantMessage()`
- Helper functions precede usage in file (bottom-up organization)

**Variables:**
- camelCase for local variables: `message`, `blocks`, `sessionId`
- UPPER_SNAKE_CASE for constants: `DEFAULT_INTERACTION_TIMEOUT_MS`, `EMPTY_MCP_SERVERS`
- Prefix booleans with `is`, `has`, `can`, `should`: `isConnected`, `hasProcess`, `canApprove`
- Private class fields prefixed with underscore: `_load`, `_handlers`, `_socket`

**Types:**
- PascalCase for all type names: `Message`, `StreamChunk`, `OutputBlock`, `ConnectionSnapshot`
- Interface names describe contract without `I` prefix: `SessionCoordinatorDependencies`, `AppLogger`
- Type aliases for unions/tuples: `LogLevel = 'debug' | 'info' | 'warn' | 'error'`
- Discriminated union types use literal `type` field: `type: "tool" | "text" | "code"`

## Code Style

**Formatting:**
- Configured via ESLint (eslint.config.mjs)
- 2-space indentation (standard for TypeScript in this project)
- Semicolons required (ESLint rule: `semi: "warn"`)
- Curly braces required on all blocks (ESLint rule: `curly: "warn"`)
- Line length: No strict limit, but prefer readability

**Linting:**
- Tool: ESLint 9.39.2 with typescript-eslint
- Config: `eslint.config.mjs` in project root
- Key rules:
  - `@typescript-eslint/naming-convention`: Enforces camelCase for imports, PascalCase for classes
  - `curly`: Requires braces on control structures
  - `eqeqeq`: Requires `===` and `!==` (warn)
  - `no-throw-literal`: Prevents throwing non-Error objects (warn)
- Run: `npm run lint` checks `src/**/*.ts`

## Import Organization

**Order:**
1. Standard library/framework imports: `import * as assert from "assert"`
2. Third-party packages: `import * as vscode from "vscode"`, `import type { SomeType } from "ws"`
3. Internal absolute imports: `import { Message } from "../protocol"`
4. Internal relative imports: `import { ChunkMapper } from "../../chunkMapper"`

**Path Aliases:**
- No path aliases configured; all imports are relative
- Use dot-relative paths: `"../protocol"`, `"../../shared/logger"`

**Conventions:**
- Namespace imports for side effects or re-exports: `import * as assert from "assert"`
- Type imports use `import type` when importing only types
- Re-exports in index files: barrel files like `src/protocol/index.ts` group related types
- Unused imports must be removed (no dead code in imports)

## Error Handling

**Patterns:**
- Custom `AppError` class defined in `src/errorUtils.ts` with typed error codes
- Error codes: `'UNKNOWN'`, `'MISSING_SESSION'`, `'CLI_UNAVAILABLE'`, `'VALIDATION_FAILED'`, `'JSON_RPC_ERROR'`, `'IO_ERROR'`, `'SECURITY_DENIED'`, `'TIMEOUT'`
- Always use `normalizeErrorMessage()` function to extract human-readable messages from any value
- Always use `toAppError()` to classify and wrap errors: `const err = toAppError(caughtValue)`
- Error handling pattern:
  ```typescript
  try {
    // operation
  } catch (err) {
    const appErr = toAppError(err, 'Operation failed');
    logger.error('Detailed context', appErr);
    // Handle based on appErr.code
  }
  ```
- Never throw raw strings or non-Error objects; throw `AppError` instances
- Provide `cause` field for error chaining: `new AppError(msg, { code: 'X', cause: originalError })`

## Logging

**Framework:** Custom `AppLogger` interface in `src/shared/logger.ts`

**Patterns:**
- All logging uses injected `AppLogger` interface (not `console`)
- Logger methods: `debug()`, `info()`, `warn()`, `error()`
- Create child loggers with context: `logger.child({ component: 'SessionCoordinator', sessionId })`
- Log structure: `logger.method(message, optionalExtra)`
- Error logging always includes error object: `logger.error('Failed to fetch', error, { extra })`
- Debug logs only emit when `getDebugLoggingEnabled()` returns true
- Output uses ISO timestamp + level + component name: `[2026-03-01T12:00:00.000Z] [INFO] [ComponentName] message`

## Comments

**When to Comment:**
- Document WHY, not WHAT (code should be self-documenting)
- Use comments for non-obvious business logic or workarounds
- Prefix temporary workarounds with `TODO`, `FIXME`, `HACK`, `XXX`
- Example comment style:
  ```typescript
  // Backward-compat test hook for test setup
  setConnectionForTests(...) { }
  ```

**JSDoc/TSDoc:**
- Used sparingly on public APIs and complex functions
- File headers describe module purpose (comment block at top of file):
  ```typescript
  // SessionCoordinator: Connection lifecycle management and state transitions.
  ```
- Function-level JSDoc on facade methods:
  ```typescript
  /** Read a vscode config value with fallback. */
  function getConfig<T>(key: string, defaultValue: T): T { }
  ```
- No excessive JSDoc on private methods or obvious code

## Function Design

**Size:**
- Target: 50 lines maximum for most functions
- Complex reducers allowed up to ~100 lines if single responsibility
- Extracted helper functions in same file if not reusable elsewhere
- Examples:
  - `findLastBlockIndex()`: 8 lines
  - `applyChunkToMessage()`: ~150 lines (large reducer, acceptable for single domain task)
  - `appendToAssistantMessage()`: ~50 lines

**Parameters:**
- Prefer 3-5 parameters; use config objects for >3 parameters
- Example: `constructor(deps: SessionCoordinatorDependencies)` vs `constructor(a, b, c, d, e, f)`
- Callback parameters usually last: `function start(config, onComplete, onError)`

**Return Values:**
- Explicitly type all return values (no implicit `any`)
- Return immutable copies for state mutations: `{ nextState, updatedConversation }`
- Void-returning functions use `void` type annotation
- Nullable returns use union: `Conversation | null` not `Conversation | undefined`

## Module Design

**Exports:**
- Only export public APIs; keep internal helpers private (not exported)
- One primary export per file when possible (class or factory)
- Named exports for utilities and pure functions: `export function createConversationId()`
- Re-export from index files to create logical API surfaces:
  ```typescript
  // src/protocol/index.ts
  export * from './conversation';
  export * from './stream';
  ```

**Barrel Files:**
- Used in `src/protocol/`, `src/acp/client/`, `src/chunkMapper/` for bundling related exports
- Allows downstream imports: `import { Message } from '../protocol'` vs `import { Message } from '../protocol/conversation'`
- Index files must not contain logic, only re-exports

**Immutability:**
- All state mutations use spread operators to create new objects
- Example pattern in `applyChunkToMessage()`:
  ```typescript
  const blocks = copyBlocks(message);
  blocks[idx] = { ...current, content: current.content + chunk.content };
  return { ...message, blocks, content: message.content + chunk.content };
  ```
- No in-place mutations of objects from parameters or state
- Array mutations use `.push()`, `.filter()`, `.map()` on copies: `[...array]`

## Type Guards

**Centralized Location:** `src/shared/typeGuards.ts`

**Pattern:**
- Single type guard function: `isObject(value: unknown): value is Record<string, unknown>`
- Used in discriminated unions: `if (block.type === "tool")`
- No per-file type guards; all centralized in shared module
- Usage: `isObject(someValue)` to test before property access

## File Structure

**Max File Size:** 500 lines for source files (test files exempt)
- Larger modules decompose into subdirectories with clear separation
- Example: `src/acp/client/` splits `AcpClient` into:
  - `acpClientFacade.ts` (public API)
  - `acpRunExecutor.ts` (run/cancel logic)
  - `acpNotificationRouter.ts` (notification dispatch)
  - `acpUsageExtractor.ts` (token usage)

**Directory Organization:**
- By feature/domain: `src/acp/`, `src/store/`, `src/webview/`, `src/protocol/`
- Horizontal slicing by function: Types in `types.ts`, implementations in domain files
- Test files colocate: `src/test/` directory with `*.test.ts` files matching source structure

---

*Convention analysis: 2026-03-01*
