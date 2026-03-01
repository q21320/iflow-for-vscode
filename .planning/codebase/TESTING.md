# Testing Patterns

**Analysis Date:** 2026-03-01

## Test Framework

**Runner:**
- Mocha `^11.7.4` with TDD UI (`--ui tdd`)
- Config: no separate mocha config file — arguments passed directly in `package.json` scripts

**Assertion Library:**
- Node.js built-in `assert` module, imported as `import * as assert from 'assert'`
- Uses strict-mode assertions: `assert.strictEqual`, `assert.deepStrictEqual`, `assert.ok`, `assert.rejects`

**Coverage:**
- Tool: `c8 ^9.1.0`
- Current overall coverage: **76.53% lines / 73.02% functions / 75.86% branches**

**Run Commands:**
```bash
npm run test:unit          # Compile + run all unit tests
npm run test:coverage      # Compile + run with c8 coverage report
npm run coverage:check     # Run coverage and enforce threshold
npm run test:real-cli      # Run real CLI integration smoke tests (requires live CLI)
```

## Test File Organization

**Location:** All unit test files live in `src/test/` (separate directory, not co-located)

**Naming:** `<subjectName>.test.ts` matching the source file name:
- `src/acp/interactionBridge.ts` → `src/test/interactionBridge.test.ts`
- `src/store/chunkReducer.ts` → `src/test/chunkReducer.test.ts`
- `src/acp/sessionCoordinator.ts` → `src/test/sessionCoordinator.test.ts`

**Compiled Output:** Tests compiled from `src/test/*.test.ts` to `out/test/*.test.js` via `tsc`

**Structure:**
```
src/test/
  acpClient.test.ts
  acpProtocol.test.ts
  acpTransport.test.ts
  authService.test.ts
  chunkMapper.test.ts
  chunkReducer.test.ts
  cliDiscovery.test.ts
  errorUtils.test.ts
  extension.test.ts
  fileChangeReviewService.test.ts
  inactivityGuard.test.ts
  interactionBridge.test.ts
  markdownUrlPolicy.test.ts
  messageRouter.test.ts
  pathPolicy.test.ts
  processManager.test.ts
  questionPanelState.test.ts
  realCliSmoke.test.ts          # Real CLI integration (guarded by env var)
  realPlanModeSmoke.test.ts     # Real CLI plan mode smoke
  realToolCallSmoke.test.ts     # Real CLI tool call smoke
  runtimeConfigApplier.test.ts
  runtimeStateSource.test.ts
  sendMessagePipeline.test.ts
  sessionCoordinator.test.ts
  store.test.ts
  streamStatusUtils.test.ts
  subagentProgressTracker.test.ts
  thinkingParser.test.ts
  toolChunkMapper.test.ts
  visualUpdateScheduler.test.ts
  websocket.test.ts
  webviewHandler.test.ts

test/unit/
  vscode-shim.js             # Module interception shim for vscode API
```

## Test Structure

**Suite Organization (TDD UI):**
```typescript
import * as assert from 'assert';
import { SubjectClass } from '../path/to/subject';

suite('SubjectClass', () => {
  let instance: SubjectClass;

  setup(() => {
    instance = new SubjectClass(/* minimal args */);
  });

  teardown(() => {
    instance.stop();  // cleanup timers, connections, etc.
  });

  test('does X when Y', () => {
    // arrange
    // act
    // assert
    assert.strictEqual(actual, expected);
  });

  test('handles async scenario', async () => {
    await assert.rejects(
      instance.someAsyncMethod(),
      /expected error pattern/,
    );
  });
});
```

**Lifecycle hooks used:**
- `setup()` — initialize shared test state before each test
- `teardown()` — clean up resources (stop guards, disconnect transports) after each test
- No `suiteSetup`/`suiteTeardown` observed

**Test naming convention:** Descriptive imperative sentences:
- `'establishes connection and reaches ready state'`
- `'reuses connection for same cwd and loads requested session'`
- `'triggers after timeout when running'`
- `'immutability preserved'`

## Mocking

**Framework:** No mock library — all fakes are hand-written inline classes within the test file.

**Pattern — Fake Classes:**
All collaborators are replaced with minimal hand-written `Fake*` classes that implement the same interface shape:

```typescript
class FakeTransport {
  connected = false;
  connectCalls = 0;
  disconnectCalls = 0;
  lastConnectUrl: string | null = null;
  onClose: ((error?: Error) => void) | null = null;

  async connect(options?: { url: string }): Promise<void> {
    this.connected = true;
    this.connectCalls += 1;
    this.lastConnectUrl = options?.url ?? null;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.disconnectCalls += 1;
  }

  triggerClose(error?: Error): void {
    this.connected = false;
    this.onClose?.(error);
  }

  async send(): Promise<void> {}
  async receive(): Promise<string> {
    return new Promise<string>(() => {});  // blocks forever in tests
  }
}
```

**Pattern — Controllable Behavior:**
Fake objects expose configurable state to control test scenarios:
```typescript
class FakeProtocol {
  failOnMethod: string | null = null;
  failAuthMethodId: string | null = null;
  initializeResult: { isAuthenticated?: boolean; authMethods?: ... } = { isAuthenticated: false };

  async sendRequest(method: string, params?: unknown): Promise<unknown> {
    if (this.failOnMethod && method === this.failOnMethod) {
      throw new Error(`forced failure on ${method}`);
    }
    switch (method) {
      case 'initialize': return this.initializeResult;
      // ...
    }
  }
}
```

