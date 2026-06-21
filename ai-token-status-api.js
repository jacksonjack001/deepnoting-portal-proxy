#!/usr/bin/env node

const http = require("http");

const PORT = Number(process.env.AI_STATUS_PORT || 42124);
const HOST = process.env.AI_STATUS_HOST || "127.0.0.1";
const CLAUDE_BASE_URL = (process.env.CLAUDE_STATUS_BASE_URL || "http://127.0.0.1:42069").replace(/\/$/, "");
const CODEX_BASE_URL = (process.env.CODEX_STATUS_BASE_URL || "http://127.0.0.1:8080").replace(/\/$/, "");
const REQUEST_TIMEOUT_MS = Number(process.env.AI_STATUS_TIMEOUT_MS || 8000);

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  res.end(JSON.stringify(payload, null, 2));
}

function isTruthyQuery(value) {
  return value === "1" || value === "true" || value === "yes";
}

function toIsoOrNull(value) {
  if (!value) {
    return null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function unixSecondsToIso(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const num = Number(value);
  if (!Number.isFinite(num)) {
    return null;
  }

  return new Date(num * 1000).toISOString();
}

function pickFirstReset(...values) {
  const normalized = values
    .map((value) => toIsoOrNull(value))
    .filter(Boolean)
    .sort();
  return normalized[0] || null;
}

function createTimeoutSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    clear: () => clearTimeout(timer)
  };
}

async function fetchJson(url) {
  const timeout = createTimeoutSignal(REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: timeout.signal,
      headers: {
        "Accept": "application/json"
      }
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = { raw: text };
    }

    if (!response.ok) {
      throw new Error(body?.error || `Request failed: ${response.status}`);
    }

    return body;
  } finally {
    timeout.clear();
  }
}

function summarizeStates(accounts) {
  const summary = {
    total: accounts.length,
    usable: 0,
    standby: 0,
    limited: 0,
    token_expired: 0,
    refresh_failed: 0,
    disabled: 0,
    banned: 0,
    refreshing: 0,
    unknown: 0
  };

  for (const account of accounts) {
    const key = summary[account.state] !== undefined ? account.state : "unknown";
    summary[key] += 1;
  }

  return summary;
}

function buildClaudeQuota(quota) {
  return {
    five_hour: {
      status: quota?.unified?.five_hour?.status || null,
      utilization: quota?.unified?.five_hour?.utilization ?? null,
      reset_at: toIsoOrNull(quota?.unified?.five_hour?.reset_at)
    },
    seven_day: {
      status: quota?.unified?.seven_day?.status || null,
      utilization: quota?.unified?.seven_day?.utilization ?? null,
      reset_at: toIsoOrNull(quota?.unified?.seven_day?.reset_at)
    },
    overage_status: quota?.unified?.overage_status || null,
    retry_after_seconds: quota?.retry_after_seconds ?? null
  };
}

function deriveClaudeAccountStatus(account, liveProbe, nowMs) {
  const expiresAt = account.expires_at ? new Date(account.expires_at).getTime() : null;
  const tokenExpired = expiresAt !== null ? expiresAt <= nowMs + 60_000 : null;
  const quota = account.is_active && liveProbe?.quota ? liveProbe.quota : account.quota;
  const quotaView = buildClaudeQuota(quota);

  if (account.is_active && liveProbe?.error) {
    return {
      state: "refresh_failed",
      usable: false,
      reason: liveProbe.error,
      unavailable_until: null,
      token_expired: tokenExpired
    };
  }

  if (tokenExpired === true) {
    return {
      state: "token_expired",
      usable: false,
      reason: "OAuth access token expired or expiring within 60 seconds",
      unavailable_until: null,
      token_expired: tokenExpired
    };
  }

  const fiveHourLimited = quotaView.five_hour.status && quotaView.five_hour.status !== "allowed";
  const sevenDayLimited = quotaView.seven_day.status && quotaView.seven_day.status !== "allowed";
  const fiveHourFull = typeof quotaView.five_hour.utilization === "number" && quotaView.five_hour.utilization >= 1;
  const sevenDayFull = typeof quotaView.seven_day.utilization === "number" && quotaView.seven_day.utilization >= 1;

  if (fiveHourLimited || sevenDayLimited || fiveHourFull || sevenDayFull) {
    return {
      state: "limited",
      usable: false,
      reason: "Claude subscription window is currently limited",
      unavailable_until: pickFirstReset(quotaView.five_hour.reset_at, quotaView.seven_day.reset_at),
      token_expired: tokenExpired
    };
  }

  if (account.is_active) {
    return {
      state: "usable",
      usable: true,
      reason: "Active routing account has a usable token and allowed quota windows",
      unavailable_until: null,
      token_expired: tokenExpired
    };
  }

  return {
    state: "standby",
    usable: tokenExpired === false,
    reason: "Stored non-active account",
    unavailable_until: null,
    token_expired: tokenExpired
  };
}

