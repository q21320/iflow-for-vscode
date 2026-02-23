# API.md — iFlow VS Code 扩展 ACP 通信参考

## 1. 概述

本项目使用自研 **ACP（Agent Communication Protocol）** 栈与 iFlow CLI 通信，完全不依赖 `@iflow-ai/iflow-cli-sdk`。通信基于 **WebSocket + JSON-RPC 2.0** 协议。

### 三层架构

```
AcpClient           ← 公共 API 外观：会话生命周期、run/cancel/dispose
  └─ SessionCoordinator  ← 连接管理：连接复用、重连判断
       ├─ AcpProtocol        ← JSON-RPC 2.0 协议层：请求/响应/通知路由
       │    └─ AcpTransport       ← WebSocket 传输层：消息缓冲、持久监听器
       ├─ InteractionBridge   ← 服务端交互处理：权限/问题/计划/文件系统
       ├─ RuntimeConfigApplier ← 会话运行时配置：模式/模型/思考
       ├─ PathPolicy          ← 文件系统路径安全策略
       └─ SettingsRepository  ← ~/.iflow/settings.json 读写
```

### 数据流

```
用户输入 → media/main.ts → postMessage(WebviewMessage)
  → src/webviewHandler.ts
    → src/acpClient.ts (AcpClient.run)
      → src/acp/sessionCoordinator.ts (ensureConnected)
        → src/acpTransport.ts (WebSocket)
        → src/acpProtocol.ts (JSON-RPC 2.0)
        → iFlow CLI 子进程
      → session/update 通知
        → src/chunkMapper.ts (ACP payload → StreamChunk)
          → postMessage(ExtensionMessage) → media/main.ts (渲染)
```

---

## 2. 模块职责

| 模块 | 路径 | 职责 |
|------|------|------|
| `AcpClient` | `src/acpClient.ts` | 公共 API 外观，整合所有子模块 |
| `SessionCoordinator` | `src/acp/sessionCoordinator.ts` | 连接生命周期、复用判断、状态机 |
| `AcpProtocol` | `src/acpProtocol.ts` | JSON-RPC 2.0 协议层，请求/响应/通知路由 |
| `AcpTransport` | `src/acpTransport.ts` | WebSocket 传输，消息缓冲/等待队列 |
| `InteractionBridge` | `src/acp/interactionBridge.ts` | 服务端方法处理：权限/问题/计划/文件系统 |
| `RuntimeConfigApplier` | `src/acp/runtimeConfigApplier.ts` | 构建 session settings，发送 set_mode/set_model/set_think |
| `PathPolicy` | `src/acp/pathPolicy.ts` | 文件系统路径白名单安全策略 |
| `SettingsRepository` | `src/acp/settingsRepository.ts` | 读写 `~/.iflow/settings.json` |
| `ChunkMapper` | `src/chunkMapper.ts` | ACP `session/update` payload → `StreamChunk` |

---

## 3. AcpClient 公共 API

`src/acpClient.ts` — 对外暴露的唯一入口类。

### 公开方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `checkAvailability()` | `() => Promise<{version: string\|null; diagnostics: string}>` | 检测 iFlow CLI 是否可用，返回版本号和诊断信息 |
| `run()` | 见下方 | 完整对话轮次：确保连接 → 发送提示词 → 接收流式响应 |
| `cancel()` | `() => Promise<void>` | 发送 `session/cancel`，中断当前任务（不断开连接） |
| `dispose()` | `() => Promise<void>` | 完全清理：断开连接 + 停止子进程 + 清除交互状态 |
| `isRunning()` | `() => boolean` | 是否有 run() 正在进行 |
| `clearAutoDetectCache()` | `() => void` | 清除 CLI 路径自动检测缓存 |
| `approveToolCall()` | `(requestId: number, outcome: string) => Promise<void>` | 批准工具权限请求 |
| `rejectToolCall()` | `(requestId: number) => Promise<void>` | 拒绝工具权限请求 |
| `answerQuestions()` | `(requestId: number, answers: Record<string, string \| string[]>) => Promise<void>` | 回答用户问题 |
| `approvePlan()` | `(requestId: number, approved: boolean) => Promise<void>` | 审批计划（exit_plan_mode） |

