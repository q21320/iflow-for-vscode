import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PathPolicy } from '../acp/pathPolicy';

suite('PathPolicy', () => {
  test('allows paths inside configured directories', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-path-policy-'));
    const filePath = path.join(tmpRoot, 'a.txt');
    fs.writeFileSync(filePath, 'ok', 'utf-8');

    const policy = new PathPolicy();
    policy.setBaseDir(tmpRoot);
    policy.setAllowedDirs([tmpRoot]);

    const resolved = policy.ensureAllowedPath(filePath);
    assert.ok(resolved.endsWith('a.txt'));

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('rejects paths outside configured directories', () => {
    const allowedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-path-policy-allow-'));
    const deniedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-path-policy-deny-'));
    const deniedFile = path.join(deniedRoot, 'b.txt');
    fs.writeFileSync(deniedFile, 'no', 'utf-8');

    const policy = new PathPolicy();
    policy.setBaseDir(allowedRoot);
    policy.setAllowedDirs([allowedRoot]);

    assert.throws(
      () => policy.ensureAllowedPath(deniedFile),
      /outside allowed directories/,
    );

    fs.rmSync(allowedRoot, { recursive: true, force: true });
    fs.rmSync(deniedRoot, { recursive: true, force: true });
  });

  test('rejects when allowed directories are not configured (fail-closed)', () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-path-policy-empty-'));
    const target = path.join(tmpRoot, 'a.txt');
    fs.writeFileSync(target, 'x', 'utf-8');

    const policy = new PathPolicy();
    policy.setBaseDir(tmpRoot);

    assert.throws(
      () => policy.ensureAllowedPath(target),
      /no allowed directories configured/,
    );

    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('rejects ../ path traversal that escapes allowed root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-path-policy-traverse-'));
    const allowedRoot = path.join(root, 'allowed');
    const outsideRoot = path.join(root, 'outside');
    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    fs.writeFileSync(path.join(outsideRoot, 'secret.txt'), 'nope', 'utf-8');

    const policy = new PathPolicy();
    policy.setBaseDir(allowedRoot);
    policy.setAllowedDirs([allowedRoot]);

    assert.throws(
      () => policy.ensureAllowedPath('../outside/secret.txt'),
      /outside allowed directories/,
    );

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('rejects symlink escape outside allowed root', function () {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-path-policy-symlink-'));
    const allowedRoot = path.join(root, 'allowed');
    const outsideRoot = path.join(root, 'outside');
    fs.mkdirSync(allowedRoot, { recursive: true });
    fs.mkdirSync(outsideRoot, { recursive: true });
    const outsideFile = path.join(outsideRoot, 'secret.txt');
    fs.writeFileSync(outsideFile, 'secret', 'utf-8');

    const linkPath = path.join(allowedRoot, 'link-to-outside.txt');

    try {
      fs.symlinkSync(outsideFile, linkPath);
    } catch {
      this.skip();
      return;
    }

    const policy = new PathPolicy();
    policy.setBaseDir(allowedRoot);
    policy.setAllowedDirs([allowedRoot]);

    assert.throws(
      () => policy.ensureAllowedPath(linkPath),
      /outside allowed directories/,
    );

    fs.rmSync(root, { recursive: true, force: true });
  });

  test('treats case-insensitive windows path as same root', () => {
    if (process.platform !== 'win32') {
      return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iflow-path-policy-win-'));
    const filePath = path.join(root, 'Demo.txt');
    fs.writeFileSync(filePath, 'ok', 'utf-8');

    const policy = new PathPolicy();
    policy.setBaseDir(root.toUpperCase());
    policy.setAllowedDirs([root.toUpperCase()]);

    const resolved = policy.ensureAllowedPath(filePath.toLowerCase());
    assert.ok(resolved.toLowerCase().endsWith('demo.txt'));

    fs.rmSync(root, { recursive: true, force: true });
  });
});
