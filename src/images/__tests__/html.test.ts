import { describe, it, expect } from 'vitest';
import { escapeHtml, safeUrl } from '@images/html';

describe('escapeHtml', () => {
  it('escapes all five metacharacters, not just four', () => {
    // The drift this file exists to prevent: three of the four old copies
    // stopped at `"` and left `'` raw. It was only safe because every attribute
    // was double-quoted.
    expect(escapeHtml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&#039;');
  });

  it('escapes ampersand before the others', () => {
    // Escaping & last would turn the & in "&lt;" into "&amp;lt;".
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('&lt;')).toBe('&amp;lt;');
  });

  it('escapes every occurrence, not just the first', () => {
    expect(escapeHtml('a<b<c')).toBe('a&lt;b&lt;c');
  });

  it('cannot break out of a single-quoted attribute', () => {
    // The case the old copies would have failed.
    const hostile = `' onerror='alert(1)`;
    expect(escapeHtml(hostile)).not.toContain("'");
  });

  it('cannot break out of a double-quoted attribute', () => {
    const hostile = `" onerror="alert(1)`;
    expect(escapeHtml(hostile)).not.toContain('"');
  });

  it('leaves ordinary text alone', () => {
    expect(escapeHtml('Mac DeMarco - I Like Her')).toBe('Mac DeMarco - I Like Her');
  });

  it('handles an empty string', () => {
    expect(escapeHtml('')).toBe('');
  });
});

describe('safeUrl', () => {
  it('allows https', () => {
    expect(safeUrl('https://example.com/a.png')).toBe('https://example.com/a.png');
  });

  it('allows the data:image URIs this codebase actually produces', () => {
    // receiptGenerator builds data:image/png at runtime; the render tests feed
    // 1x1 gifs. https-only would have broken both.
    expect(safeUrl('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(safeUrl('data:image/gif;base64,R0lGODlhAQABAAAAACw=')).toBe(
      'data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    );
  });

  it('rejects data:image/svg+xml, which can carry script', () => {
    expect(safeUrl('data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')).toBeNull();
  });

  it('rejects javascript: and data:text/html', () => {
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects plain http as mixed content', () => {
    expect(safeUrl('http://example.com/a.png')).toBeNull();
  });

  it('rejects empty and whitespace', () => {
    expect(safeUrl('')).toBeNull();
    expect(safeUrl('   ')).toBeNull();
    expect(safeUrl(null)).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });

  it('is case insensitive on the scheme', () => {
    // AGENTS.md section 9: probe before assuming. A provider returning
    // HTTPS:// or Data: must not be silently dropped.
    expect(safeUrl('HTTPS://example.com/a.png')).toBe('HTTPS://example.com/a.png');
  });

  it('does not accept a scheme smuggled past a prefix', () => {
    expect(safeUrl('https://ok.example https://evil.example')).toBeNull();
  });
});