### run() 签名

```typescript
async run(
  options: RunOptions,
  onChunk: (chunk: StreamChunk) => void,
  onEnd: () => void,
  onError: (error: string) => void,
): Promise<string | undefined>
// 返回 sessionId，失败时返回 undefined
```

### RunOptions

```typescript
interface RunOptions {
  prompt: string;                  // 用户输入文本
  attachedFiles: AttachedFile[];   // 附加文件列表
  mode: ConversationMode;          // 'default' | 'yolo' | 'plan' | 'smart'
  think: boolean;                  // 是否启用思考模式
  model: ModelType;                // 模型名称（见第 9 节）
  workspaceFiles?: string[];       // 工作区文件路径列表（构建提示词用）
  sessionId?: string;              // 指定恢复已有会话
  ideContext?: IDEContext;          // IDE 上下文（活动文件 + 选区）
  cwd?: string;                    // 工作目录
  fileAllowedDirs?: string[];      // 文件系统访问白名单
}
```

### run() 完整流程

```
1. chunkMapper.reset()
2. settingsRepository.updateModel(model)      ← 写入 ~/.iflow/settings.json
3. settingsRepository.updateBaseUrl(baseUrl)  ← 写入 baseUrl（若配置）
4. pathPolicy.setBaseDir(cwd) + setAllowedDirs(fileAllowedDirs)
5. sessionCoordinator.ensureConnected(options)
   ├─ 若 cwd 未变且已 ready → 复用连接（仅更新 sessionId/mode/think/model）
   └─ 否则 → 完整重连（见第 5 节：连接生命周期）
6. protocol.onNotification('session/update', handler)
7. chunkMapper.buildPrompt(options)          ← 构建完整提示词字符串
8. protocol.sendRequest('session/prompt', {sessionId, prompt: [{type:'text', text}]})
9. chunkMapper.flushToChunks()              ← 刷新 parser 残余状态
10. onEnd()
```

---

## 4. AcpTransport API

`src/acpTransport.ts` — 低级 WebSocket 传输层。

### 设计要点

使用**持久 `message` 监听器 + 消息缓冲队列**，保证 TCP 批量帧不会丢失消息（无需旧版 `patchTransport` monkey-patch）。

```
ws.on('message') → buffer.push(msg) 或 waiter.resolve(msg)
transport.receive() → buffer.shift() 或 new Promise(waiter)
```

### 接口

```typescript
interface AcpTransportOptions {
  url: string;      // WebSocket 服务器地址，如 ws://localhost:8090/acp
  timeout: number;  // 连接超时（毫秒）
}
```

### 方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `connect()` | `(options: AcpTransportOptions, wsFactory?) => Promise<void>` | 建立 WebSocket 连接，安装持久消息监听器 |
| `disconnect()` | `() => Promise<void>` | 关闭连接，拒绝所有等待中的 receive() |
| `send()` | `(data: string) => Promise<void>` | 发送原始字符串帧 |
| `receive()` | `() => Promise<string>` | 等待并返回下一条消息（缓冲优先） |
| `isConnected` | `boolean` (getter) | 当前是否已连接 |
| `onClose` | `((error?: Error) => void) \| null` | 连接意外关闭时的回调 |

---

## 5. AcpProtocol API

`src/acpProtocol.ts` — JSON-RPC 2.0 协议层。

### 消息路由规则

| 接收到的消息形态 | 路由目标 |
|----------------|---------|
| `{id, result/error}`（无 method） | 解析客户端请求的 pending Promise |
| `{id, method}`（服务端发起请求） | 调用 `onServerMethod` 注册的处理器，自动回复 result/error |
| `{method}`（无 id，通知） | 调用 `onNotification` 注册的处理器，静默忽略未注册方法 |

