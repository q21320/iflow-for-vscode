import * as assert from "assert";
import { Message, OutputBlock, StreamChunk } from "../protocol";
import { applyChunkToMessage } from "../store/chunkReducer";
import { ToolChunkMapper } from "../chunkMapper/toolChunkMapper";

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

function getToolBlocks(
  message: Message,
): Array<Extract<OutputBlock, { type: "tool" }>> {
  return message.blocks.filter(
    (block): block is Extract<OutputBlock, { type: "tool" }> =>
      block.type === "tool",
  );
}

function applyChunks(message: Message, chunks: StreamChunk[]): Message {
  let result = message;
  for (const chunk of chunks) {
    result = applyChunkToMessage(result, chunk);
  }
  return result;
}

suite("chunkReducer", () => {
  test("tracks concurrent same-name tools by toolCallId", () => {
    let message = createAssistantMessage();

    message = applyChunkToMessage(message, {
      chunkType: "tool_start",
      name: "read_file",
      toolCallId: "call-1",
      input: { file_path: "/tmp/index.html" },
      label: "index.html",
    });
    message = applyChunkToMessage(message, {
      chunkType: "tool_start",
      name: "read_file",
      toolCallId: "call-2",
      input: { file_path: "/tmp/game.js" },
      label: "game.js",
    });
    message = applyChunkToMessage(message, {
      chunkType: "tool_start",
      name: "read_file",
      toolCallId: "call-3",
      input: { file_path: "/tmp/style.css" },
      label: "style.css",
    });

    let tools = getToolBlocks(message);
    assert.strictEqual(tools.length, 3);
    assert.strictEqual(tools[0].input.file_path, "/tmp/index.html");
    assert.strictEqual(tools[1].input.file_path, "/tmp/game.js");
    assert.strictEqual(tools[2].input.file_path, "/tmp/style.css");

    message = applyChunkToMessage(message, {
      chunkType: "tool_start",
      name: "read_file",
      toolCallId: "call-1",
      input: {},
    });
    message = applyChunkToMessage(message, {
      chunkType: "tool_output",
      toolCallId: "call-1",
      content: "Read all 51 lines from index.html",
    });
    message = applyChunkToMessage(message, {
      chunkType: "tool_end",
      toolCallId: "call-1",
      status: "completed",
    });

    tools = getToolBlocks(message);
    const call1 = tools.find((tool) => tool.toolCallId === "call-1");
    const call2 = tools.find((tool) => tool.toolCallId === "call-2");
    const call3 = tools.find((tool) => tool.toolCallId === "call-3");
    assert.ok(call1);
    assert.ok(call2);
    assert.ok(call3);
    assert.strictEqual(call1?.status, "completed");
    assert.ok(call1?.output.includes("index.html"));
    assert.strictEqual(call2?.status, "running");
    assert.strictEqual(call3?.status, "running");

    message = applyChunkToMessage(message, {
      chunkType: "tool_start",
      name: "read_file",
      toolCallId: "call-2",
      input: {},
    });
    message = applyChunkToMessage(message, {
      chunkType: "tool_output",
      toolCallId: "call-2",
      content: "Read all 320 lines from game.js",
    });
    message = applyChunkToMessage(message, {
      chunkType: "tool_end",
      toolCallId: "call-2",
      status: "completed",
    });
    message = applyChunkToMessage(message, {
      chunkType: "tool_start",
      name: "read_file",
      toolCallId: "call-3",
      input: {},
    });
    message = applyChunkToMessage(message, {
      chunkType: "tool_output",
      toolCallId: "call-3",
      content: "Read all 120 lines from style.css",
    });
    message = applyChunkToMessage(message, {
      chunkType: "tool_end",
      toolCallId: "call-3",
      status: "completed",
    });

    tools = getToolBlocks(message);
    const call2Done = tools.find((tool) => tool.toolCallId === "call-2");
    const call3Done = tools.find((tool) => tool.toolCallId === "call-3");
    assert.strictEqual(call2Done?.status, "completed");
    assert.ok(call2Done?.output.includes("game.js"));
    assert.strictEqual(call3Done?.status, "completed");
    assert.ok(call3Done?.output.includes("style.css"));
  });

  test("reconciles late toolCallId assignment into existing running tool block", () => {
    let message = createAssistantMessage();

    message = applyChunkToMessage(message, {
      chunkType: "tool_start",
      name: "write_file",
      input: {},
    });
    message = applyChunkToMessage(message, {
      chunkType: "tool_start",
      name: "write_file",
      toolCallId: "call-1",
      input: { file_path: "/tmp/index.html" },
    });
    message = applyChunkToMessage(message, {
      chunkType: "tool_output",
      toolCallId: "call-1",
      content: "Internal Error: params must have required property 'file_path'",
    });
    message = applyChunkToMessage(message, {
      chunkType: "tool_end",
      toolCallId: "call-1",
      status: "error",
    });

    const tools = getToolBlocks(message);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].toolCallId, "call-1");
    assert.strictEqual(tools[0].status, "error");
    assert.strictEqual(tools[0].input.file_path, "/tmp/index.html");
    assert.ok(tools[0].output.includes("Internal Error"));
  });

  test("tool retry creates second block, old block keeps error", () => {
    let message = createAssistantMessage();

    // First attempt: fails
    message = applyChunks(message, [
      {
        chunkType: "tool_start",
        name: "write_file",
        toolCallId: "call-a",
        input: { file_path: "/tmp/bad.ts" },
      },
      {
        chunkType: "tool_output",
        toolCallId: "call-a",
        content: "Error: invalid params",
      },
      { chunkType: "tool_end", toolCallId: "call-a", status: "error" },
    ]);

    // Second attempt: succeeds
    message = applyChunks(message, [
      {
        chunkType: "tool_start",
        name: "write_file",
        toolCallId: "call-b",
        input: { file_path: "/tmp/good.ts" },
      },
      {
        chunkType: "tool_output",
        toolCallId: "call-b",
        content: "Written successfully",
      },
      { chunkType: "tool_end", toolCallId: "call-b", status: "completed" },
    ]);

    const tools = getToolBlocks(message);
    assert.strictEqual(tools.length, 2);
    assert.strictEqual(tools[0].toolCallId, "call-a");
    assert.strictEqual(tools[0].status, "error");
    assert.strictEqual(tools[1].toolCallId, "call-b");
    assert.strictEqual(tools[1].status, "completed");
  });

  test("tool_end with error status", () => {
    let message = createAssistantMessage();

    message = applyChunks(message, [
      {
        chunkType: "tool_start",
        name: "bash",
        toolCallId: "call-err",
        input: { command: "exit 1" },
      },
      { chunkType: "tool_end", toolCallId: "call-err", status: "error" },
    ]);

    const tools = getToolBlocks(message);
    assert.strictEqual(tools[0].status, "error");
  });

  test("interleaving with text/thinking does not break tool blocks", () => {
    let message = createAssistantMessage();

    message = applyChunkToMessage(message, {
      chunkType: "text",
      content: "Let me read ",
    });
    message = applyChunkToMessage(message, {
      chunkType: "tool_start",
      name: "read_file",
      toolCallId: "call-mid",
      input: { file_path: "/tmp/a.ts" },
    });
    message = applyChunkToMessage(message, { chunkType: "thinking_start" });
    message = applyChunkToMessage(message, {
      chunkType: "thinking_content",
      content: "analyzing",
    });
    message = applyChunkToMessage(message, { chunkType: "thinking_end" });
    message = applyChunkToMessage(message, {
      chunkType: "tool_output",
      toolCallId: "call-mid",
      content: "file contents",
    });
    message = applyChunkToMessage(message, {
      chunkType: "tool_end",
      toolCallId: "call-mid",
      status: "completed",
    });
    message = applyChunkToMessage(message, {
      chunkType: "text",
      content: "the file.",
    });

    const tools = getToolBlocks(message);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].status, "completed");

    const textBlocks = message.blocks.filter((b) => b.type === "text");
    assert.strictEqual(textBlocks.length, 2);

    const thinkingBlocks = message.blocks.filter((b) => b.type === "thinking");
    assert.strictEqual(thinkingBlocks.length, 1);
  });

  test("orphan tool_output ignored", () => {
    let message = createAssistantMessage();

    message = applyChunkToMessage(message, {
      chunkType: "tool_output",
      toolCallId: "nonexistent",
      content: "orphan output",
    });

    assert.strictEqual(message.blocks.length, 0);
  });

  test("orphan tool_end ignored", () => {
    let message = createAssistantMessage();

    message = applyChunkToMessage(message, {
      chunkType: "tool_end",
      toolCallId: "nonexistent",
      status: "completed",
    });

    assert.strictEqual(message.blocks.length, 0);
  });

  test("anonymous start adopted by named start merges input", () => {
    let message = createAssistantMessage();

    message = applyChunkToMessage(message, {
      chunkType: "tool_start",
      name: "edit_file",
      input: { old_string: "foo" },
    });
    message = applyChunkToMessage(message, {
      chunkType: "tool_start",
      name: "edit_file",
      toolCallId: "call-merge",
      input: { file_path: "/tmp/x.ts", new_string: "bar" },
    });

    const tools = getToolBlocks(message);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].toolCallId, "call-merge");
    assert.strictEqual(tools[0].input.old_string, "foo");
    assert.strictEqual(tools[0].input.file_path, "/tmp/x.ts");
    assert.strictEqual(tools[0].input.new_string, "bar");
  });

  test("tool_start merges input not replaces", () => {
    let message = createAssistantMessage();

    message = applyChunkToMessage(message, {
      chunkType: "tool_start",
      name: "write_file",
      toolCallId: "call-inc",
      input: { file_path: "/tmp/a.ts" },
    });
    message = applyChunkToMessage(message, {
      chunkType: "tool_start",
      name: "write_file",
      toolCallId: "call-inc",
      input: { content: "new content" },
    });

    const tools = getToolBlocks(message);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].input.file_path, "/tmp/a.ts");
    assert.strictEqual(tools[0].input.content, "new content");
  });

  test("immutability preserved", () => {
    const original = createAssistantMessage();
    Object.freeze(original);
    Object.freeze(original.blocks);

    const updated = applyChunkToMessage(original, {
      chunkType: "tool_start",
      name: "read_file",
      toolCallId: "call-imm",
      input: { file_path: "/tmp/z.ts" },
    });

    assert.notStrictEqual(updated, original);
    assert.notStrictEqual(updated.blocks, original.blocks);
    assert.strictEqual(original.blocks.length, 0);
    assert.strictEqual(updated.blocks.length, 1);
  });

  // ── Integration: mapper + reducer ──────────────────────────────

  test("full lifecycle through mapper+reducer: pending->completed", () => {
    const mapper = new ToolChunkMapper();
    let message = createAssistantMessage();

    // pending tool_call
    const pendingChunks = mapper.mapToolUpdate({
      sessionUpdate: "tool_call",
      status: "pending",
      toolName: "read_file",
      toolCallId: "int-call-1",
      args: { file_path: "/tmp/test.ts" },
    });
    message = applyChunks(message, pendingChunks);

    let tools = getToolBlocks(message);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].status, "running");
    assert.strictEqual(tools[0].toolCallId, "int-call-1");

    // completed tool_call_update
    const completedChunks = mapper.mapToolUpdate({
      sessionUpdate: "tool_call_update",
      status: "completed",
      toolName: "read_file",
      toolCallId: "int-call-1",
      content: [
        {
          type: "content",
          content: { type: "text", text: "file output here" },
        },
      ],
    });
    message = applyChunks(message, completedChunks);

    tools = getToolBlocks(message);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].status, "completed");
    assert.ok(tools[0].output.includes("file output here"));
  });

  test("write_file hanging bug reproduction: no status tool_call -> completed", () => {
    const mapper = new ToolChunkMapper();
    let message = createAssistantMessage();

    // tool_call with no status (defaults to pending)
    const startChunks = mapper.mapToolUpdate({
      sessionUpdate: "tool_call",
      toolName: "write_file",
      toolCallId: "hang-call-1",
      args: { file_path: "/tmp/output.ts" },
    });
    message = applyChunks(message, startChunks);

    let tools = getToolBlocks(message);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].status, "running");

    // tool_call_update with completed status
    const doneChunks = mapper.mapToolUpdate({
      sessionUpdate: "tool_call_update",
      status: "completed",
      toolName: "write_file",
      toolCallId: "hang-call-1",
      content: [{ type: "diff", fileDiff: "+ new content" }],
    });
    message = applyChunks(message, doneChunks);

    tools = getToolBlocks(message);
    assert.strictEqual(tools.length, 1);
    assert.strictEqual(tools[0].status, "completed");
    assert.ok(tools[0].output.includes("new content"));
  });
});
