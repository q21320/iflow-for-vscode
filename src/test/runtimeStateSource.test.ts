import * as assert from 'assert';
import { RuntimeStateSource } from '../store/runtimeStateSource';

suite('RuntimeStateSource', () => {
  test('returns cloned snapshots to prevent external mutation', () => {
    const source = new RuntimeStateSource();
    source.setWorkspaceFolders([{ uri: '/a', name: 'A' }]);

    const snapshot = source.getSnapshot();
    snapshot.workspaceFolders[0].name = 'mutated';
    snapshot.workspaceFolders.push({ uri: '/b', name: 'B' });

    const next = source.getSnapshot();
    assert.strictEqual(next.workspaceFolders.length, 1);
    assert.strictEqual(next.workspaceFolders[0].name, 'A');
  });

  test('derives isMultiRoot from current workspace folders', () => {
    const source = new RuntimeStateSource();
    assert.strictEqual(source.getSnapshot().isMultiRoot, false);

    source.setWorkspaceFolders([{ uri: '/a', name: 'A' }, { uri: '/b', name: 'B' }]);
    assert.strictEqual(source.getSnapshot().isMultiRoot, true);

    source.setWorkspaceFolders([{ uri: '/a', name: 'A' }]);
    assert.strictEqual(source.getSnapshot().isMultiRoot, false);
  });
});