### 方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `sendRequest()` | `(method: string, params?) => Promise<unknown>` | 发送客户端请求，返回服务端 result 或抛出 error |
| `sendResult()` | `(id: number, result: unknown) => Promise<void>` | 响应服务端请求（成功） |
| `sendError()` | `(id: number, code: number, message: string) => Promise<void>` | 响应服务端请求（失败） |
| `onServerMethod()` | `(method: string, handler: ServerMethodHandler) => void` | 注册服务端发起的请求处理器 |
| `onNotification()` | `(method: string, handler: NotificationHandler) => void` | 注册服务端通知处理器 |
| `startReceiveLoop()` | `() => void` | 启动后台接收循环（幂等） |
| `stopReceiveLoop()` | `() => void` | 停止接收循环 |
| `dispose()` | `() => void` | 停止循环并拒绝所有 pending 请求 |

### 处理器类型

```typescript
// 服务端发起的请求处理器（需返回结果，会自动发回响应）
type ServerMethodHandler = (id: number, params: unknown) => Promise<unknown>;

// 服务端通知处理器（无需响应）
type NotificationHandler = (params: unknown) => void;
```

---

## 6. JSON-RPC 方法参考

### 客户端 → 服务端（请求）

| 方法 | 参数 | 响应 | 说明 |
|------|------|------|------|
| `initialize` | `{protocolVersion: 1, clientCapabilities: {fs: {readTextFile, writeTextFile}}}` | `{isAuthenticated?: boolean}` | 协议握手，声明客户端能力 |
| `authenticate` | `{methodId: 'iflow'}` | — | 认证（isAuthenticated=false 时才发送） |
| `session/new` | `{cwd, mcpServers: [], settings}` | `{sessionId: string}` | 创建新会话 |
| `session/load` | `{sessionId, cwd, mcpServers: [], settings}` | — | 加载已有会话 |
| `session/prompt` | `{sessionId, prompt: [{type:'text', text}]}` | — | 发送用户消息（流式更新通过通知返回） |
| `session/cancel` | `{sessionId}` | — | 取消当前任务 |
| `session/set_mode` | `{sessionId, modeId}` | — | 设置会话模式 |
| `session/set_model` | `{sessionId, modelId}` | — | 设置使用的模型（失败时回退到 settings.json） |
| `session/set_think` | `{sessionId, thinkEnabled, thinkConfig?}` | — | 启用/禁用思考模式 |

### session/new 和 session/load 的 settings 字段

```typescript
{
  permission_mode: 'default' | 'yolo' | 'plan' | 'smart',
  append_system_prompt?: string,   // plan 模式时注入规划指令
  add_dirs?: string[],             // 文件访问白名单目录
}
```

### 服务端 → 客户端（服务端发起的请求，需回复）

| 方法 | 参数 | 客户端回复 | 说明 |
|------|------|----------|------|
| `session/request_permission` | `{toolCall: {title, toolName, kind}, options: PermissionOption[]}` | `{outcome: {outcome: 'selected'\|'cancelled', optionId?}}` | 工具调用权限审批 |
| `_iflow/user/questions` | `{questions: QuestionPrompt[]}` | `{answers: Record<string, string\|string[]>}` | 用户结构化问题 |
| `_iflow/plan/exit` | `{plan: string}` | `{approved: boolean}` | 计划审批（exit_plan_mode） |
| `fs/read_text_file` | `{path: string}` | `{content: string}` 或 `{error: string}` | 读取文件（PathPolicy 安全校验） |
| `fs/write_text_file` | `{path: string, content: string}` | `null` 或 `{error: string}` | 写入文件（PathPolicy 安全校验） |

### 服务端 → 客户端（通知，无需回复）

| 方法 | 参数 | 说明 |
|------|------|------|
| `session/update` | 见第 7 节 | 会话状态更新（文本/工具调用/计划/思考等） |

---

## 7. session/update 通知载荷

`session/update` 通知通过 `ChunkMapper.mapUpdateToChunks()` 转换为 `StreamChunk[]`。

### ACP 原生格式（`sessionUpdate` 字段）