**Pattern — Call Tracking:**
Fakes record calls for assertion:
```typescript
class FakeClient {
  runCalls: RunOptions[] = [];

  async run(options: RunOptions, ...): Promise<string | undefined> {
    this.runCalls.push(options);
    // ...
  }
}
```

**vscode API shim:**
The `test/unit/vscode-shim.js` file patches `Module._load` to intercept `require('vscode')` calls and return a mock object. This allows all extension host code that imports `vscode` to run in plain Node.js:
```javascript
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') {
    return mockVscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};
```

**What to Mock:**
- External I/O: transports, protocols, process managers
- VS Code APIs: use the shim for the full `vscode` module
- Time-dependent behavior: use short timeout values (`interactionTimeoutMs: 20`)

**What NOT to Mock:**
- Pure functions and reducers: test directly (`applyChunkToMessage`, `classifyAppErrorCode`)
- Data transformation logic: test with real implementations

## Fixtures and Factories

**Test Data Factories:**
Named factory functions defined at the top of each test file:
```typescript
function createAssistantMessage(): Message {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    blocks: [],
    attachedFiles: [],
    timestamp: Date.now(),
  };
}

function baseRunOptions(overrides: Partial<RunOptions> = {}): RunOptions {
  return {
    prompt: 'hello',
    attachedFiles: [],
    mode: 'default',
    think: false,
    model: 'GLM-4.7',
    cwd: '/tmp/workspace-a',
    ...overrides,
  };
}
```

**Helper functions for repeated sequences:**
```typescript
function applyChunks(message: Message, chunks: StreamChunk[]): Message {
  let result = message;
  for (const chunk of chunks) {
    result = applyChunkToMessage(result, chunk);
  }
  return result;
}
```

**Location:** Fixtures are defined inline at the top of each test file — no shared fixture directory.

## Coverage

**Current Coverage (latest run):**
- Lines: **76.53%** (target appears to be 80% based on `npm run coverage:check`)
- Functions: **73.02%**
- Branches: **75.86%**

**Well-covered modules (>90%):**
- `src/acp/inactivityGuard.ts`: 100%
- `src/store/chunkReducer.ts`: ~95% (via chunkReducer.test.ts)
- `src/acp/sessionCoordinator.ts`: 95.18%
- `src/acpTransport.ts`: 93.46%
- `src/streamStatusUtils.ts`: 97.36%

**Under-covered modules (<50%):**
- `src/auth/credentialsStore.ts`: 25% lines
- `src/auth/settingsStore.ts`: 19.64% lines
- `src/acp/debugLogger.ts`: 36% lines
- `src/cliDiscovery.ts`: 33.67% lines

**View Coverage:**
```bash
npm run test:coverage      # Prints text summary + writes coverage/coverage-summary.json
```

## Test Types

**Unit Tests (all in `src/test/`):**
- Pure logic: `chunkReducer.test.ts`, `errorUtils.test.ts`, `toolChunkMapper.test.ts`
- Class behavior with fakes: `sessionCoordinator.test.ts`, `interactionBridge.test.ts`, `sendMessagePipeline.test.ts`
- Timing/async: `inactivityGuard.test.ts`, `visualUpdateScheduler.test.ts`
- Protocol parsing: `acpProtocol.test.ts`, `acpTransport.test.ts`

**Integration/Smoke Tests:**
- `src/test/realCliSmoke.test.ts` — full ACP round-trip with real CLI process
- `src/test/realPlanModeSmoke.test.ts` — plan mode flow with real CLI
- `src/test/realToolCallSmoke.test.ts` — tool call flow with real CLI
- Run via `npm run test:real-cli` (requires CLI installed and running)

**E2E Tests:**
- No browser/UI E2E framework used
- Smoke tests via `scripts/plan-mode-e2e-test.mjs` and `scripts/tool-call-e2e-test.mjs` — node scripts that invoke the ACP protocol directly against a live CLI

## Common Patterns

**Async Testing:**
```typescript
test('handles async error', async () => {
  await assert.rejects(
    coordinator.ensureConnected(baseRunOptions()),
    /Session coordinator is disposed/,
  );
});

// Timer-based: use short timeouts + wait helper
function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('triggers after timeout', async () => {
  guard.start(() => true);
  await wait(80);
  assert.strictEqual(triggered, true);
});
```

**Error Testing:**
```typescript
// Assert error is thrown
await assert.rejects(
  coordinator.ensureConnected(baseRunOptions()),
  /forced failure on session\/new/,
);

// Assert error does NOT propagate (no-op)
assert.doesNotThrow(() => guard.markActivity(null));
```

**State Mutation Verification:**
```typescript
// Immutability: freeze original, verify new object returned
Object.freeze(original);
Object.freeze(original.blocks);
const updated = applyChunkToMessage(original, chunk);
assert.notStrictEqual(updated, original);
assert.strictEqual(original.blocks.length, 0);  // unchanged
assert.strictEqual(updated.blocks.length, 1);   // new copy changed
```

**Testing Discriminated Unions:**
```typescript
// Filter by type, then cast
const phases = messages
  .filter((m): m is Extract<ExtensionMessage, { type: 'streamStatus' }> => m.type === 'streamStatus')
  .map((m) => m.phase);
assert.deepStrictEqual(phases, ['preparing', 'connecting', 'waiting_first_chunk']);
```

**Test Hooks for Internal State:**
Some classes expose test-only methods marked with comments:
```typescript
// Backward-compat test hook.
getPendingInteractionsForTests(): Map<number, PendingInteraction> {
  return this.pendingInteractions;
}
```
These are used directly in tests: `assert.strictEqual(bridge.getPendingInteractionsForTests().size, 0)`

---

*Testing analysis: 2026-03-01*
