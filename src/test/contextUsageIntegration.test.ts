import * as assert from "assert";
import * as path from "path";
import { UsageChunkMapper } from "../chunkMapper/usageChunkMapper";
import { AcpUsageExtractor } from "../acp/client/acpUsageExtractor";
import { ConversationService } from "../store/conversationService";
import { MODELS } from "../protocol";
import type { StreamChunk } from "../protocol";
import { runNodeScript } from "./realCliTestHelper";

/**
 * Context Usage Integration Test
 *
 * Verifies that context/token usage data flows correctly through the entire
 * pipeline: CLI → ACP WebSocket → chunk mapping → store → UI.
 *
 * Run the real CLI test with:
 *   IFLOW_REAL_CLI_TEST=1 npm run test:unit -- --grep "Context Usage Integration"
 *
 * Or via npm script:
 *   npm run test:real-cli
 */
suite("Context Usage Integration", () => {
  /**
   * End-to-end probe: connects to real iFlow CLI, sends a prompt, and verifies
   * whether the CLI emits token usage data in any recognized format.
   *
   * This test DOES NOT fail if usage data is absent — instead it documents the
   * finding so we know whether the feature works with the current CLI version.
   * It only fails if the probe script itself errors out.
   */
  test("probes context usage data pipeline with real iflow CLI", async function () {
    if (process.env.IFLOW_REAL_CLI_TEST !== "1") {
      this.skip();
    }

    this.timeout(120_000);

    const rootDir = path.resolve(__dirname, "..", "..");
    const scriptPath = path.join(
      rootDir,
      "scripts",
      "context-usage-probe.mjs",
    );
    const result = await runNodeScript(rootDir, scriptPath, {
      ...process.env,
      IFLOW_ACP_PORT: process.env.IFLOW_ACP_PORT || "8124",
      IFLOW_ACP_STREAM: process.env.IFLOW_ACP_STREAM || "1",
      IFLOW_ACP_DUMP_ALL: process.env.IFLOW_ACP_DUMP_ALL || "1",
    });

    const output = `${result.stdout}\n${result.stderr}`;

    // The script itself must complete without fatal error
    assert.strictEqual(
      result.code,
      0,
      `context usage probe failed (code=${String(result.code)})\n${output}`,
    );

    // Must have seen at least some session/update notifications
    assert.match(
      output,
      /\[usage-probe\] session\/update notifications:\s*\d+/,
      "Expected session/update notification count in output",
    );

    // Must have run the pipeline simulation
    assert.match(
      output,
      /\[usage-probe\] extension would emit usage chunks:/,
      "Expected pipeline simulation results in output",
    );

    // Log the context usage verdict for CI visibility
    const usageVisibleMatch = output.match(
      /\[usage-probe\] context usage visible in UI:\s*(\w+)/,
    );
    const usageVisibleInUI =
      usageVisibleMatch ? usageVisibleMatch[1] === "true" : false;

    const notifCountMatch = output.match(
      /\[usage-probe\] session\/update notifications:\s*(\d+)/,
    );
    const notifCount = notifCountMatch ? Number(notifCountMatch[1]) : 0;

    const usageChunksMatch = output.match(
      /\[usage-probe\] extension would emit usage chunks:\s*(\d+)/,
    );
    const usageChunkCount = usageChunksMatch
      ? Number(usageChunksMatch[1])
      : 0;

    console.log("\n=== Context Usage Integration Test Results ===");
    console.log(`  Session/update notifications received: ${notifCount}`);
    console.log(`  Usage chunks extension would emit:     ${usageChunkCount}`);
    console.log(`  Context usage visible in UI:           ${usageVisibleInUI}`);

    if (!usageVisibleInUI) {
      console.log(
        "\n  NOTE: CLI did not send recognized usage keys in this run.",
      );
      console.log(
        "  The extension will show 0% context usage (the 'no data' fallback state).",
      );
      console.log(
        "  Action: Check whether a newer CLI version sends usage data, or",
      );
      console.log(
        "  update usageChunkMapper.ts key arrays to match the CLI's actual field names.",
      );
    } else {
      console.log(
        "\n  PASS: CLI sends recognized usage data — context bar will be populated.",
      );
    }

    console.log("==============================================\n");

    assert.ok(
      notifCount >= 0,
      "Notification count should be a non-negative number",
    );
  });

  /**
   * Unit-level verification: the UsageChunkMapper extracts usage from common
   * known CLI payload shapes without requiring the real CLI.
   *
   * These tests document the formats the mapper is designed to handle and
   * verify the extraction logic is correct for each.
   */
  suite("UsageChunkMapper extraction logic", () => {
    let mapper: UsageChunkMapper;

    setup(() => {
      mapper = new UsageChunkMapper();
    });

    test("extracts promptTokenCount / candidatesTokenCount / totalTokenCount (Gemini-style)", () => {
      const payload = {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
        usageMetadata: {
          promptTokenCount: 123,
          candidatesTokenCount: 45,
          totalTokenCount: 168,
        },
      };

      const chunk = mapper.extractFromPayload(payload);
      assert.ok(chunk, "Should extract a usage chunk");
      assert.strictEqual(chunk!.chunkType, "usage");
      if (chunk && chunk.chunkType === "usage") {
        assert.strictEqual(chunk.promptTokens, 123);
        assert.strictEqual(chunk.completionTokens, 45);
        assert.strictEqual(chunk.totalTokens, 168);
      }
    });

    test("extracts prompt_tokens / completion_tokens / total_tokens (OpenAI-style)", () => {
      const payload = {
        usage: {
          prompt_tokens: 200,
          completion_tokens: 50,
          total_tokens: 250,
        },
      };

      const chunk = mapper.extractFromPayload(payload);
      assert.ok(chunk, "Should extract a usage chunk");
      if (chunk && chunk.chunkType === "usage") {
        assert.strictEqual(chunk.promptTokens, 200);
        assert.strictEqual(chunk.completionTokens, 50);
        assert.strictEqual(chunk.totalTokens, 250);
      }
    });

    test("extracts input_tokens / output_tokens (Anthropic-style)", () => {
      const payload = {
        usage: {
          input_tokens: 300,
          output_tokens: 75,
        },
      };

      const chunk = mapper.extractFromPayload(payload);
      assert.ok(chunk, "Should extract a usage chunk");
      if (chunk && chunk.chunkType === "usage") {
        assert.strictEqual(chunk.promptTokens, 300);
        assert.strictEqual(chunk.completionTokens, 75);
        assert.strictEqual(chunk.totalTokens, undefined);
      }
    });

    test("returns null when no usage keys are present", () => {
      const payload = {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
      };

      const chunk = mapper.extractFromPayload(payload);
      assert.strictEqual(chunk, null, "Should return null when no usage data");
    });

    test("extracts usage from nested object (deep search)", () => {
      const payload = {
        result: {
          metadata: {
            usageMetadata: {
              promptTokenCount: 400,
              candidatesTokenCount: 80,
              totalTokenCount: 480,
            },
          },
        },
      };

      const chunk = mapper.extractFromPayload(payload);
      assert.ok(chunk, "Should find usage in nested structure");
      if (chunk && chunk.chunkType === "usage") {
        assert.strictEqual(chunk.promptTokens, 400);
      }
    });

    test("extractFromUpdate works with envelope-level usageMetadata", () => {
      const update = {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "hello" },
        usageMetadata: {
          promptTokenCount: 150,
          totalTokenCount: 200,
        },
      };

      const chunk = mapper.extractFromUpdate(update);
      assert.ok(chunk, "Should extract usage chunk from update");
      if (chunk && chunk.chunkType === "usage") {
        assert.strictEqual(chunk.promptTokens, 150);
        assert.strictEqual(chunk.totalTokens, 200);
      }
    });

    test("handles partial usage data (only promptTokens)", () => {
      const payload = {
        usageMetadata: {
          promptTokenCount: 500,
        },
      };

      const chunk = mapper.extractFromPayload(payload);
      assert.ok(chunk, "Should extract partial usage chunk");
      if (chunk && chunk.chunkType === "usage") {
        assert.strictEqual(chunk.promptTokens, 500);
        assert.strictEqual(chunk.completionTokens, undefined);
        assert.strictEqual(chunk.totalTokens, undefined);
      }
    });

    test("handles floating point values by rounding", () => {
      const payload = {
        usage: {
          prompt_tokens: 99.7,
          completion_tokens: 20.3,
        },
      };

      const chunk = mapper.extractFromPayload(payload);
      assert.ok(chunk, "Should handle float values");
      if (chunk && chunk.chunkType === "usage") {
        assert.strictEqual(chunk.promptTokens, 100); // rounded
        assert.strictEqual(chunk.completionTokens, 20); // rounded
      }
    });
  });

  /**
   * Unit-level verification: ConversationService.resolveContextUsage correctly
   * uses ACP usage data when available, and falls back gracefully when not.
   */
  suite("ConversationService context usage integration", () => {
    function makeService(): ConversationService {
      return new ConversationService(
        { currentConversationId: null, conversations: [] },
        { onPersist: () => {}, onChange: () => {} },
      );
    }

    function makeUsageChunk(
      promptTokens?: number,
      completionTokens?: number,
      totalTokens?: number,
    ): StreamChunk {
      return { chunkType: "usage", promptTokens, completionTokens, totalTokens };
    }

    test("fallback returns 0 usage when no ACP data received", () => {
      const service = makeService();
      service.newConversation();

      const usage = service.resolveContextUsage(service.getCurrentConversation());
      assert.strictEqual(usage.usedTokens, 0, "Fallback should return 0 used tokens");
      assert.ok(usage.totalTokens > 0, "Fallback should return positive total tokens");
      assert.strictEqual(usage.percent, 0, "Fallback should return 0 percent");
    });

    test("uses ACP usage data over fallback estimate when usage chunk received", () => {
      const service = makeService();
      service.newConversation();
      service.startAssistantMessage();

      service.appendToAssistantMessage(makeUsageChunk(50000, 1000, 51000));

      const usage = service.resolveContextUsage(service.getCurrentConversation());
      // updateAcpUsage uses promptTokens ?? totalTokens ?? completionTokens
      assert.strictEqual(usage.usedTokens, 50000, "Should use promptTokens as usedTokens");
      assert.ok(usage.totalTokens > 0, "Total tokens should be the model context size");
      assert.ok(usage.percent > 0, "Percent should be positive after usage data");
    });

    test("updates usedTokens when new usage chunk replaces old one", () => {
      const service = makeService();
      service.newConversation();
      service.startAssistantMessage();

      service.appendToAssistantMessage(makeUsageChunk(10000));
      const usage1 = service.resolveContextUsage(service.getCurrentConversation());
      assert.strictEqual(usage1.usedTokens, 10000);

      service.appendToAssistantMessage(makeUsageChunk(20000));
      const usage2 = service.resolveContextUsage(service.getCurrentConversation());
      assert.strictEqual(usage2.usedTokens, 20000, "Should update to the newer value");
    });

    test("falls back to totalTokens when promptTokens is absent", () => {
      const service = makeService();
      service.newConversation();
      service.startAssistantMessage();

      // promptTokens absent, only completionTokens + totalTokens
      service.appendToAssistantMessage(makeUsageChunk(undefined, 500, 15000));

      const usage = service.resolveContextUsage(service.getCurrentConversation());
      // Priority: promptTokens (absent) → totalTokens (present)
      assert.strictEqual(
        usage.usedTokens,
        15000,
        "Should fall back to totalTokens when promptTokens absent",
      );
    });

    test("falls back to completionTokens when both prompt and total are absent", () => {
      const service = makeService();
      service.newConversation();
      service.startAssistantMessage();

      service.appendToAssistantMessage(makeUsageChunk(undefined, 800, undefined));

      const usage = service.resolveContextUsage(service.getCurrentConversation());
      assert.strictEqual(
        usage.usedTokens,
        800,
        "Should fall back to completionTokens as last resort",
      );
    });

    test("resets ACP usage when conversation is cleared", () => {
      const service = makeService();
      service.newConversation();
      service.startAssistantMessage();

      service.appendToAssistantMessage(makeUsageChunk(50000));
      const before = service.resolveContextUsage(service.getCurrentConversation());
      assert.strictEqual(before.usedTokens, 50000);

      service.clearCurrentConversation();
      const after = service.resolveContextUsage(service.getCurrentConversation());
      assert.strictEqual(after.usedTokens, 0, "Clearing conversation should reset usage to 0");
    });
  });

  /**
   * Unit-level: AcpUsageExtractor.mergeEnvelopeUsage correctly promotes
   * envelope-level usage fields into the update object.
   */
  suite("AcpUsageExtractor.mergeEnvelopeUsage", () => {
    let extractor: AcpUsageExtractor;

    setup(() => {
      extractor = new AcpUsageExtractor();
    });

    test("promotes envelope usageMetadata into update when update lacks it", () => {
      const params = {
        sessionId: "s1",
        usageMetadata: {
          promptTokenCount: 100,
          totalTokenCount: 150,
        },
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "hello" },
        },
      };

      const merged = extractor.mergeEnvelopeUsage(params, params) as Record<string, unknown>;
      const usageMetadata = merged.usageMetadata as Record<string, unknown>;
      assert.ok(usageMetadata, "Should promote envelope usageMetadata into merged update");
      assert.strictEqual(usageMetadata.promptTokenCount, 100, "Should preserve promptTokenCount");
      assert.strictEqual(usageMetadata.totalTokenCount, 150, "Should preserve totalTokenCount");
    });

    test("does not overwrite existing usageMetadata in update", () => {
      const params = {
        sessionId: "s1",
        usageMetadata: {
          promptTokenCount: 999,
        },
        update: {
          sessionUpdate: "agent_message_chunk",
          usageMetadata: {
            promptTokenCount: 42,
          },
        },
      };

      const merged = extractor.mergeEnvelopeUsage(params, params) as Record<string, unknown>;
      const usageMetadata = merged.usageMetadata as Record<string, unknown>;
      assert.strictEqual(
        usageMetadata.promptTokenCount,
        42,
        "Update-level usageMetadata should not be overwritten by envelope",
      );
    });

    test("extractUsageChunk returns null when payload has no usage keys", () => {
      const chunk = extractor.extractUsageChunk({ someOtherField: "value" });
      assert.strictEqual(chunk, null, "Should return null for payload without usage keys");
    });

    test("extractUsageChunk extracts from promptResult with usage field", () => {
      const promptResult = {
        stopReason: "end_turn",
        usage: {
          prompt_tokens: 1234,
          completion_tokens: 56,
          total_tokens: 1290,
        },
      };

      const chunk = extractor.extractUsageChunk(promptResult);
      assert.ok(chunk, "Should extract usage chunk from prompt result");
      if (chunk && chunk.chunkType === "usage") {
        assert.strictEqual(chunk.promptTokens, 1234);
        assert.strictEqual(chunk.completionTokens, 56);
        assert.strictEqual(chunk.totalTokens, 1290);
      }
    });
  });
});