| `sessionUpdate` 值 | 包含字段 | 产出 StreamChunk |
|-------------------|---------|-----------------|
| `agent_thought_chunk` | `content: {type: 'text', text}` | `thinking_start`（首次）+ `thinking_content` |
| `agent_message_chunk` | `content: {type: 'text', text}` | `thinking_end`（如在思考中）+ `text` |
| `tool_call` | `toolName, title, status, args, content, locations` | `tool_start`（+ 可选 `tool_output`） |
| `tool_call_update` | 同上 | `tool_start` + `tool_output`（completed/failed 时加 `tool_end`） |
| `plan` | `entries: [{content, status, priority}]` | `plan` |
| `available_commands_update` | — | （忽略） |
| `user_message_chunk` | — | （忽略） |

### `tool_call` / `tool_call_update` 详细结构

```typescript
{
  sessionUpdate: 'tool_call' | 'tool_call_update',
  toolName?: string,
  title?: string | null,           // 显示标签
  status?: 'pending' | 'in_progress' | 'completed' | 'failed' | null,
  args?: Record<string, unknown>,  // 工具参数
  content?: ToolContentEntry[],    // 工具结果（数组）
  locations?: [{path: string}] | null,  // 文件位置
  output?: string,
}
```

`content` 数组项类型：
- `{type: 'content', content: {type: 'text', text}}` → 产出 `tool_output`
- `{type: 'diff', fileDiff?, content?, path}` → 产出 `tool_output`（diff 文本）
- `{path?, newText?, oldText?, fileDiff?}` → 合并至 `tool_start.input`

---

## 8. 连接生命周期

### 状态机

```
disconnected
   │ ensureConnected()
   ▼
connecting                     ← 启动 CLI 子进程（如有需要）
   │ transport.connect()
   ▼
initializing                   ← startReceiveLoop() + initialize + authenticate + session/new|load
   │
   ▼
ready                          ← session/set_mode + session/set_model + session/set_think
   │
   ├─ 连接复用（cwd 未变）→ 仅更新 sessionId/mode/think/model
   ├─ cwd 变化 → teardown → 重新走 connecting 流程
   ├─ 意外断开 → disconnected（下次 run 重连）
   └─ dispose() → disposed（终止）
```

### 状态类型

```typescript
type ConnectionStatus = 'disconnected' | 'connecting' | 'initializing' | 'ready' | 'disposed';

interface ConnectionSnapshot {
  status: ConnectionStatus;
  isConnected: boolean;
  sessionId: string | null;
  connectedCwd: string | null;
  connectedMode: ConversationMode | null;
  lastError: string | null;
}
```

### 连接建立完整流程

```
1. 检查是否有运行中的 CLI 子进程
   └─ 无 → processManager.resolveStartMode() + startManagedProcess()
2. 创建 AcpTransport + 设置 onClose 回调
3. 创建 AcpProtocol
4. transport.connect({url: ws://localhost:{port}/acp, timeout})
5. interactionBridge.registerServerHandlers(protocol)
   ├─ session/request_permission
   ├─ _iflow/user/questions
   ├─ _iflow/plan/exit
   ├─ fs/read_text_file
   └─ fs/write_text_file
6. protocol.startReceiveLoop()
7. protocol.sendRequest('initialize', {protocolVersion: 1, clientCapabilities: {...}})
8. 若 !isAuthenticated → protocol.sendRequest('authenticate', {methodId: 'iflow'})
9. 若有 sessionId → session/load，否则 → session/new → 获取新 sessionId
10. runtimeConfigApplier.applySessionRuntimeSettings()
    ├─ session/set_mode
    ├─ session/set_model（逐候选尝试，失败回退 settings.json）
    └─ session/set_think
11. 状态 → ready
```

### 连接复用条件

**仅在 `cwd` 变化时重连**，其他情况（mode/model/think 变化）只发送对应的 `set_*` 请求，不重新建立 WebSocket 连接。

---

## 9. 交互式审批流

所有交互均通过 `InteractionBridge` 以原生服务端方法处理器实现，无需 monkey-patch。

### 工具权限审批

