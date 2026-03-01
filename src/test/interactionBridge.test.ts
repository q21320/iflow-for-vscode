import * as assert from "assert";
import { InteractionBridge } from "../acp/interactionBridge";

class FakeProtocol {
  private handlers = new Map<
    string,
    (id: number, params: unknown) => Promise<unknown>
  >();

  onServerMethod(
    method: string,
    handler: (id: number, params: unknown) => Promise<unknown>,
  ): void {
    this.handlers.set(method, handler);
  }

  async invoke(method: string, id: number, params: unknown): Promise<unknown> {
    const handler = this.handlers.get(method);
    if (!handler) {
      throw new Error(`Missing handler for ${method}`);
    }
    return handler(id, params);
  }
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

suite("InteractionBridge", () => {
  test("permission interaction resolves selected option", async () => {
    const chunks: string[] = [];
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
      {
        options: [
          { optionId: "allow-once", kind: "allow_once" },
          { optionId: "allow-always", kind: "allow_always" },
        ],
        toolCall: {
          toolName: "write_file",
          title: "Write file",
          kind: "edit",
        },
      },
    );

    await bridge.approveToolCall(100, "allow");

    const resolved = await permissionPromise;
    assert.deepStrictEqual(resolved, {
      outcome: { outcome: "selected", optionId: "allow-once" },
    });
    assert.ok(chunks.includes("tool_confirmation"));
    assert.strictEqual(bridge.getPendingInteractionsForTests().size, 0);
  });

  test("permission interaction does not fall back to unknown option kinds", async () => {
    let resolvedValue: unknown = null;
    const bridge = new InteractionBridge(
      () => {},
      (rawPath) => rawPath,
      () => {},
      { interactionTimeoutMs: 200 },
    );

    const protocol = new FakeProtocol();
    bridge.registerServerHandlers(protocol as never);

    const permissionPromise = protocol.invoke(
      "session/request_permission",
      104,
      {
        options: [{ optionId: "custom-allow", kind: "allow_custom" }],
        toolCall: {
          toolName: "write_file",
          title: "Write file",
          kind: "edit",
        },
      },
    );

    await bridge.approveToolCall(104, "allow");
    resolvedValue = await permissionPromise;

    assert.deepStrictEqual(resolvedValue, {
      outcome: { outcome: "cancelled" },
    });
  });

  test("legacy question/plan bridges are disabled by default", async () => {
    const bridge = new InteractionBridge(
      () => {},
      (rawPath) => rawPath,
      () => {},
      { interactionTimeoutMs: 200 },
    );

    const protocol = new FakeProtocol();
    bridge.registerServerHandlers(protocol as never);

    await assert.rejects(
      protocol.invoke("_iflow/user/questions", 201, {}),
      /Missing handler/,
    );
    await assert.rejects(
      protocol.invoke("_iflow/plan/exit", 202, {}),
      /Missing handler/,
    );
  });

  test("question interaction times out and is cleaned up", async () => {
    const warnings: string[] = [];
    const bridge = new InteractionBridge(
      (chunk) => {
        if (chunk.chunkType === "warning") {
          warnings.push(chunk.message);
        }
      },
      (rawPath) => rawPath,
      () => {},
      {
        interactionTimeoutMs: 20,
        enableLegacyQuestionBridge: true,
      },
    );

    const protocol = new FakeProtocol();
    bridge.registerServerHandlers(protocol as never);

    const questionPromise = protocol.invoke("_iflow/user/questions", 101, {
      questions: [
        {
          question: "Proceed?",
          header: "Confirm",
          options: [{ label: "Yes", description: "continue" }],
          multiSelect: false,
        },
      ],
    });

    await wait(60);
    const resolved = await questionPromise;

    assert.deepStrictEqual(resolved, { answers: {} });
    assert.strictEqual(bridge.getPendingInteractionsForTests().size, 0);
    assert.ok(warnings.some((m) => m.includes("timed out")));
  });

  test("clearPendingInteractions cancels pending plan and clears timers", async () => {
    const bridge = new InteractionBridge(
      () => {},
      (rawPath) => rawPath,
      () => {},
      {
        interactionTimeoutMs: 5000,
        enableLegacyPlanExitBridge: true,
      },
    );

    const protocol = new FakeProtocol();
    bridge.registerServerHandlers(protocol as never);

    const planPromise = protocol.invoke("_iflow/plan/exit", 102, {
      plan: "test plan",
    });
    bridge.clearPendingInteractions("dispose");

    const resolved = await planPromise;
    assert.deepStrictEqual(resolved, { approved: false });
    assert.strictEqual(bridge.getPendingInteractionsForTests().size, 0);
  });

  test("duplicate response after consume is idempotent", async () => {
    const bridge = new InteractionBridge(
      () => {},
      (rawPath) => rawPath,
      () => {},
      { interactionTimeoutMs: 5000 },
    );

    const protocol = new FakeProtocol();
    bridge.registerServerHandlers(protocol as never);

    const permissionPromise = protocol.invoke(
      "session/request_permission",
      103,
      {
        options: [{ optionId: "allow-once", kind: "allow_once" }],
        toolCall: { toolName: "read_file" },
      },
    );

    await bridge.rejectToolCall(103);
    await bridge.approveToolCall(103, "allow");

    const resolved = await permissionPromise;
    assert.deepStrictEqual(resolved, { outcome: { outcome: "cancelled" } });
    assert.strictEqual(bridge.getPendingInteractionsForTests().size, 0);
  });

  test("permission times out with warning", async () => {
    const warnings: string[] = [];
    const bridge = new InteractionBridge(
      (chunk) => {
        if (chunk.chunkType === "warning") {
          warnings.push(chunk.message);
        }
      },
      (rawPath) => rawPath,
      () => {},
      { interactionTimeoutMs: 20 },
    );

    const protocol = new FakeProtocol();
    bridge.registerServerHandlers(protocol as never);

    const permissionPromise = protocol.invoke(
      "session/request_permission",
      200,
      {
        options: [{ optionId: "allow-once", kind: "allow_once" }],
        toolCall: { toolName: "write_file", title: "Write file" },
      },
    );

    await wait(60);
    const resolved = await permissionPromise;

    assert.deepStrictEqual(resolved, { outcome: { outcome: "cancelled" } });
    assert.ok(warnings.some((m) => m.includes("timed out")));
    assert.strictEqual(bridge.getPendingInteractionsForTests().size, 0);
  });

  test("approval after timeout is no-op", async () => {
    const bridge = new InteractionBridge(
      () => {},
      (rawPath) => rawPath,
      () => {},
      { interactionTimeoutMs: 20 },
    );

    const protocol = new FakeProtocol();
    bridge.registerServerHandlers(protocol as never);

    const permissionPromise = protocol.invoke(
      "session/request_permission",
      201,
      {
        options: [{ optionId: "allow-once", kind: "allow_once" }],
        toolCall: { toolName: "read_file" },
      },
    );

    await wait(60);
    await permissionPromise;

    // Should not throw
    await bridge.approveToolCall(201, "allow");
    assert.strictEqual(bridge.getPendingInteractionsForTests().size, 0);
  });

  test("clearPendingInteractions cancels permission", async () => {
    const bridge = new InteractionBridge(
      () => {},
      (rawPath) => rawPath,
      () => {},
      { interactionTimeoutMs: 5000 },
    );

    const protocol = new FakeProtocol();
    bridge.registerServerHandlers(protocol as never);

    const permissionPromise = protocol.invoke(
      "session/request_permission",
      202,
      {
        options: [{ optionId: "allow-once", kind: "allow_once" }],
        toolCall: { toolName: "bash" },
      },
    );

    bridge.clearPendingInteractions("session ended");

    const resolved = await permissionPromise;
    assert.deepStrictEqual(resolved, { outcome: { outcome: "cancelled" } });
    assert.strictEqual(bridge.getPendingInteractionsForTests().size, 0);
  });

  test("concurrent permissions tracked independently", async () => {
    const chunks: string[] = [];
    const bridge = new InteractionBridge(
      (chunk) => chunks.push(chunk.chunkType),
      (rawPath) => rawPath,
      () => {},
      { interactionTimeoutMs: 5000 },
    );

    const protocol = new FakeProtocol();
    bridge.registerServerHandlers(protocol as never);

    const perm1 = protocol.invoke("session/request_permission", 300, {
      options: [{ optionId: "allow-1", kind: "allow_once" }],
      toolCall: { toolName: "write_file" },
    });
    const perm2 = protocol.invoke("session/request_permission", 301, {
      options: [{ optionId: "allow-2", kind: "allow_once" }],
      toolCall: { toolName: "bash" },
    });

    assert.strictEqual(bridge.getPendingInteractionsForTests().size, 2);

    await bridge.approveToolCall(300, "allow");
    const resolved1 = await perm1;
    assert.deepStrictEqual(resolved1, {
      outcome: { outcome: "selected", optionId: "allow-1" },
    });

    await bridge.rejectToolCall(301);
    const resolved2 = await perm2;
    assert.deepStrictEqual(resolved2, { outcome: { outcome: "cancelled" } });

    assert.strictEqual(bridge.getPendingInteractionsForTests().size, 0);
  });

  test("tool_confirmation chunk has correct fields", async () => {
    const emittedChunks: Array<{ chunkType: string; [key: string]: unknown }> =
      [];
    const bridge = new InteractionBridge(
      (chunk) => emittedChunks.push(chunk as never),
      (rawPath) => rawPath,
      () => {},
      { interactionTimeoutMs: 5000 },
    );

    const protocol = new FakeProtocol();
    bridge.registerServerHandlers(protocol as never);

    const permPromise = protocol.invoke("session/request_permission", 400, {
      options: [{ optionId: "allow-once", kind: "allow_once" }],
      toolCall: {
        toolName: "write_file",
        title: "Writing /tmp/test.ts",
        kind: "edit",
      },
    });

    const confirmation = emittedChunks.find(
      (c) => c.chunkType === "tool_confirmation",
    );
    assert.ok(confirmation);
    assert.strictEqual(confirmation!.requestId, 400);
    assert.strictEqual(confirmation!.toolName, "write_file");
    assert.strictEqual(confirmation!.description, "Writing /tmp/test.ts");
    assert.strictEqual(confirmation!.confirmationType, "edit");

    await bridge.approveToolCall(400, "allow");
    await permPromise;
  });

  test("clearPendingInteractions handles mixed types", async () => {
    const bridge = new InteractionBridge(
      () => {},
      (rawPath) => rawPath,
      () => {},
      {
        interactionTimeoutMs: 5000,
        enableLegacyQuestionBridge: true,
        enableLegacyPlanExitBridge: true,
      },
    );

    const protocol = new FakeProtocol();
    bridge.registerServerHandlers(protocol as never);

    const permPromise = protocol.invoke("session/request_permission", 500, {
      options: [{ optionId: "allow-once", kind: "allow_once" }],
      toolCall: { toolName: "bash" },
    });
    const questionPromise = protocol.invoke("_iflow/user/questions", 501, {
      questions: [
        { question: "Ok?", header: "Q", options: [], multiSelect: false },
      ],
    });
    const planPromise = protocol.invoke("_iflow/plan/exit", 502, {
      plan: "test",
    });

    assert.strictEqual(bridge.getPendingInteractionsForTests().size, 3);

    bridge.clearPendingInteractions("dispose");

    const [permResult, questionResult, planResult] = await Promise.all([
      permPromise,
      questionPromise,
      planPromise,
    ]);

    assert.deepStrictEqual(permResult, { outcome: { outcome: "cancelled" } });
    assert.deepStrictEqual(questionResult, { answers: {} });
    assert.deepStrictEqual(planResult, { approved: false });
    assert.strictEqual(bridge.getPendingInteractionsForTests().size, 0);
  });
});
