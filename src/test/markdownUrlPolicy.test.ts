import * as assert from 'assert';
import { sanitizeMarkdownLinkHref } from '../markdownUrlPolicy';

suite('markdownUrlPolicy', () => {
  test('allows http/https/mailto links', () => {
    assert.strictEqual(
      sanitizeMarkdownLinkHref('https://example.com/docs'),
      'https://example.com/docs',
    );
    assert.strictEqual(
      sanitizeMarkdownLinkHref('http://example.com/docs'),
      'http://example.com/docs',
    );
    assert.strictEqual(
      sanitizeMarkdownLinkHref('mailto:hello@example.com'),
      'mailto:hello@example.com',
    );
  });

  test('rejects javascript/data links', () => {
    assert.strictEqual(sanitizeMarkdownLinkHref('javascript:alert(1)'), null);
    assert.strictEqual(sanitizeMarkdownLinkHref('data:text/html;base64,PHNjcmlwdD4='), null);
  });

  test('rejects obfuscated protocol with whitespace', () => {
    assert.strictEqual(sanitizeMarkdownLinkHref('java\nscript:alert(1)'), null);
  });
});