async function getClaudeStatus(options = {}) {
  const checkedAt = new Date().toISOString();
  try {
    const [authStatus, dashboard] = await Promise.all([
      fetchJson(`${CLAUDE_BASE_URL}/auth/status`),
      fetchJson(`${CLAUDE_BASE_URL}/admin/dashboard${options.refresh ? "?refresh=1" : ""}`)
    ]);

    const nowMs = Date.now();
    const liveProbe = dashboard.meta?.live_proxy_probe || null;
    const accounts = (dashboard.accounts || []).map((account) => {
      const derived = deriveClaudeAccountStatus(account, liveProbe, nowMs);
      return {
        id: account.id,
        label: account.label,
        org_id: account.org_id,
        is_active: account.is_active === true,
        token_expires_at: toIsoOrNull(account.expires_at),
        last_used_at: toIsoOrNull(account.last_used_at),
        state: derived.state,
        usable: derived.usable,
        reason: derived.reason,
        token_expired: derived.token_expired,
        unavailable_until: derived.unavailable_until,
        quota: buildClaudeQuota(account.is_active && liveProbe?.quota ? liveProbe.quota : account.quota),
        usage: {
          request_count: account.usage?.request_count ?? 0,
          input_tokens: account.usage?.input_tokens ?? 0,
          output_tokens: account.usage?.output_tokens ?? 0,
          cache_creation_input_tokens: account.usage?.cache_creation_input_tokens ?? 0,
          cache_read_input_tokens: account.usage?.cache_read_input_tokens ?? 0,
          last_model: account.usage?.last_model || null,
          last_status_code: account.usage?.last_status_code ?? null,
          last_response_at: toIsoOrNull(account.usage?.last_response_at)
        }
      };
    });

    const active = accounts.find((account) => account.is_active) || null;
    const serviceState = !authStatus.authenticated
      ? "unauthenticated"
      : !active
        ? "degraded"
        : active.state === "usable"
          ? "ok"
          : active.state === "standby"
            ? "degraded"
            : "error";

    return {
      service: "claude",
      checked_at: checkedAt,
      reachable: true,
      routing_mode: "single-active",
      source_base_url: CLAUDE_BASE_URL,
      authenticated: authStatus.authenticated === true,
      service_state: serviceState,
      active_account_id: authStatus.active_account_id || dashboard.overview?.active_account_id || null,
      account_count: authStatus.account_count ?? accounts.length,
      token_expires_at: toIsoOrNull(authStatus.expires_at),
      refresh_ok: !liveProbe?.error,
      refresh_error: liveProbe?.error || null,
      active_window: active ? active.quota : null,
      summary: summarizeStates(accounts),
      accounts
    };
  } catch (error) {
    return {
      service: "claude",
      checked_at: checkedAt,
      reachable: false,
      routing_mode: "single-active",
      source_base_url: CLAUDE_BASE_URL,
      authenticated: false,
      service_state: "error",
      error: error instanceof Error ? error.message : String(error),
      summary: summarizeStates([]),
      accounts: []
    };
  }
}

function codexEffectiveStatus(account) {
  const rateLimitReached = account.quota?.rate_limit?.limit_reached === true;
  const secondaryLimitReached = account.quota?.secondary_rate_limit?.limit_reached === true;
  const codeReviewLimitReached = account.quota?.code_review_rate_limit?.limit_reached === true;
  if (account.status === "active" && (rateLimitReached || secondaryLimitReached || codeReviewLimitReached)) {
    return "rate_limited";
  }
  return account.status;
}

function deriveCodexAccountStatus(account) {
  const effectiveStatus = codexEffectiveStatus(account);
  const rateLimitReset = unixSecondsToIso(account.quota?.rate_limit?.reset_at);
  const secondaryReset = unixSecondsToIso(account.quota?.secondary_rate_limit?.reset_at);
  const codeReviewReset = unixSecondsToIso(account.quota?.code_review_rate_limit?.reset_at);

  switch (effectiveStatus) {
    case "active":
      return {
        state: "usable",
        usable: true,
        reason: "Account is active and eligible for routing",
        unavailable_until: null
      };
    case "rate_limited":
    case "quota_exhausted":
      return {
        state: "limited",
        usable: false,
        reason: "One or more Codex quota buckets are exhausted",
        unavailable_until: pickFirstReset(rateLimitReset, secondaryReset, codeReviewReset)
      };
    case "expired":
      return {
        state: "token_expired",
        usable: false,
        reason: "Codex account token is expired",
        unavailable_until: null
      };
    case "refreshing":
      return {
        state: "refreshing",
        usable: false,
        reason: "Codex account token is being refreshed",
        unavailable_until: null
      };
    case "disabled":
      return {
        state: "disabled",
        usable: false,
        reason: "Account is disabled",
        unavailable_until: null
      };
    case "banned":
      return {
        state: "banned",
        usable: false,
        reason: "Account is banned or deactivated upstream",
        unavailable_until: null
      };
    default:
      return {
        state: "unknown",
        usable: false,
        reason: `Unhandled backend status: ${effectiveStatus}`,
        unavailable_until: null
      };
  }
}

