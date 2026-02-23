import * as assert from 'assert';
import { Message, OutputBlock } from '../protocol';
import { applyChunkToMessage } from '../store/chunkReducer';

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

function getToolBlocks(message: Message): Array<Extract<OutputBlock, { type: 'tool' }>> {
  return message.blocks.filter((block): block is Extract<OutputBlock, { type: 'tool' }> => block.type === 'tool');
}

suite('chunkReducer', () => {
  test('tracks concurrent same-name tools by toolCallId', () => {
    let message = createAssistantMessage();

    message = applyChunkToMessage(message, {
      chunkType: 'tool_start',
      name: 'read_file',
      toolCallId: 'call-1',
      input: { file_path: '/tmp/index.html' },
      label: 'index.html',
    });
    message = applyChunkToMessage(message, {
      chunkType: 'tool_start',
      name: 'read_file',
      toolCallId: 'call-2',
      input: { file_path: '/tmp/game.js' },
      label: 'game.js',
    });
    message = applyChunkToMessage(message, {
      chunkType: 'tool_start',
      name: 'read_file',
      toolCallId: 'call-3',
      input: { file_path: '/tmp/style.css' },
      label: 'style.css',
    });

    let tools = getToolBlocks(message);
    assert.strictEqual(tools.length, 3);
    assert.strictEqual(tools[0].input.file_path, '/tmp/index.html');
    assert.strictEqual(tools[1].input.file_path, '/tmp/game.js');
    assert.strictEqual(tools[2].input.file_path, '/tmp/style.css');

    message = applyChunkToMessage(message, {
      chunkType: 'tool_start',
      name: 'read_file',
      toolCallId: 'call-1',
      input: {},
    });
    message = applyChunkToMessage(message, {
      chunkType: 'tool_output',
      toolCallId: 'call-1',
      content: 'Read all 51 lines from index.html',
    });
    message = applyChunkToMessage(message, {
      chunkType: 'tool_end',
      toolCallId: 'call-1',
      status: 'completed',
    });

    tools = getToolBlocks(message);
    const call1 = tools.find((tool) => tool.toolCallId === 'call-1');
    const call2 = tools.find((tool) => tool.toolCallId === 'call-2');
    const call3 = tools.find((tool) => tool.toolCallId === 'call-3');
    assert.ok(call1);
    assert.ok(call2);
    assert.ok(call3);
    assert.strictEqual(call1?.status, 'completed');
    assert.ok(call1?.output.includes('index.html'));
    assert.strictEqual(call2?.status, 'running');
    assert.strictEqual(call3?.status, 'running');

    message = applyChunkToMessage(message, {
      chunkType: 'tool_start',
      name: 'read_file',
      toolCallId: 'call-2',
      input: {},
    });
    message = applyChunkToMessage(message, {
      chunkType: 'tool_output',
      toolCallId: 'call-2',
      content: 'Read all 320 lines from game.js',
    });
    message = applyChunkToMessage(message, {
      chunkType: 'tool_end',
      toolCallId: 'call-2',
      status: 'completed',
    });
    message = applyChunkToMessage(message, {
      chunkType: 'tool_start',
      name: 'read_file',
      toolCallId: 'call-3',
      input: {},
    });
    message = applyChunkToMessage(message, {
      chunkType: 'tool_output',
      toolCallId: 'call-3',
      content: 'Read all 120 lines from style.css',
    });
    message = applyChunkToMessage(message, {
      chunkType: 'tool_end',
      toolCallId: 'call-3',
      status: 'completed',
    });

    tools = getToolBlocks(message);
    const call2Done = tools.find((tool) => tool.toolCallId === 'call-2');
    const call3Done = tools.find((tool) => tool.toolCallId === 'call-3');
    assert.strictEqual(call2Done?.status, 'completed');
    assert.ok(call2Done?.output.includes('game.js'));
    assert.strictEqual(call3Done?.status, 'completed');
    assert.ok(call3Done?.output.includes('style.css'));
  });
});
