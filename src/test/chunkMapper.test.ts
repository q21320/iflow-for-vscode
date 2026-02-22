import * as assert from 'assert';
import { ChunkMapper } from '../chunkMapper';

suite('ChunkMapper', () => {
  let mapper: ChunkMapper;

  setup(() => {
    mapper = new ChunkMapper((_msg: string) => {});
    mapper.reset();
  });

  test('agent_message_chunk emits text', () => {
    const chunks = mapper.mapUpdateToChunks({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'hello world' },
    });

    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].chunkType, 'text');
    if (chunks[0].chunkType === 'text') {
      assert.strictEqual(chunks[0].content, 'hello world');
    }
  });

  test('agent_thought_chunk emits thinking_start once and thinking_content', () => {
    const first = mapper.mapUpdateToChunks({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'step 1' },
    });

    assert.strictEqual(first.length, 2);
    assert.strictEqual(first[0].chunkType, 'thinking_start');
    assert.strictEqual(first[1].chunkType, 'thinking_content');

    const second = mapper.mapUpdateToChunks({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'step 2' },
    });

    assert.strictEqual(second.length, 1);
    assert.strictEqual(second[0].chunkType, 'thinking_content');
  });

  test('agent_message_chunk after thinking emits thinking_end before text', () => {
    mapper.mapUpdateToChunks({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'thinking' },
    });

    const chunks = mapper.mapUpdateToChunks({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: 'final answer' },
    });

    assert.strictEqual(chunks.length, 2);
    assert.strictEqual(chunks[0].chunkType, 'thinking_end');
    assert.strictEqual(chunks[1].chunkType, 'text');
  });

  test('tool_call_update completed maps to start/output/end', () => {
    const chunks = mapper.mapUpdateToChunks({
      sessionUpdate: 'tool_call_update',
      status: 'completed',
      toolName: 'read_file',
      args: { file_path: '/tmp/a.ts' },
      content: [
        { type: 'content', content: { type: 'text', text: 'file content' } },
      ],
    });

    assert.ok(chunks.some((chunk) => chunk.chunkType === 'tool_start'));
    assert.ok(chunks.some((chunk) => chunk.chunkType === 'tool_output'));
    assert.ok(chunks.some((chunk) => chunk.chunkType === 'tool_end' && chunk.status === 'completed'));
  });

  test('tool_call pending emits tool_start', () => {
    const chunks = mapper.mapUpdateToChunks({
      sessionUpdate: 'tool_call',
      toolName: 'write_file',
      status: 'pending',
      args: { file_path: '/tmp/a.ts' },
    });

    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].chunkType, 'tool_start');
    if (chunks[0].chunkType === 'tool_start') {
      assert.strictEqual(chunks[0].name, 'write_file');
      assert.strictEqual(chunks[0].input.file_path, '/tmp/a.ts');
    }
  });

  test('plan message emits plan chunk', () => {
    const chunks = mapper.mapUpdateToChunks({
      sessionUpdate: 'plan',
      entries: [
        { content: 'Step 1', status: 'completed', priority: 'low' },
        { content: 'Step 2', status: 'in_progress', priority: 'medium' },
      ],
    });

    assert.strictEqual(chunks.length, 1);
    assert.strictEqual(chunks[0].chunkType, 'plan');
    if (chunks[0].chunkType === 'plan') {
      assert.strictEqual(chunks[0].entries.length, 2);
      assert.strictEqual(chunks[0].entries[1].status, 'in_progress');
    }
  });

  test('available_commands_update is ignored', () => {
    const chunks = mapper.mapUpdateToChunks({
      sessionUpdate: 'available_commands_update',
      commands: ['a', 'b'],
    });

    assert.strictEqual(chunks.length, 0);
  });

  test('flushToChunks closes dangling thinking block', () => {
    mapper.mapUpdateToChunks({
      sessionUpdate: 'agent_thought_chunk',
      content: { type: 'text', text: 'still thinking' },
    });

    const chunks = mapper.flushToChunks();
    assert.ok(chunks.some((chunk) => chunk.chunkType === 'thinking_end'));
  });

  test('enrichToolInput maps absolute_path to file_path', () => {
    const input = mapper.enrichToolInput({
      args: { absolute_path: '/home/user/test.ts' },
    });
    assert.strictEqual(input.file_path, '/home/user/test.ts');
  });

  test('enrichToolInput merges content fields', () => {
    const input = mapper.enrichToolInput({
      args: {},
      content: { path: '/test.txt', newText: 'hello', oldText: 'world' },
    });
    assert.strictEqual(input.file_path, '/test.txt');
    assert.strictEqual(input.content, 'hello');
    assert.strictEqual(input.old_string, 'world');
  });

  test('buildPrompt includes working directory and prompt', () => {
    const prompt = mapper.buildPrompt({
      prompt: 'hello',
      attachedFiles: [],
      cwd: '/home/user/project',
    });
    assert.ok(prompt.includes('/home/user/project'));
    assert.ok(prompt.includes('hello'));
  });

  test('buildPrompt includes attached files', () => {
    const prompt = mapper.buildPrompt({
      prompt: 'review this',
      attachedFiles: [
        { path: '/test.ts', content: 'const x = 1;' },
      ],
    });
    assert.ok(prompt.includes('/test.ts'));
    assert.ok(prompt.includes('const x = 1;'));
  });
});
