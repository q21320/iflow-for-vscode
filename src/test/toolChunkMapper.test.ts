import * as assert from 'assert';
import { ToolChunkMapper } from '../chunkMapper/toolChunkMapper';
import { StreamChunk } from '../protocol';
import { SessionUpdatePayload } from '../chunkMapper/types';

function createMapper(): ToolChunkMapper {
  return new ToolChunkMapper();
}

function chunkTypes(chunks: StreamChunk[]): string[] {
  return chunks.map((c) => c.chunkType);
}

suite('ToolChunkMapper', () => {
  let mapper: ToolChunkMapper;

  setup(() => {
    mapper = createMapper();
  });

  // ── mapToolUpdate status transitions ────────────────────────────

  test('pending emits only tool_start', () => {
    const chunks = mapper.mapToolUpdate({
      sessionUpdate: 'tool_call',
      status: 'pending',
      toolName: 'read_file',
      toolCallId: 'call-1',
      args: { file_path: '/tmp/a.ts' },
    });

    assert.deepStrictEqual(chunkTypes(chunks), ['tool_start']);
    const start = chunks[0] as Extract<StreamChunk, { chunkType: 'tool_start' }>;
    assert.strictEqual(start.name, 'read_file');
    assert.strictEqual(start.toolCallId, 'call-1');
    assert.strictEqual(start.input.file_path, '/tmp/a.ts');
  });

  test('in_progress emits tool_start', () => {
    const chunks = mapper.mapToolUpdate({
      sessionUpdate: 'tool_call_update',
      status: 'in_progress',
      toolName: 'bash',
      toolCallId: 'call-2',
    });

    assert.deepStrictEqual(chunkTypes(chunks), ['tool_start']);
  });

  test('completed emits start+output+end', () => {
    const chunks = mapper.mapToolUpdate({
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      toolName: 'read_file',
      toolCallId: 'call-3',
      args: { file_path: '/tmp/b.ts' },
      content: [
        { type: 'content', content: { type: 'text', text: 'file contents here' } },
      ],
    });

    assert.deepStrictEqual(chunkTypes(chunks), ['tool_start', 'tool_output', 'tool_end']);
    const end = chunks[2] as Extract<StreamChunk, { chunkType: 'tool_end' }>;
    assert.strictEqual(end.status, 'completed');
    assert.strictEqual(end.toolCallId, 'call-3');
  });

  test('failed emits tool_end with error', () => {
    const chunks = mapper.mapToolUpdate({
      sessionUpdate: 'tool_call_update',
      status: 'failed',
      toolName: 'write_file',
      toolCallId: 'call-4',
      args: { file_path: '/tmp/c.ts' },
    });

    const types = chunkTypes(chunks);
    assert.ok(types.includes('tool_end'));
    const end = chunks.find(
      (c): c is Extract<StreamChunk, { chunkType: 'tool_end' }> => c.chunkType === 'tool_end',
    )!;
    assert.strictEqual(end.status, 'error');
  });

  test('tool_call with no status defaults to pending', () => {
    const chunks = mapper.mapToolUpdate({
      sessionUpdate: 'tool_call',
      toolName: 'write_file',
      toolCallId: 'call-5',
    } as SessionUpdatePayload);

    assert.deepStrictEqual(chunkTypes(chunks), ['tool_start']);
  });

  test('tool_call_update with no status defaults to in_progress', () => {
    const chunks = mapper.mapToolUpdate({
      sessionUpdate: 'tool_call_update',
      toolName: 'bash',
      toolCallId: 'call-6',
    } as SessionUpdatePayload);

    assert.deepStrictEqual(chunkTypes(chunks), ['tool_start']);
  });

  // ── enrichToolInput ─────────────────────────────────────────────

  test('enrichToolInput normalizes absolute_path', () => {
    const input = mapper.enrichToolInput({
      args: { absolute_path: '/tmp/file.ts' },
    });

    assert.strictEqual(input.file_path, '/tmp/file.ts');
    assert.strictEqual(input.absolute_path, '/tmp/file.ts');
  });

  test('enrichToolInput preserves existing file_path', () => {
    const input = mapper.enrichToolInput({
      args: { file_path: '/original.ts', absolute_path: '/overwrite.ts' },
    });

    assert.strictEqual(input.file_path, '/original.ts');
  });

  test('enrichToolInput parses JSON from label', () => {
    const input = mapper.enrichToolInput({
      args: {},
      label: 'write_file: {"file_path": "/tmp/test.ts", "content": "hello"}',
    });

    assert.strictEqual(input.file_path, '/tmp/test.ts');
    assert.strictEqual(input.content, 'hello');
  });

  test('enrichToolInput handles array content', () => {
    const input = mapper.enrichToolInput({
      args: {},
      content: [
        { path: '/tmp/index.html', newText: '<div>hello</div>' },
      ],
    });

    assert.strictEqual(input.file_path, '/tmp/index.html');
    assert.strictEqual(input.content, '<div>hello</div>');
  });

  test('enrichToolInput merges locations', () => {
    const input = mapper.enrichToolInput({
      args: {},
      locations: [{ path: '/tmp/from-location.ts' }],
    });

    assert.strictEqual(input.file_path, '/tmp/from-location.ts');
  });

  // ── toolCallId propagation ──────────────────────────────────────

  test('propagates toolCallId through all chunks', () => {
    const chunks = mapper.mapToolUpdate({
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      toolName: 'read_file',
      toolCallId: 'call-propagate',
      args: { file_path: '/tmp/x.ts' },
      content: [
        { type: 'content', content: { type: 'text', text: 'output' } },
      ],
    });

    for (const chunk of chunks) {
      if ('toolCallId' in chunk) {
        assert.strictEqual(chunk.toolCallId, 'call-propagate');
      }
    }
  });

  test('completed without content/toolCallId skips start', () => {
    const chunks = mapper.mapToolUpdate({
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      toolName: 'unknown',
      args: {},
    } as SessionUpdatePayload);

    // No toolCallId and empty args => skips tool_start, only emits tool_end
    assert.deepStrictEqual(chunkTypes(chunks), ['tool_end']);
  });

  test('normalizeToolLabel strips JSON suffixes', () => {
    const chunks = mapper.mapToolUpdate({
      sessionUpdate: 'tool_call',
      status: 'pending',
      toolName: 'write_file',
      toolCallId: 'call-label',
      title: 'write_file: {"file_path": "/tmp/x.ts"}',
    });

    const start = chunks[0] as Extract<StreamChunk, { chunkType: 'tool_start' }>;
    // label should be undefined because it was stripped (JSON suffix)
    assert.strictEqual(start.label, undefined);
  });
});
