import * as assert from 'assert';
import { normalizeErrorMessage } from '../errorUtils';

suite('errorUtils', () => {
  test('normalizeErrorMessage trims non-empty strings', () => {
    assert.strictEqual(normalizeErrorMessage('  failed  '), 'failed');
  });

  test('normalizeErrorMessage falls back for empty Error message', () => {
    assert.strictEqual(
      normalizeErrorMessage(new Error(''), 'fallback'),
      'fallback',
    );
  });

  test('normalizeErrorMessage serializes objects', () => {
    assert.strictEqual(
      normalizeErrorMessage({ reason: 'bad input' }),
      '{"reason":"bad input"}',
    );
  });
});
