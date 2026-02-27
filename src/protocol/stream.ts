export type StreamStatusPhase = 'preparing' | 'connecting' | 'waiting_first_chunk';

// Stream chunk types from CLI output
export type StreamChunk =
  | { chunkType: 'text'; content: string }
  | { chunkType: 'code_start'; language: string; filename?: string }
  | { chunkType: 'code_content'; content: string }
  | { chunkType: 'code_end' }
  | { chunkType: 'usage'; promptTokens?: number; completionTokens?: number; totalTokens?: number }
  | { chunkType: 'tool_start'; name: string; input: Record<string, unknown>; label?: string; toolCallId?: string }
  | { chunkType: 'tool_output'; content: string; toolCallId?: string }
  | { chunkType: 'tool_end'; status: 'completed' | 'error'; toolCallId?: string }
  | { chunkType: 'tool_confirmation'; requestId: number; toolName: string; description: string; confirmationType: string }
  | { chunkType: 'user_question'; requestId: number; questions: Array<{ question: string; header: string; options: Array<{ label: string; description: string }>; multiSelect: boolean }> }
  | { chunkType: 'plan_approval'; requestId: number; plan: string }
  | { chunkType: 'thinking_start' }
  | { chunkType: 'thinking_content'; content: string }
  | { chunkType: 'thinking_end' }
  | { chunkType: 'file_ref'; path: string; lineStart?: number; lineEnd?: number }
  | { chunkType: 'plan'; entries: Array<{ content: string; status: string; priority: string }> }
  | { chunkType: 'error'; message: string }
  | { chunkType: 'warning'; message: string };

// Output blocks in messages
export type OutputBlock =
  | { type: 'text'; content: string }
  | { type: 'code'; language: string; filename?: string; content: string }
  | { type: 'tool'; name: string; input: Record<string, unknown>; output: string; status: 'running' | 'completed' | 'error'; label?: string; toolCallId?: string }
  | { type: 'thinking'; content: string; collapsed: boolean }
  | { type: 'file_ref'; path: string; lineStart?: number; lineEnd?: number }
  | { type: 'plan'; entries: Array<{ content: string; status: string; priority: string }> }
  | { type: 'error'; message: string }
  | { type: 'warning'; message: string };
