import * as assert from 'assert';
import { AppError, classifyAppErrorCode, normalizeErrorMessage, toAppError } from '../errorUtils';

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

  test('classifyAppErrorCode detects missing session', () => {
    assert.strictEqual(
      classifyAppErrorCode('[JSON-RPC -32600] Invalid request (data: {"details":"Session not found: stale-1"})'),
      'MISSING_SESSION',
    );
  });

  test('classifyAppErrorCode detects cli unavailable', () => {
    assert.strictEqual(
      classifyAppErrorCode('connect ECONNREFUSED 127.0.0.1:8090'),
      'CLI_UNAVAILABLE',
    );
  });

  test('toAppError wraps unknown input into AppError', () => {
    const appError = toAppError({ reason: 'bad input' });
    assert.ok(appError instanceof AppError);
    assert.strictEqual(appError.code, 'UNKNOWN');
    assert.strictEqual(appError.message, '{"reason":"bad input"}');
    assert.deepStrictEqual(appError.details, { reason: 'bad input' });
  });

  test('toAppError keeps AppError code and applies fallback message', () => {
    const original = new AppError('', { code: 'MISSING_SESSION' });
    const appError = toAppError(original, 'fallback');
    assert.strictEqual(appError.code, 'MISSING_SESSION');
    assert.strictEqual(appError.message, 'fallback');
  });
});