```
CLI Server
  │ session/request_permission { toolCall, options }
  ▼
InteractionBridge.registerServerHandlers → 处理器阻塞等待
  │ emitChunk({ chunkType: 'tool_confirmation', requestId, toolName, description, confirmationType })
  ▼
Webview 显示审批 UI → 用户点击 Allow/AlwaysAllow/Reject
  │ postMessage({ type: 'toolApproval', requestId, outcome })
  ▼
webviewHandler → acpClient.approveToolCall(requestId, outcome)
  │             或 acpClient.rejectToolCall(requestId)
  ▼
interactionBridge → pending.resolve({ outcome: { outcome: 'selected'|'cancelled', optionId? } })
  ▼
protocol.sendResult(id, result) → CLI Server 继续执行
```

`outcome` 与 `optionId` 映射：
- `'alwaysAllow'` → 优先匹配 kind=`allow_always`，次选 `allow_once`
- `'allow'` → 优先匹配 kind=`allow_once`，次选 `allow_always`
- 拒绝 → `{ outcome: 'cancelled' }`

### 用户问题审批

```
CLI Server
  │ _iflow/user/questions { questions: QuestionPrompt[] }
  ▼
InteractionBridge → emitChunk({ chunkType: 'user_question', requestId, questions })
  ▼
Webview 显示问题 UI → 用户填写答案
  │ postMessage({ type: 'questionAnswer', requestId, answers })
  ▼
acpClient.answerQuestions(requestId, answers)
  ▼
protocol.sendResult(id, { answers })
```

`QuestionPrompt` 结构：
```typescript
{
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
}
```

### 计划审批

```
CLI Server
  │ _iflow/plan/exit { plan: string }
  ▼
InteractionBridge → emitChunk({ chunkType: 'plan_approval', requestId, plan })
  ▼
Webview 显示计划审批 UI
  │ postMessage({ type: 'planApproval', requestId, option, feedback? })
  ▼
acpClient.approvePlan(requestId, approved)
  ▼
protocol.sendResult(id, { approved })
```

超时处理：所有交互请求设置 `interactionTimeoutMs`（默认 120 秒）超时，超时后自动发送取消结果并 emitChunk `warning`。

---

## 10. 文件系统安全策略（PathPolicy）

`src/acp/pathPolicy.ts` — 保护文件系统访问不越出工作区。

```typescript
pathPolicy.setBaseDir(cwd)
pathPolicy.setAllowedDirs([...workspaceFolderPaths])

// CLI 通过 fs/read_text_file 或 fs/write_text_file 请求文件时
pathPolicy.ensureAllowedPath(rawPath)
// → 解析绝对路径 + fs.realpathSync（解除符号链接）
// → 验证在 allowedDirs 白名单内
// → 不在白名单 → 抛出 "Access denied" 异常
```

`allowedDirs` 来自 `RunOptions.fileAllowedDirs`（不提供时默认为 `[cwd]`）。

---

## 11. 设置文件旁路（SettingsRepository）

`src/acp/settingsRepository.ts` — 直接操作 `~/.iflow/settings.json`。

部分配置不通过 JSON-RPC 传递，而是直接写入 CLI 的设置文件：

| 配置项 | JSON-RPC 方法 | settings.json 字段 | 说明 |
|-------|--------------|------------------|------|
| 模型 | `session/set_model`（优先） | `modelName` | 协议层失败时的 fallback |
| API BaseURL | 无 | `baseUrl` | 仅通过文件旁路设置 |

```typescript
// 每次 run() 开始前写入
settingsRepository.updateModel(model)    // 更新 modelName
settingsRepository.updateBaseUrl(url)    // 更新 baseUrl（若 iflow.baseUrl 配置了值）
```

模型 ID 映射（UI 名称 → CLI modelId）由 `RuntimeConfigApplier` 内的 `MODEL_ID_MAP` 维护：

```typescript
const MODEL_ID_MAP = {
  'GLM-4.7':                    'glm-4.7',
  'GLM-5':                      'glm-5',
  'DeepSeek-V3.2':              'deepseek-v3.2-chat',
  'iFlow-ROME-30BA3B(Preview)': 'iFlow-ROME-30BA3B',
  'Qwen3-Coder-Plus':           'qwen3-coder-plus',
  'Kimi-K2-Thinking':           'kimi-k2-thinking',
  'MiniMax-M2.5':               'minimax-m2.5',
  'MiniMax-M2.1':               'minimax-m2.1',
  'Kimi-K2-0905':               'kimi-k2-0905',
  'Kimi-K2.5':                  'kimi-k2.5',
}
```

