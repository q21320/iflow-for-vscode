import * as assert from 'assert';
import { ThinkingParser } from '../thinkingParser';
import { StreamChunk } from '../protocol';

function chunkTypes(chunks: StreamChunk[]): string[] {
  return chunks.map((chunk) => chunk.chunkType);
}

suite('ThinkingParser', () => {
  test('emits plain text when no think block exists', () => {
    const parser = new ThinkingParser();
    const chunks = parser.parse('hello');
    assert.deepStrictEqual(chunks, [{ chunkType: 'text', content: 'hello' }]);
  });

  test('parses think block in a single chunk', () => {
    const parser = new ThinkingParser();
    const chunks = parser.parse('a<think>b</think>c');
    assert.deepStrictEqual(chunkTypes(chunks), [
      'text',
      'thinking_start',
      'thinking_content',
      'thinking_end',
      'text',
    ]);
  });

  test('handles split <think> marker across chunks', () => {
    const parser = new ThinkingParser();
    const first = parser.parse('before<th');
    const second = parser.parse('ink>inside</think>after');

    assert.deepStrictEqual(first, [{ chunkType: 'text', content: 'before' }]);
    assert.deepStrictEqual(chunkTypes(second), [
      'thinking_start',
      'thinking_content',
      'thinking_end',
      'text',
    ]);
  });

  test('handles split </think> marker across chunks', () => {
    const parser = new ThinkingParser();
    const first = parser.parse('<think>inside</thi');
    const second = parser.parse('nk>tail');

    assert.deepStrictEqual(chunkTypes(first), ['thinking_start', 'thinking_content']);
    assert.deepStrictEqual(chunkTypes(second), ['thinking_end', 'text']);
  });
});
