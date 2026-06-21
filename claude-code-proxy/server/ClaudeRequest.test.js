const ClaudeRequest = require('./ClaudeRequest');

jest.mock('./Logger', () => ({
  info: jest.fn(),
  debug: jest.fn(),
  error: jest.fn(),
  warn: jest.fn()
}));

jest.mock('./OAuthManager', () => ({
  isAuthenticated: jest.fn().mockReturnValue(false),
  getValidAccessToken: jest.fn()
}));

describe('ClaudeRequest', () => {
  it('adds compaction beta when context_management is present', () => {
    const request = new ClaudeRequest();
    const headers = request.getHeaders('Bearer test', {
      context_management: {
        edits: [{ type: 'compact_20260112' }]
      }
    });

    expect(headers['anthropic-beta']).toContain('context-management-2025-06-27');
    expect(headers['anthropic-beta']).toContain('compact-2026-01-12');
    expect(headers['anthropic-beta']).toContain('claude-code-20250219');
  });

  it('preserves incoming anthropic-beta values', () => {
    const request = new ClaudeRequest({
      headers: {
        'anthropic-beta': 'custom-beta-2026-01-01'
      }
    });

    const headers = request.getHeaders('Bearer test', {});
    expect(headers['anthropic-beta']).toContain('custom-beta-2026-01-01');
  });

  it('deduplicates repeated beta headers', () => {
    const request = new ClaudeRequest({
      headers: {
        'anthropic-beta': 'compact-2026-01-12'
      }
    });

    const headers = request.getHeaders('Bearer test', {
      context_management: {
        edits: [{ type: 'compact_20260112' }]
      }
    });

    const compactBetas = headers['anthropic-beta']
      .split(',')
      .map(beta => beta.trim())
      .filter(beta => beta === 'compact-2026-01-12');

    expect(compactBetas).toHaveLength(1);
  });
});