---

## 12. ChunkMapper API

`src/chunkMapper.ts` — 将 ACP `session/update` payload 映射为 Webview 可渲染的 `StreamChunk`。

### 方法

| 方法 | 说明 |
|------|------|
| `reset()` | 重置 thinking 状态和 ThinkingParser，每次 run() 开始时调用 |
| `buildPrompt(options)` | 构建完整提示词字符串（工作区文件 + IDE 上下文 + 附件 + 用户输入） |
| `enrichToolInput(message)` | 合并 args/content/locations 为统一 input 对象（供 tool_start 使用） |
| `mapUpdateToChunks(payload)` | 核心映射方法：ACP payload → StreamChunk[] |
| `flushToChunks()` | 刷新 parser 残余状态（run 结束时调用） |

### buildPrompt 格式

```
=== Working Directory ===
{cwd}
=== End Working Directory ===

=== Workspace Files ===
{file1}\n{file2}\n...
=== End Workspace Files ===

=== IDE Context ===
Active File: {path}
Selected Text ({fileName}:{lineStart}-{lineEnd}):
{selectedText}
=== End IDE Context ===

=== Attached Files ===
--- {path} ---
{content}
[... truncated ...]
=== End Attached Files ===

{userPrompt}
```

### Thinking 检测双策略

1. **ACP 原生 thinking**：`sessionUpdate = 'agent_thought_chunk'` 触发 `thinking_start/content/end`
2. **内联 `<think>` 标签**：`ThinkingParser` 状态机检测 `<think>`/`</think>` 并产出相同 chunk 类型（`agent_message_chunk` 中的文本经此解析）

---

## 13. StreamChunk 类型参考

`src/protocol.ts` — 所有 StreamChunk 变体。

```typescript
type StreamChunk =
  | { chunkType: 'text'; content: string }
  | { chunkType: 'code_start'; language: string; filename?: string }
  | { chunkType: 'code_content'; content: string }
  | { chunkType: 'code_end' }
  | { chunkType: 'tool_start'; name: string; input: Record<string, unknown>; label?: string }
  | { chunkType: 'tool_output'; content: string }
  | { chunkType: 'tool_end'; status: 'completed' | 'error' }
  | { chunkType: 'tool_confirmation'; requestId: number; toolName: string; description: string; confirmationType: string }
  | { chunkType: 'user_question'; requestId: number; questions: QuestionPrompt[] }
  | { chunkType: 'plan_approval'; requestId: number; plan: string }
  | { chunkType: 'thinking_start' }
  | { chunkType: 'thinking_content'; content: string }
  | { chunkType: 'thinking_end' }
  | { chunkType: 'file_ref'; path: string; lineStart?: number; lineEnd?: number }
  | { chunkType: 'plan'; entries: Array<{ content: string; status: string; priority: string }> }
  | { chunkType: 'error'; message: string }
  | { chunkType: 'warning'; message: string };
```

---

## 14. ProcessManager API

`src/processManager.ts` — iFlow CLI 子进程生命周期管理（与原 API.md 保持一致，无变更）。

### 方法

| 方法 | 签名 | 说明 |
|------|------|------|
| `resolveStartMode()` | `(config: {nodePath: string\|null; port: number}) => Promise<{nodePath, iflowScript, port}\|null>` | 三层解析 CLI 启动信息 |
| `startManagedProcess()` | `(nodePath, port, iflowScript?, cwd?) => Promise<void>` | 启动 CLI 子进程 |
| `stopManagedProcess()` | `() => void` | 停止子进程（SIGTERM） |
| `clearAutoDetectCache()` | `() => void` | 清除自动检测缓存 |
| `hasProcess` | `boolean` (getter) | 是否有运行中的子进程 |

### 三层启动解析

