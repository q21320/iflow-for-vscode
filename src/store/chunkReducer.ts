import { Message, OutputBlock, StreamChunk } from '../protocol';

function findLastBlockIndex(blocks: OutputBlock[], type: OutputBlock['type']): number {
  const idx = blocks.length - 1;
  if (idx < 0) {
    return -1;
  }
  return blocks[idx].type === type ? idx : -1;
}

function findLatestToolBlockIndex(blocks: OutputBlock[]): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    if (blocks[i].type === 'tool') {
      return i;
    }
  }
  return -1;
}

function findToolBlockIndexByCallId(blocks: OutputBlock[], toolCallId: string): number {
  for (let i = blocks.length - 1; i >= 0; i -= 1) {
    const block = blocks[i];
    if (block.type === 'tool' && block.toolCallId === toolCallId) {
      return i;
    }
  }
  return -1;
}

export function applyChunkToMessage(message: Message, chunk: StreamChunk): Message {
  const blocks = [...message.blocks];

  switch (chunk.chunkType) {
    case 'usage':
      return message;

    case 'text': {
      const idx = findLastBlockIndex(blocks, 'text');
      if (idx !== -1) {
        const current = blocks[idx] as Extract<OutputBlock, { type: 'text' }>;
        blocks[idx] = { ...current, content: current.content + chunk.content };
      } else {
        blocks.push({ type: 'text', content: chunk.content });
      }
      return {
        ...message,
        blocks,
        content: message.content + chunk.content,
      };
    }

    case 'code_start':
      blocks.push({
        type: 'code',
        language: chunk.language,
        filename: chunk.filename,
        content: '',
      });
      return { ...message, blocks };

    case 'code_content': {
      const idx = findLastBlockIndex(blocks, 'code');
      if (idx === -1) {
        return message;
      }
      const current = blocks[idx] as Extract<OutputBlock, { type: 'code' }>;
      blocks[idx] = { ...current, content: current.content + chunk.content };
      return { ...message, blocks };
    }

    case 'code_end':
      return message;

    case 'tool_start': {
      const idx = chunk.toolCallId
        ? findToolBlockIndexByCallId(blocks, chunk.toolCallId)
        : findLatestToolBlockIndex(blocks);

      if (idx !== -1) {
        const targetTool = blocks[idx] as Extract<OutputBlock, { type: 'tool' }>;
        if (chunk.toolCallId || (targetTool.status === 'running' && targetTool.name === chunk.name && !targetTool.toolCallId)) {
          blocks[idx] = {
            ...targetTool,
            input: chunk.input && Object.keys(chunk.input).length > 0
              ? { ...targetTool.input, ...chunk.input }
              : targetTool.input,
            label: chunk.label ?? targetTool.label,
            toolCallId: chunk.toolCallId ?? targetTool.toolCallId,
          };
          return { ...message, blocks };
        }
      }

      blocks.push({
        type: 'tool',
        name: chunk.name,
        input: chunk.input,
        output: '',
        status: 'running',
        label: chunk.label,
        toolCallId: chunk.toolCallId,
      });
      return { ...message, blocks };
    }

    case 'tool_output': {
      const idx = chunk.toolCallId
        ? findToolBlockIndexByCallId(blocks, chunk.toolCallId)
        : findLatestToolBlockIndex(blocks);
      if (idx === -1) {
        return message;
      }
      const current = blocks[idx] as Extract<OutputBlock, { type: 'tool' }>;
      blocks[idx] = {
        ...current,
        output: current.output + chunk.content,
        toolCallId: chunk.toolCallId ?? current.toolCallId,
      };
      return { ...message, blocks };
    }

    case 'tool_end': {
      const idx = chunk.toolCallId
        ? findToolBlockIndexByCallId(blocks, chunk.toolCallId)
        : findLatestToolBlockIndex(blocks);
      if (idx === -1) {
        return message;
      }
      const current = blocks[idx] as Extract<OutputBlock, { type: 'tool' }>;
      blocks[idx] = {
        ...current,
        status: chunk.status,
        toolCallId: chunk.toolCallId ?? current.toolCallId,
      };
      return { ...message, blocks };
    }

    case 'thinking_start':
      blocks.push({
        type: 'thinking',
        content: '',
        collapsed: false,
      });
      return { ...message, blocks };

    case 'thinking_content': {
      const idx = findLastBlockIndex(blocks, 'thinking');
      if (idx === -1) {
        return message;
      }
      const current = blocks[idx] as Extract<OutputBlock, { type: 'thinking' }>;
      blocks[idx] = { ...current, content: current.content + chunk.content };
      return { ...message, blocks };
    }

    case 'thinking_end': {
      const idx = findLastBlockIndex(blocks, 'thinking');
      if (idx === -1) {
        return message;
      }
      const current = blocks[idx] as Extract<OutputBlock, { type: 'thinking' }>;
      blocks[idx] = { ...current, collapsed: true };
      return { ...message, blocks };
    }

    case 'file_ref':
      blocks.push({
        type: 'file_ref',
        path: chunk.path,
        lineStart: chunk.lineStart,
        lineEnd: chunk.lineEnd,
      });
      return { ...message, blocks };

    case 'tool_confirmation':
    case 'user_question':
    case 'plan_approval':
      return message;

    case 'plan': {
      const planBlock: OutputBlock = { type: 'plan', entries: chunk.entries };
      const idx = blocks.findIndex((b) => b.type === 'plan');
      if (idx !== -1) {
        blocks[idx] = planBlock;
      } else {
        blocks.push(planBlock);
      }
      return { ...message, blocks };
    }

    case 'error':
      blocks.push({ type: 'error', message: chunk.message });
      return { ...message, blocks };

    case 'warning':
      blocks.push({ type: 'warning', message: chunk.message });
      return { ...message, blocks };
  }

  return message;
}
