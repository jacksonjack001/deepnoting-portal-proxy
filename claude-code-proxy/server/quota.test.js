const { parseQuotaHeaders } = require('./quota');

describe('parseQuotaHeaders', () => {
  it('parses unified quota headers from Claude subscription responses', () => {
    const quota = parseQuotaHeaders({
      'anthropic-ratelimit-unified-status': 'allowed',
      'anthropic-ratelimit-unified-5h-status': 'allowed',
      'anthropic-ratelimit-unified-5h-reset': '1781812200',
      'anthropic-ratelimit-unified-5h-utilization': '0.16',
      'anthropic-ratelimit-unified-7d-status': 'allowed',
      'anthropic-ratelimit-unified-7d-reset': '1781953200',
      'anthropic-ratelimit-unified-7d-utilization': '0.41',
      'anthropic-ratelimit-unified-representative-claim': 'five_hour',
      'anthropic-ratelimit-unified-fallback-percentage': '0.5',
      'anthropic-ratelimit-unified-reset': '1781812200',
      'anthropic-ratelimit-unified-overage-status': 'rejected'
    });

    expect(quota.unified.status).toBe('allowed');
    expect(quota.unified.five_hour.utilization).toBe(0.16);
    expect(quota.unified.seven_day.utilization).toBe(0.41);
    expect(quota.unified.representative_claim).toBe('five_hour');
    expect(quota.unified.overage_status).toBe('rejected');
    expect(quota.unified.five_hour.reset_at).toBe('2026-06-18T19:50:00.000Z');
  });

  it('parses classic rate limit headers when available', () => {
    const quota = parseQuotaHeaders({
      'anthropic-ratelimit-requests-limit': '60',
      'anthropic-ratelimit-requests-remaining': '42',
      'anthropic-ratelimit-requests-reset': '2026-06-18T16:00:00Z'
    });

    expect(quota.classic.requests.limit).toBe(60);
    expect(quota.classic.requests.remaining).toBe(42);
    expect(quota.classic.requests.reset_at).toBe('2026-06-18T16:00:00.000Z');
  });
});