```
Tier 1: iflow.nodePath 用户配置 → 使用指定 Node 路径
Tier 2: autoDetectNodePath() → PATH / Shell / nvm / volta / 常见安装目录
Tier 3: return null → 抛出 "iFlow CLI not found" 错误
```

### 子进程启动参数

```
node <iflowScript> --experimental-acp --port <N>
```

启动后等待 WebSocket 可达（最多 20 次健康检查，每次间隔 300ms，总超时 30 秒）。

---

## 15. WebviewHandler 消息调度

`src/webviewHandler.ts` — Webview 消息路由。

### WebviewMessage → 处理逻辑

| WebviewMessage.type | ACP 交互 |
|---------------------|---------|
| `sendMessage` | `acpClient.run()` |
| `toolApproval` (allow/alwaysAllow) | `acpClient.approveToolCall(requestId, outcome)` |
| `toolApproval` (reject) | `acpClient.rejectToolCall(requestId)` + `acpClient.cancel()` |
| `questionAnswer` | `acpClient.answerQuestions(requestId, answers)` |
| `planApproval` (smart/default) | 切换 mode + 自动发送执行消息 |
| `planApproval` (keep) | 保持 plan 模式，approvePlan(false) |
| `planApproval` (feedback) | 将 feedback 作为新消息发送（仍在 plan 模式） |
| `cancelCurrent` | `acpClient.cancel()` |
| `recheckCli` | `acpClient.dispose()` + `clearAutoDetectCache()` + 重新检测 |

### planApproval 选项处理

| option | 行为 |
|--------|------|
| `smart` | 切换 mode 为 smart，自动发送执行消息 |
| `default` | 切换 mode 为 default，自动发送执行消息 |
| `keep` | 保持 plan 模式，`approvePlan(requestId, false)` |
| `feedback` | 将 feedback 文本作为新消息发送（仍在 plan 模式） |

requestId=-1 表示合成审批（AI 自然结束而非调用 exit_plan_mode）。

---

## 16. cliDiscovery API

`src/cliDiscovery.ts` — 跨平台 iFlow CLI 路径发现（与原 API.md 保持一致，无变更）。

### 导出函数

| 函数 | 说明 |
|------|------|
| `findIFlowPathCrossPlatform(log)` | 发现 iflow CLI 二进制路径 |
| `resolveIFlowScriptCrossPlatform(iflowPath, log)` | 从二进制路径解析 JS 入口脚本 |
| `deriveNodePathFromIFlow(iflowPath, log)` | 从 iflow 位置推导 node 路径 |

### 发现策略

**Unix:** `which iflow` → `$SHELL -lc "which iflow"` → `fs.realpathSync()`

**Windows:** `where iflow` → `%APPDATA%\npm\iflow{.ps1,.cmd}` → 解析包装文件提取 JS 入口

所有函数失败时返回 `null`，不抛异常。

---

## 附录：与旧 SDK 方案的对比

| 方面 | 旧方案（@iflow-ai/iflow-cli-sdk） | 新方案（自研 ACP 栈） |
|------|----------------------------------|---------------------|
| 依赖 | `@iflow-ai/iflow-cli-sdk ^0.1.9` | 无外部 SDK 依赖 |
| 消息丢失修复 | `patchTransport()` monkey-patch | `AcpTransport` 原生持久监听器 + 缓冲队列 |
| 权限审批 | `patchPermission()` monkey-patch | `InteractionBridge.registerServerHandlers()` 原生处理 |
| 问题/计划拦截 | `patchQuestions()` monkey-patch | `InteractionBridge` 原生处理 `_iflow/user/questions` / `_iflow/plan/exit` |
| 连接复用 | `ensureConnected()` 包裹 SDK | `SessionCoordinator.ensureConnected()` |
| 会话状态 | 字段散落在 IFlowClient | `ConnectionSnapshot` 结构化状态机 |
| 模型切换 | 全量重连 | `session/set_model` 运行时更新（无需重连） |
| 模式切换 | mode 变化 → 重连 | `session/set_mode` 运行时更新（无需重连） |
| ChunkMapper 输入 | SDK `Message` 对象 | 直接处理 ACP `session/update` payload |
