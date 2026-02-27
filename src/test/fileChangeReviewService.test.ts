import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { FileChangeReviewService } from '../webview/fileChangeReviewService';

interface CommandCall {
  command: string;
  args: unknown[];
}

function createServiceHarness(): {
  service: FileChangeReviewService;
  calls: CommandCall[];
} {
  const calls: CommandCall[] = [];
  const service = new FileChangeReviewService({
    executeCommand: async (command, ...rest) => {
      calls.push({ command, args: rest });
      return undefined;
    },
    registerTextDocumentContentProvider: (_scheme, _provider) => ({ dispose() {} }) as vscode.Disposable,
    log: () => {},
  });

  return { service, calls };
}

function startRound(
  service: FileChangeReviewService,
  workspaceDir: string,
  conversationId = 'conv-1',
  assistantMessageId = 'msg-1',
): { conversationId: string; assistantMessageId: string } {
  service.startRun({
    conversationId,
    assistantMessageId,
    cwd: workspaceDir,
    allowedDirs: [workspaceDir],
  });
  return { conversationId, assistantMessageId };
}

suite('FileChangeReviewService', () => {
  test('tracks single file edit and produces per-file stats', () => {
    const { service } = createServiceHarness();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-file-change-'));
    const filePath = path.join(tempDir, 'single.ts');
    fs.writeFileSync(filePath, 'a\nb\n', 'utf-8');

    try {
      const round = startRound(service, tempDir);
      service.onChunk({
        chunkType: 'tool_start',
        name: 'edit_file',
        input: { file_path: filePath },
      });
      fs.writeFileSync(filePath, 'a\nc\nd\n', 'utf-8');
      service.onChunk({ chunkType: 'tool_end', status: 'completed' });

      const summary = service.finalizeRun({
        conversationId: round.conversationId,
        assistantMessageId: round.assistantMessageId,
        succeeded: true,
      });
      assert.strictEqual(summary.changedFiles.length, 1);
      assert.strictEqual(summary.changedFiles[0].path, filePath);
      assert.strictEqual(summary.changedFiles[0].added, 2);
      assert.strictEqual(summary.changedFiles[0].removed, 1);
      assert.strictEqual(summary.totalAdded, 2);
      assert.strictEqual(summary.totalRemoved, 1);
    } finally {
      service.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('counts multi-hunk insertions without inflating unchanged middle lines', () => {
    const { service } = createServiceHarness();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-file-change-'));
    const filePath = path.join(tempDir, 'multihunk.ts');
    fs.writeFileSync(filePath, 'a\nb\nc\nd\ne\n', 'utf-8');

    try {
      const round = startRound(service, tempDir);
      service.onChunk({
        chunkType: 'tool_start',
        name: 'edit_file',
        input: { file_path: filePath },
      });
      fs.writeFileSync(filePath, 'a\nx\nb\nc\nd\ny\ne\n', 'utf-8');
      service.onChunk({ chunkType: 'tool_end', status: 'completed' });
      const summary = service.finalizeRun({
        conversationId: round.conversationId,
        assistantMessageId: round.assistantMessageId,
        succeeded: true,
      });

      assert.strictEqual(summary.changedFiles.length, 1);
      assert.strictEqual(summary.changedFiles[0].added, 2);
      assert.strictEqual(summary.changedFiles[0].removed, 0);
    } finally {
      service.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('aggregates totals across multiple changed files', () => {
    const { service } = createServiceHarness();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-file-change-'));
    const aPath = path.join(tempDir, 'a.ts');
    const bPath = path.join(tempDir, 'b.ts');
    fs.writeFileSync(aPath, 'line1\nline2\n', 'utf-8');

    try {
      const round = startRound(service, tempDir);

      service.onChunk({
        chunkType: 'tool_start',
        name: 'edit_file',
        input: { file_path: aPath },
      });
      fs.writeFileSync(aPath, 'line1\nline2-mod\nline3\n', 'utf-8');
      service.onChunk({ chunkType: 'tool_end', status: 'completed' });

      service.onChunk({
        chunkType: 'tool_start',
        name: 'write_file',
        input: { file_path: bPath },
      });
      fs.writeFileSync(bPath, 'x\ny\n', 'utf-8');
      service.onChunk({ chunkType: 'tool_end', status: 'completed' });

      const summary = service.finalizeRun({
        conversationId: round.conversationId,
        assistantMessageId: round.assistantMessageId,
        succeeded: true,
      });

      assert.strictEqual(summary.changedFiles.length, 2);
      assert.strictEqual(summary.totalAdded, 4);
      assert.strictEqual(summary.totalRemoved, 1);
    } finally {
      service.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rollback deletes newly created file', async () => {
    const { service } = createServiceHarness();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-file-change-'));
    const createdPath = path.join(tempDir, 'created.ts');

    try {
      const round = startRound(service, tempDir);
      service.onChunk({
        chunkType: 'tool_start',
        name: 'write_file',
        input: { file_path: createdPath },
      });
      fs.writeFileSync(createdPath, 'new content\n', 'utf-8');
      service.onChunk({ chunkType: 'tool_end', status: 'completed' });
      const summary = service.finalizeRun({
        conversationId: round.conversationId,
        assistantMessageId: round.assistantMessageId,
        succeeded: true,
      });
      assert.strictEqual(summary.changedFiles[0].kind, 'created');

      const updated = await service.handleAction({
        action: 'rollback',
        conversationId: round.conversationId,
        assistantMessageId: round.assistantMessageId,
        path: createdPath,
      });
      assert.strictEqual(fs.existsSync(createdPath), false);
      assert.strictEqual(updated.changedFiles[0].status, 'reverted');
    } finally {
      service.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rollback restores modified file content', async () => {
    const { service } = createServiceHarness();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-file-change-'));
    const filePath = path.join(tempDir, 'modified.ts');
    fs.writeFileSync(filePath, 'before\n', 'utf-8');

    try {
      const round = startRound(service, tempDir);
      service.onChunk({
        chunkType: 'tool_start',
        name: 'edit_file',
        input: { file_path: filePath },
      });
      fs.writeFileSync(filePath, 'after\n', 'utf-8');
      service.onChunk({ chunkType: 'tool_end', status: 'completed' });
      service.finalizeRun({
        conversationId: round.conversationId,
        assistantMessageId: round.assistantMessageId,
        succeeded: true,
      });

      const updated = await service.handleAction({
        action: 'rollback',
        conversationId: round.conversationId,
        assistantMessageId: round.assistantMessageId,
        path: filePath,
      });
      assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'before\n');
      assert.strictEqual(updated.changedFiles[0].status, 'reverted');
    } finally {
      service.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('rollback recreates deleted file', async () => {
    const { service } = createServiceHarness();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-file-change-'));
    const filePath = path.join(tempDir, 'deleted.ts');
    fs.writeFileSync(filePath, 'to be restored\n', 'utf-8');

    try {
      const round = startRound(service, tempDir);
      service.onChunk({
        chunkType: 'tool_start',
        name: 'delete_file',
        input: { file_path: filePath },
      });
      fs.unlinkSync(filePath);
      service.onChunk({ chunkType: 'tool_end', status: 'completed' });
      const summary = service.finalizeRun({
        conversationId: round.conversationId,
        assistantMessageId: round.assistantMessageId,
        succeeded: true,
      });
      assert.strictEqual(summary.changedFiles[0].kind, 'deleted');

      await service.handleAction({
        action: 'rollback',
        conversationId: round.conversationId,
        assistantMessageId: round.assistantMessageId,
        path: filePath,
      });
      assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'to be restored\n');
    } finally {
      service.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('ignores paths outside workspace allowed dirs', () => {
    const { service } = createServiceHarness();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-file-change-'));
    const outsideFile = path.join(os.tmpdir(), `outside-${Date.now()}.txt`);
    fs.writeFileSync(outsideFile, 'x\n', 'utf-8');

    try {
      const round = startRound(service, tempDir);
      service.onChunk({
        chunkType: 'tool_start',
        name: 'edit_file',
        input: { file_path: outsideFile },
      });
      fs.writeFileSync(outsideFile, 'y\n', 'utf-8');
      service.onChunk({ chunkType: 'tool_end', status: 'completed' });
      const summary = service.finalizeRun({
        conversationId: round.conversationId,
        assistantMessageId: round.assistantMessageId,
        succeeded: true,
      });
      assert.strictEqual(summary.changedFiles.length, 0);
    } finally {
      service.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
      if (fs.existsSync(outsideFile)) {
        fs.unlinkSync(outsideFile);
      }
    }
  });

  test('openDiff invokes vscode.diff with before snapshot uri', async () => {
    const { service, calls } = createServiceHarness();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-file-change-'));
    const filePath = path.join(tempDir, 'preview.ts');
    fs.writeFileSync(filePath, 'old\n', 'utf-8');

    try {
      const round = startRound(service, tempDir);
      service.onChunk({
        chunkType: 'tool_start',
        name: 'edit_file',
        input: { file_path: filePath },
      });
      fs.writeFileSync(filePath, 'new\n', 'utf-8');
      service.onChunk({ chunkType: 'tool_end', status: 'completed' });
      service.finalizeRun({
        conversationId: round.conversationId,
        assistantMessageId: round.assistantMessageId,
        succeeded: true,
      });

      await service.handleAction({
        action: 'openDiff',
        conversationId: round.conversationId,
        assistantMessageId: round.assistantMessageId,
        path: filePath,
      });

      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].command, 'vscode.diff');
      const beforeUri = calls[0].args[0] as vscode.Uri;
      const afterUri = calls[0].args[1] as vscode.Uri;
      const title = calls[0].args[2] as string;
      assert.ok(beforeUri);
      assert.strictEqual(afterUri.fsPath, filePath);
      assert.ok(title.includes('preview.ts'));
    } finally {
      service.dispose();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
