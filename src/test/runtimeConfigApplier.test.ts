import * as assert from 'assert';
import { RuntimeConfigApplier } from '../acp/runtimeConfigApplier';

suite('RuntimeConfigApplier', () => {
  test('buildSessionSettings injects plan guard instructions without exit_plan_mode requirement', () => {
    const applier = new RuntimeConfigApplier(() => {});
    const settings = applier.buildSessionSettings({
      prompt: 'plan this',
      attachedFiles: [],
      mode: 'plan',
      think: false,
      model: 'GLM-4.7',
    });

    assert.strictEqual(settings.permission_mode, 'plan');
    assert.strictEqual(typeof settings.append_system_prompt, 'string');
    assert.ok(!(settings.append_system_prompt as string).includes('exit_plan_mode'));
  });

  test('buildSessionSettings includes allowed dirs when provided', () => {
    const applier = new RuntimeConfigApplier(() => {});
    const settings = applier.buildSessionSettings({
      prompt: 'hello',
      attachedFiles: [],
      mode: 'default',
      think: false,
      model: 'GLM-4.7',
      fileAllowedDirs: ['/tmp/workspace'],
    });

    assert.deepStrictEqual(settings, {
      permission_mode: 'default',
      append_system_prompt: '',
      add_dirs: ['/tmp/workspace'],
    });
  });

  test('buildSessionSettings clears plan system prompt in non-plan modes', () => {
    const applier = new RuntimeConfigApplier(() => {});
    const settings = applier.buildSessionSettings({
      prompt: 'execute this',
      attachedFiles: [],
      mode: 'smart',
      think: false,
      model: 'GLM-4.7',
    });

    assert.deepStrictEqual(settings, {
      permission_mode: 'smart',
      append_system_prompt: '',
    });
  });
});