async function getCodexStatus() {
  const checkedAt = new Date().toISOString();
  try {
    const [authStatus, accountsPayload, usageSummary] = await Promise.all([
      fetchJson(`${CODEX_BASE_URL}/auth/status`),
      fetchJson(`${CODEX_BASE_URL}/auth/accounts`),
      fetchJson(`${CODEX_BASE_URL}/admin/usage-stats/summary`).catch(() => null)
    ]);

    const accounts = (accountsPayload.accounts || []).map((account) => {
      const derived = deriveCodexAccountStatus(account);
      return {
        id: account.id,
        email: account.email,
        account_id: account.accountId,
        plan_type: account.planType,
        status: account.status,
        effective_status: codexEffectiveStatus(account),
        usable: derived.usable,
        state: derived.state,
        reason: derived.reason,
        expires_at: toIsoOrNull(account.expiresAt),
        quota_fetched_at: toIsoOrNull(account.quotaFetchedAt),
        unavailable_until: derived.unavailable_until,
        quota: {
          rate_limit: {
            used_percent: account.quota?.rate_limit?.used_percent ?? null,
            limit_reached: account.quota?.rate_limit?.limit_reached ?? null,
            reset_at: unixSecondsToIso(account.quota?.rate_limit?.reset_at)
          },
          secondary_rate_limit: {
            used_percent: account.quota?.secondary_rate_limit?.used_percent ?? null,
            limit_reached: account.quota?.secondary_rate_limit?.limit_reached ?? null,
            reset_at: unixSecondsToIso(account.quota?.secondary_rate_limit?.reset_at)
          },
          code_review_rate_limit: {
            used_percent: account.quota?.code_review_rate_limit?.used_percent ?? null,
            limit_reached: account.quota?.code_review_rate_limit?.limit_reached ?? null,
            reset_at: unixSecondsToIso(account.quota?.code_review_rate_limit?.reset_at)
          }
        },
        usage: {
          request_count: account.usage?.request_count ?? 0,
          input_tokens: account.usage?.input_tokens ?? 0,
          output_tokens: account.usage?.output_tokens ?? 0,
          cached_tokens: account.usage?.cached_tokens ?? 0,
          last_used_at: toIsoOrNull(account.usage?.last_used),
          window_request_count: account.usage?.window_request_count ?? 0,
          window_input_tokens: account.usage?.window_input_tokens ?? 0,
          window_output_tokens: account.usage?.window_output_tokens ?? 0,
          window_cached_tokens: account.usage?.window_cached_tokens ?? 0,
          window_reset_at: unixSecondsToIso(account.usage?.window_reset_at)
        }
      };
    });

    const serviceState = authStatus.authenticated === true && (authStatus.pool?.active || 0) > 0
      ? "ok"
      : authStatus.authenticated === true
        ? "degraded"
        : "unauthenticated";

    return {
      service: "codex",
      checked_at: checkedAt,
      reachable: true,
      routing_mode: "pool",
      source_base_url: CODEX_BASE_URL,
      authenticated: authStatus.authenticated === true,
      service_state: serviceState,
      user: authStatus.user || null,
      proxy_api_key: authStatus.proxy_api_key || null,
      pool: authStatus.pool || null,
      usage_summary: usageSummary,
      summary: summarizeStates(accounts),
      persistence_health: accountsPayload.persistence_health || null,
      accounts
    };
  } catch (error) {
    return {
      service: "codex",
      checked_at: checkedAt,
      reachable: false,
      routing_mode: "pool",
      source_base_url: CODEX_BASE_URL,
      authenticated: false,
      service_state: "error",
      error: error instanceof Error ? error.message : String(error),
      summary: summarizeStates([]),
      accounts: []
    };
  }
}

async function buildCombinedStatus(options) {
  const [claude, codex] = await Promise.all([
    getClaudeStatus(options),
    getCodexStatus()
  ]);

  const ok = claude.reachable || codex.reachable;
  return {
    ok,
    generated_at: new Date().toISOString(),
    services: {
      claude,
      codex
    }
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);

  if (req.method === "OPTIONS") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "ai-token-status-api",
      generated_at: new Date().toISOString()
    });
    return;
  }

  const refresh = isTruthyQuery(url.searchParams.get("refresh"));

  if (url.pathname === "/api/status") {
    sendJson(res, 200, await buildCombinedStatus({ refresh }));
    return;
  }

  if (url.pathname === "/api/status/claude") {
    sendJson(res, 200, await getClaudeStatus({ refresh }));
    return;
  }

  if (url.pathname === "/api/status/codex") {
    sendJson(res, 200, await getCodexStatus());
    return;
  }

  sendJson(res, 404, {
    error: "Not found",
    endpoints: [
      "/health",
      "/api/status",
      "/api/status/claude",
      "/api/status/codex"
    ]
  });
});

server.listen(PORT, HOST, () => {
  console.log(`ai-token-status-api listening on http://${HOST}:${PORT}`);
  console.log(`  Claude source: ${CLAUDE_BASE_URL}`);
  console.log(`  Codex source:  ${CODEX_BASE_URL}`);
});
