# Testing Patterns

**Analysis Date:** 2026-03-01

## Test Framework

**Runner:**
- Mocha 11.7.4
- Config: Implicit (CLI-driven, see scripts below)
- UI: TDD style (`suite`, `test`)

**Assertion Library:**
- Node.js built-in `assert` module (strict mode)
- Common assertions: `assert.ok()`, `assert.strictEqual()`, `assert.deepStrictEqual()`

**Run Commands:**
```bash
npm run test:unit              # Run all unit tests
npm run test:coverage         # Run tests with coverage report
npm run lint                  # ESLint check
npm run pretest               # compile-tests + compile + lint
```

## Test File Organization

**Location:**
- Co-located in `src/test/` directory
- Separate from source by convention; could migrate to co-location with tests beside source

**Naming:**
- Pattern: `{module}.test.ts`
- Examples: `store.test.ts`, `acpClient.test.ts`, `chunkReducer.test.ts`

**Structure:**
```
src/test/
├── unit/
│   └── vscode-shim.js          # Mock vscode API for tests
├── *.test.ts                   # Unit test files
├── real*.test.ts               # Integration tests (real CLI)
└── realCliTestHelper.ts        # Shared test utilities
```

## Test Structure

**Suite Organization:**
```typescript
import * as assert from "assert";
import { ConversationStore } from "../store";

suite("ConversationStore", () => {
  test("loads saved conversation and preserves mode and model", () => {
    // Arrange
    const memento = new FakeMemento({ /* ... */ });
    const store = new ConversationStore(memento as any, () => {});
    
    // Act
    const conversation = store.getCurrentConversation();
    
    // Assert
    assert.ok(conversation);
    assert.strictEqual(conversation?.mode, "smart");
  });

  test("new conversation gets default model and mode", () => {
    // ...
  });
});
```

**Patterns:**
- Setup/Teardown: Use suite-level variables for shared fixtures; no `before()`/`after()` hooks observed
- Test isolation: Create fresh test doubles (FakeMemento, FakeTransport) per test
- Assertion pattern: Direct `assert.strictEqual()`, `assert.deepStrictEqual()`, `assert.ok()`
- Async tests: Return `Promise` from test function
  ```typescript
  test("async operation resolves", async () => {
    const result = await someAsyncOperation();
    assert.strictEqual(result, expected);
  });
  ```

## Mocking

**Framework:** Hand-crafted test doubles (no mocking library like Sinon)

**Patterns:**
```typescript
// Fake class implementing interface
class FakeTransport {
  connected = false;
  onClose: ((error?: Error) => void) | null = null;

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async send(): Promise<void> {}

  async receive(): Promise<string> {
    return new Promise<string>(() => {}); // blocks forever
  }
}
```

**VSCode Mock:** `test/unit/vscode-shim.js` patches `require('vscode')` globally
- Provides mock implementations of `workspace.getConfiguration()`, `window.createOutputChannel()`, etc.
- Allows tests to import vscode without actual VS Code context

**What to Mock:**
- External dependencies: Transport, Protocol, ProcessManager
- UI APIs: vscode.workspace, vscode.window
- Database/Storage: FakeMemento for state persistence
- Time-dependent code: Not observed, use real timers or explicit delays

**What NOT to Mock:**
- Pure reducer functions: Test with real input/output
- Business logic in service classes: Test actual behavior, not mocks
- Protocol parsing: Test real message transformation

## Fixtures and Factories

**Test Data:**
```typescript
// Helper function factories
function createAssistantMessage(): Message {
  return {
    id: "m1",
    role: "assistant",
    content: "",
    blocks: [],
    attachedFiles: [],
    timestamp: Date.now(),
  };
}

function getToolBlocks(message: Message): Array<Extract<OutputBlock, { type: "tool" }>> {
  return message.blocks.filter(
    (block): block is Extract<OutputBlock, { type: "tool" }> =>
      block.type === "tool",
  );
}

// Usage in test
test("tracks concurrent same-name tools by toolCallId", () => {
  let message = createAssistantMessage();
  message = applyChunkToMessage(message, { /* ... */ });
  const tools = getToolBlocks(message);
  assert.strictEqual(tools.length, 3);
});
```

**Location:**
- Helper functions defined in test file itself (not shared)
- No external fixture files; factories defined per test suite for clarity

## Coverage

**Requirements:** No strict coverage threshold enforced in CI

**View Coverage:**
```bash
npm run test:coverage
# Output: text report + JSON summary in coverage/coverage-summary.json
```

**Coverage Config:**
- Tool: c8 9.1.0
- Generates JSON and text reporters
- No .c8rc config file; defaults applied

