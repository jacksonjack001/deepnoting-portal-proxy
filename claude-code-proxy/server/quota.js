function normalizeHeaders(headers = {}) {
  return Object.entries(headers).reduce((acc, [key, value]) => {
    acc[String(key).toLowerCase()] = Array.isArray(value) ? value.join(",") : value;
    return acc;
  }, {});
}

function parseNumber(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseReset(value) {
  if (!value) {
    return null;
  }

  if (/^\d+$/.test(String(value))) {
    const unixSeconds = Number(value);
    if (Number.isFinite(unixSeconds)) {
      return new Date(unixSeconds * 1000).toISOString();
    }
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseBucket(prefix, headers) {
  return {
    limit: parseNumber(headers[`${prefix}-limit`]),
    remaining: parseNumber(headers[`${prefix}-remaining`]),
    reset_at: parseReset(headers[`${prefix}-reset`])
  };
}

function isBucketEmpty(bucket) {
  return bucket.limit === null && bucket.remaining === null && bucket.reset_at === null;
}

function parseQuotaHeaders(rawHeaders = {}) {
  const headers = normalizeHeaders(rawHeaders);
  const hasRateLimitHeaders = Object.keys(headers).some((key) => key.startsWith("anthropic-ratelimit-"));

  if (!hasRateLimitHeaders && headers["retry-after"] === undefined) {
    return null;
  }

  const unified = {
    status: headers["anthropic-ratelimit-unified-status"] || null,
    representative_claim: headers["anthropic-ratelimit-unified-representative-claim"] || null,
    reset_at: parseReset(headers["anthropic-ratelimit-unified-reset"]),
    fallback_percentage: parseNumber(headers["anthropic-ratelimit-unified-fallback-percentage"]),
    overage_status: headers["anthropic-ratelimit-unified-overage-status"] || null,
    overage_disabled_reason: headers["anthropic-ratelimit-unified-overage-disabled-reason"] || null,
    five_hour: {
      status: headers["anthropic-ratelimit-unified-5h-status"] || null,
      reset_at: parseReset(headers["anthropic-ratelimit-unified-5h-reset"]),
      utilization: parseNumber(headers["anthropic-ratelimit-unified-5h-utilization"])
    },
    seven_day: {
      status: headers["anthropic-ratelimit-unified-7d-status"] || null,
      reset_at: parseReset(headers["anthropic-ratelimit-unified-7d-reset"]),
      utilization: parseNumber(headers["anthropic-ratelimit-unified-7d-utilization"])
    }
  };

  const classic = {
    requests: parseBucket("anthropic-ratelimit-requests", headers),
    tokens: parseBucket("anthropic-ratelimit-tokens", headers),
    input_tokens: parseBucket("anthropic-ratelimit-input-tokens", headers),
    output_tokens: parseBucket("anthropic-ratelimit-output-tokens", headers)
  };

  return {
    updated_at: new Date().toISOString(),
    retry_after_seconds: parseNumber(headers["retry-after"]),
    unified: (
      unified.status ||
      unified.five_hour.status ||
      unified.seven_day.status ||
      unified.reset_at
    ) ? unified : null,
    classic: (
      !isBucketEmpty(classic.requests) ||
      !isBucketEmpty(classic.tokens) ||
      !isBucketEmpty(classic.input_tokens) ||
      !isBucketEmpty(classic.output_tokens)
    ) ? classic : null
  };
}

module.exports = {
  normalizeHeaders,
  parseQuotaHeaders
};