## Test Types

**Unit Tests:**
- Scope: Individual functions, reducers, services
- Approach: Test pure functions with known inputs/outputs
- Examples:
  - `chunkReducer.test.ts` - pure reducer function `applyChunkToMessage()`
  - `errorUtils.test.ts` - classification and normalization functions
  - `questionPanelState.test.ts` - state machine transitions
- Setup: Fast, no async I/O, isolated test doubles

**Integration Tests:**
- Scope: Services with real ACP transport, session lifecycle
- Approach: Compose multiple modules, test end-to-end behavior
- Examples:
  - `acpClient.test.ts` - client lifecycle with FakeProtocol/FakeTransport
  - `sessionCoordinator.test.ts` - connection management across modules
  - `sendMessagePipeline.test.ts` - full message send workflow
- Setup: May use async operations, test doubles for external services

**E2E Tests:**
- Scope: Integration tests with real iFlow CLI
- Approach: Actual binary execution, real WebSocket connection
- Examples:
  - `realCliSmoke.test.ts` - basic CLI availability and echo
  - `realToolCallSmoke.test.ts` - tool invocation roundtrip
  - `realPlanModeSmoke.test.ts` - plan mode flow
- Run: `npm run test:real-cli` (requires CLI binary installed)
- Setup: Spawn real processes, open real sockets, slower tests

## Common Patterns

**Async Testing:**
```typescript
test("permission interaction resolves selected option", async () => {
  const bridge = new InteractionBridge(
    (chunk) => chunks.push(chunk.chunkType),
    (rawPath) => rawPath,
    () => {},
    { interactionTimeoutMs: 200 },
  );

  const protocol = new FakeProtocol();
  bridge.registerServerHandlers(protocol as never);

  const permissionPromise = protocol.invoke(
    "session/request_permission",
    100,
    { /* params */ },
  );

  await bridge.approveToolCall(100, "allow");

  const resolved = await permissionPromise;
  assert.deepStrictEqual(resolved, { outcome: { outcome: "selected", optionId: "allow-once" } });
});
```

**Error Testing:**
```typescript
test("classifyAppErrorCode detects missing session", () => {
  assert.strictEqual(
    classifyAppErrorCode('[JSON-RPC -32600] Invalid request (data: {"details":"Session not found: stale-1"})'),
    'MISSING_SESSION',
  );
});

test("normalizeErrorMessage falls back for empty Error message", () => {
  assert.strictEqual(
    normalizeErrorMessage(new Error(''), 'fallback'),
    'fallback',
  );
});
```

**Immutability Testing:**
```typescript
test("appendToAssistantMessage uses immutable updates and preserves previous snapshot", () => {
  const memento = new FakeMemento({ /* initial */ });
  const store = new ConversationStore(memento as any, () => {});
  store.newConversation();

  const oldSnapshot = store.getPersistedState();
  store.appendToAssistantMessage("", { chunkType: "text", content: "Hello" });
  const newSnapshot = store.getPersistedState();

  // State reference changed (immutable update)
  assert.notStrictEqual(oldSnapshot, newSnapshot);
  // But original preserved
  assert.strictEqual(oldSnapshot.conversations[0].messages[0].content, "");
});
```

**Callback Verification:**
```typescript
test("batchUpdate emits a single state change notification", () => {
  let notifyCount = 0;
  const store = new ConversationStore(memento as any, () => {
    notifyCount++;
  });
  
  store.batchUpdate(() => {
    store.newConversation();
    store.setModel("GPT-4");
    store.appendUserMessage("Hi");
  });

  // Single callback despite three mutations
  assert.strictEqual(notifyCount, 1);
});
```

## Test Execution Details

**Compilation:**
- TypeScript compiled before test: `npm run compile-tests`
- Output: `out/test/**/*.test.js` (CommonJS)
- Source maps enabled: `src/**/*.ts` maps to `out/**/*.js`

**VSCode Shim Loading:**
- Mocha runs with `--require ./test/unit/vscode-shim.js`
- Patches `require('vscode')` before any test module loads
- Allows all imports of vscode to resolve to mock

**Test Execution:**
- Mocha TDD UI: `suite()` and `test()` functions
- Sequential execution within suites
- All tests must pass for CI success

## Missing Test Coverage Areas

**Known gaps:**
- Webview rendering: No DOM tests (would need JSDOM/Puppeteer)
- Real E2E UI flows: No integration with actual VS Code UI
- Error edge cases: Some error paths untested in real failure scenarios
- Platform-specific: Windows path handling not fully exercised in test matrix

---

*Testing analysis: 2026-03-01*
