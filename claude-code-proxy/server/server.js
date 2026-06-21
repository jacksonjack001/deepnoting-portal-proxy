const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const ClaudeRequest = require('./ClaudeRequest');
const Logger = require('./Logger');
const OAuthManager = require('./OAuthManager');
const { probeQuota } = require('./AnthropicApi');
const { probeProxy } = require('./ProxyProbe');
const { exec } = require('child_process');

let config = {};

// PKCE state storage with automatic expiration (10 minutes)
const pkceStates = new Map();
const PKCE_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

function cleanupExpiredPKCE() {
  const now = Date.now();
  for (const [state, data] of pkceStates.entries()) {
    if (now - data.created_at > PKCE_EXPIRY_MS) {
      pkceStates.delete(state);
    }
  }
}

// Cleanup expired PKCE states every minute
setInterval(cleanupExpiredPKCE, 60000);

function loadConfig() {
  try {
    const configPath = path.join(__dirname, 'config.txt');
    const configFile = fs.readFileSync(configPath, 'utf8');
    
    configFile.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const [key, ...valueParts] = trimmed.split('=');
        const value = valueParts.join('=').trim();
        const commentIndex = value.indexOf('#');
        config[key.trim()] = commentIndex >= 0 ? value.substring(0, commentIndex).trim() : value;
      }
    });
    
    Logger.init(config);
    
    Logger.info('Config loaded from config.txt');
  } catch (error) {
    Logger.error('Failed to load config:', error.message);
    process.exit(1);
  }
}


function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error(`Invalid JSON: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

function getClientIP(req) {
  return req.headers['x-forwarded-for'] ||
         req.headers['x-real-ip'] ||
         req.connection.remoteAddress ||
         '127.0.0.1';
}

function serveStaticFile(res, filePath, contentType) {
  const staticPath = path.join(__dirname, 'static', filePath);
  fs.readFile(staticPath, 'utf8', (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function openBrowser(url) {
  let command;
  if (process.platform === 'darwin') {
    command = `open "${url}"`;
  } else if (process.platform === 'win32') {
    // start is a shell built-in; first quoted arg is window title, so use empty title
    command = `cmd /c start "" "${url}"`;
  } else {
    command = `xdg-open "${url}"`;
  }

  exec(command, (error) => {
    if (error) {
      Logger.debug(`Failed to open browser: ${error.message}`);
    }
  });
}

function isRunningInDocker() {
  // Check for /.dockerenv file (Docker creates this)
  if (fs.existsSync('/.dockerenv')) return true;

  // Check /proc/self/cgroup for docker/containerd (Linux)
  try {
    const cgroup = fs.readFileSync('/proc/self/cgroup', 'utf8');
    return cgroup.includes('docker') || cgroup.includes('containerd');
  } catch (err) {
    return false;
  }
}

function resetAuthCaches() {
  OAuthManager.cachedToken = null;
  OAuthManager.refreshPromise = null;
  ClaudeRequest.cachedToken = null;
}

function getServerPort() {
  return parseInt(config.port) || 3000;
}

function getServerHost() {
  return config.host || (isRunningInDocker() ? '0.0.0.0' : '127.0.0.1');
}

function getProbeHost() {
  const host = getServerHost();
  return host === '0.0.0.0' ? '127.0.0.1' : host;
}

function getProbeBaseUrl() {
  const configured = typeof config.dashboard_probe_base_url === 'string'
    ? config.dashboard_probe_base_url.trim()
    : '';
  return configured || null;
}

function getProbeTargetLabel() {
  return getProbeBaseUrl() || `http://${getProbeHost()}:${getServerPort()}/v1/messages`;
}

function getFallbackStatus() {
  const enabled = config.fallback_to_claude_code !== 'false';
  if (!enabled) {
    return { enabled: false, detected: false };
  }

  try {
    new ClaudeRequest().loadCredentialsFromFile();
    return { enabled: true, detected: true };
  } catch (error) {
    const expectedMissingCredential = (
      error.code === 'ENOENT' ||
      error.message.includes('credentials') ||
      error.message.includes('Failed to load Claude Code credentials')
    );

    return {
      enabled: true,
      detected: false,
      error: expectedMissingCredential ? null : error.message
    };
  }
}

function buildOverviewFromPayload(payload) {
  const overview = payload.overview || {};
  const totals = overview.totals || {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };

  const exhausted = payload.accounts.filter((account) => {
    const fiveHour = account.quota?.unified?.five_hour;
    const sevenDay = account.quota?.unified?.seven_day;
    return (
      (fiveHour?.status && fiveHour.status !== 'allowed') ||
      (sevenDay?.status && sevenDay.status !== 'allowed') ||
      (typeof fiveHour?.utilization === 'number' && fiveHour.utilization >= 1) ||
      (typeof sevenDay?.utilization === 'number' && sevenDay.utilization >= 1)
    );
  }).length;

  const highestWeeklyUsage = payload.accounts.reduce((best, account) => {
    const utilization = account.quota?.unified?.seven_day?.utilization;
    if (typeof utilization !== 'number') {
      return best;
    }
    if (!best || utilization > best.utilization) {
      return {
        account_id: account.id,
        label: account.label,
        utilization,
        reset_at: account.quota?.unified?.seven_day?.reset_at || null
      };
    }
    return best;
  }, null);

  const activeAccount = payload.accounts.find((account) => account.is_active) || null;

  payload.overview = {
    total_accounts: payload.accounts.length,
    active_accounts: activeAccount ? 1 : 0,
    exhausted_accounts: exhausted,
    active_account_id: overview.active_account_id || activeAccount?.id || null,
    active_account_label: activeAccount?.label || null,
    highest_weekly_usage: highestWeeklyUsage,
    totals
  };

  return payload;
}

function getDashboardPayload(options = {}) {
  const payload = OAuthManager.getDashboardData({
    server: {
      port: getServerPort(),
      host: getServerHost()
    },
    auth: {
      authenticated: OAuthManager.isAuthenticated(),
      expires_at: OAuthManager.getTokenExpiration()?.toISOString() || null
    },
    config: {
      fallback_to_claude_code: config.fallback_to_claude_code !== 'false',
      auto_open_browser: config.auto_open_browser !== 'false',
      dashboard_probe_model: config.dashboard_probe_model || 'claude-sonnet-4-5',
      dashboard_probe_base_url: getProbeBaseUrl()
    },
    fallback: getFallbackStatus()
  });

  if (options.liveProxyProbe) {
    payload.meta.live_proxy_probe = {
      source: 'proxy_v1_messages',
      model: config.dashboard_probe_model || 'claude-sonnet-4-5',
      target: getProbeTargetLabel(),
      refreshed_at: new Date().toISOString(),
      request_id: options.liveProxyProbe.requestId || null,
      org_id: options.liveProxyProbe.org_id || null,
      quota: options.liveProxyProbe.quota || null
    };

    const activeAccount = payload.accounts.find((account) => account.is_active);
    if (activeAccount && options.liveProxyProbe.quota) {
      activeAccount.quota = options.liveProxyProbe.quota;
    }

    return buildOverviewFromPayload(payload);
  }

  if (options.liveProxyError) {
    payload.meta.live_proxy_probe = {
      source: 'proxy_v1_messages',
      model: config.dashboard_probe_model || 'claude-sonnet-4-5',
      target: getProbeTargetLabel(),
      refreshed_at: new Date().toISOString(),
      error: options.liveProxyError
    };
  }

  return payload;
}

async function probeLiveProxyQuota() {
  return probeProxy({
    baseUrl: getProbeBaseUrl(),
    host: getProbeHost(),
    port: getServerPort(),
    model: config.dashboard_probe_model || 'claude-sonnet-4-5'
  });
}

function renderAuthFailure(error) {
  return `
    <!DOCTYPE html>
    <html>
    <head><title>Authentication Failed</title></head>
    <body>
      <h1>Authentication Failed</h1>
      <p>Error: ${error.message}</p>
      <p><a href="/auth/login">Try again</a></p>
    </body>
    </html>
  `;
}

async function handleRequest(req, res) {
  const clientIP = getClientIP(req);
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  Logger.info(`${req.method} ${pathname} from ${clientIP}`);

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if ((pathname === '/' || pathname === '/dashboard') && req.method === 'GET') {
    serveStaticFile(res, 'dashboard.html', 'text/html');
    return;
  }

  if (pathname === '/dashboard.css' && req.method === 'GET') {
    serveStaticFile(res, 'dashboard.css', 'text/css');
    return;
  }

  if (pathname === '/dashboard.js' && req.method === 'GET') {
    serveStaticFile(res, 'dashboard.js', 'application/javascript');
    return;
  }

  // OAuth Routes
  if (pathname === '/auth/login' && req.method === 'GET') {
    serveStaticFile(res, 'login.html', 'text/html');
    return;
  }

  if (pathname === '/auth/get-url' && req.method === 'GET') {
    try {
      const pkce = OAuthManager.generatePKCE();
      const label = typeof parsedUrl.query.label === 'string'
        ? parsedUrl.query.label.trim().slice(0, 80)
        : null;
      pkceStates.set(pkce.state, {
        code_verifier: pkce.code_verifier,
        created_at: Date.now(),
        label
      });

      const authUrl = OAuthManager.buildAuthorizationURL(pkce);

      sendJson(res, 200, { url: authUrl, state: pkce.state, label });
      Logger.info('Generated OAuth authorization URL');
    } catch (error) {
      Logger.error('OAuth get-url error:', error.message);
      sendJson(res, 500, { error: 'Failed to generate OAuth URL' });
    }
    return;
  }

  if (pathname === '/auth/callback' && req.method === 'GET') {
    try {
      const query = parsedUrl.query;
      let code = query.code;
      let state = query.state;

      // Handle manual code entry format: "code#state"
      if (query.manual_code) {
        const parts = query.manual_code.split('#');
        if (parts.length !== 2) {
          throw new Error('Invalid code format. Expected: code#state');
        }
        code = parts[0];
        state = parts[1];
      }

      if (!code || !state) {
        throw new Error('Missing authorization code or state');
      }

      const pkceData = pkceStates.get(state);
      if (!pkceData) {
        throw new Error('Invalid or expired state parameter. Please start the authorization process again.');
      }

      const tokens = await OAuthManager.exchangeCodeForTokens(code, pkceData.code_verifier, state);
      pkceStates.delete(state);

      const tokenData = {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        expires_at: Date.now() + (tokens.expires_in * 1000)
      };
      const account = OAuthManager.saveTokens(tokenData, {
        label: pkceData.label || null,
        setActive: true
      });
      resetAuthCaches();

      if (account?.id) {
        try {
          const accessToken = await OAuthManager.getValidAccessToken(account.id);
          const probe = await probeQuota(accessToken);
          OAuthManager.updateAccountQuota(account.id, probe.quota, { orgId: probe.org_id });
          OAuthManager.recordProxyResponse(account.id, {
            statusCode: probe.statusCode,
            model: probe.model,
            requestId: probe.requestId
          });
          if (probe.usage) {
            OAuthManager.recordUsage(account.id, probe.usage);
          }
        } catch (probeError) {
          Logger.warn(`Initial quota probe failed: ${probeError.message}`);
        }
      }

      serveStaticFile(res, 'callback.html', 'text/html');
      Logger.info('OAuth authentication successful');
    } catch (error) {
      Logger.error('OAuth callback error:', error.message);
      res.writeHead(500, { 'Content-Type': 'text/html' });
      res.end(renderAuthFailure(error));
    }
    return;
  }

  if (pathname === '/auth/status' && req.method === 'GET') {
    try {
      const isAuthenticated = OAuthManager.isAuthenticated();
      const expiration = OAuthManager.getTokenExpiration();

      sendJson(res, 200, {
        authenticated: isAuthenticated,
        expires_at: expiration ? expiration.toISOString() : null,
        active_account_id: OAuthManager.getActiveAccountId(),
        account_count: OAuthManager.listAccounts().length,
        fallback: getFallbackStatus()
      });
    } catch (error) {
      Logger.error('Auth status error:', error.message);
      sendJson(res, 500, { error: 'Failed to check authentication status' });
    }
    return;
  }

  if (pathname === '/auth/logout' && req.method === 'GET') {
    try {
      const accountId = typeof parsedUrl.query.account_id === 'string'
        ? parsedUrl.query.account_id
        : null;
      OAuthManager.logout(accountId);
      resetAuthCaches();
      sendJson(res, 200, { success: true, message: 'Logged out successfully' });
      Logger.info('User logged out');
    } catch (error) {
      Logger.error('Logout error:', error.message);
      sendJson(res, 500, { error: 'Failed to logout' });
    }
    return;
  }

  if (pathname === '/admin/dashboard' && req.method === 'GET') {
    try {
      const shouldRefresh = ['1', 'true', 'active'].includes(String(parsedUrl.query.refresh || ''));
      if (shouldRefresh) {
        try {
          const liveProxyProbe = await probeLiveProxyQuota();
          sendJson(res, 200, getDashboardPayload({ liveProxyProbe }));
        } catch (probeError) {
          Logger.warn(`Live dashboard probe failed: ${probeError.message}`);
          sendJson(res, 200, getDashboardPayload({ liveProxyError: probeError.message }));
        }
      } else {
        sendJson(res, 200, getDashboardPayload());
      }
    } catch (error) {
      Logger.error('Dashboard data error:', error.message);
      sendJson(res, 500, { error: 'Failed to load dashboard data' });
    }
    return;
  }

  const activateMatch = pathname.match(/^\/admin\/accounts\/([^/]+)\/activate$/);
  if (activateMatch && req.method === 'POST') {
    const accountId = decodeURIComponent(activateMatch[1]);
    const account = OAuthManager.activateAccount(accountId);
    if (!account) {
      sendJson(res, 404, { error: 'Account not found' });
      return;
    }

    resetAuthCaches();
    sendJson(res, 200, { success: true, dashboard: getDashboardPayload() });
    return;
  }

  const refreshQuotaMatch = pathname.match(/^\/admin\/accounts\/([^/]+)\/refresh-quota$/);
  if (refreshQuotaMatch && req.method === 'POST') {
    const accountId = decodeURIComponent(refreshQuotaMatch[1]);
    const account = OAuthManager.getAccount(accountId);
    if (!account) {
      sendJson(res, 404, { error: 'Account not found' });
      return;
    }

    try {
      if (accountId === OAuthManager.getActiveAccountId()) {
        const liveProxyProbe = await probeLiveProxyQuota();
        sendJson(res, 200, { success: true, dashboard: getDashboardPayload({ liveProxyProbe }) });
        return;
      }

      const accessToken = await OAuthManager.getValidAccessToken(accountId);
      const probe = await probeQuota(accessToken);
      OAuthManager.updateAccountQuota(accountId, probe.quota, { orgId: probe.org_id });
      OAuthManager.recordProxyResponse(accountId, {
        statusCode: probe.statusCode,
        model: probe.model,
        requestId: probe.requestId
      });
      if (probe.usage) {
        OAuthManager.recordUsage(accountId, probe.usage);
      }
      sendJson(res, 200, { success: true, dashboard: getDashboardPayload() });
    } catch (error) {
      Logger.error('Refresh quota error:', error.message);
      sendJson(res, 502, { error: error.message });
    }
    return;
  }

  const accountMatch = pathname.match(/^\/admin\/accounts\/([^/]+)$/);
  if (accountMatch && req.method === 'PATCH') {
    const accountId = decodeURIComponent(accountMatch[1]);
    try {
      const body = await parseBody(req);
      const account = OAuthManager.renameAccount(accountId, body.label);
      if (!account) {
        sendJson(res, 404, { error: 'Account not found or invalid label' });
        return;
      }
      sendJson(res, 200, { success: true, dashboard: getDashboardPayload() });
    } catch (error) {
      Logger.error('Rename account error:', error.message);
      sendJson(res, 400, { error: error.message });
    }
    return;
  }

  if (accountMatch && req.method === 'DELETE') {
    const accountId = decodeURIComponent(accountMatch[1]);
    const result = OAuthManager.removeAccount(accountId);
    if (!result?.removed) {
      sendJson(res, 404, { error: 'Account not found' });
      return;
    }

    resetAuthCaches();
    sendJson(res, 200, { success: true, dashboard: getDashboardPayload() });
    return;
  }

  if (pathname === '/health') {
    sendJson(res, 200, { status: 'ok', server: 'claude-code-proxy', timestamp: Date.now() });
    return;
  }
  
  if (req.method === 'POST' && (pathname === '/v1/messages' || pathname.match(/^\/v1\/\w+\/messages$/))) {
    try {
      Logger.debug('Incoming request headers:', JSON.stringify(req.headers, null, 2));
      const body = await parseBody(req);
      Logger.debug(`Claude request body (${JSON.stringify(body).length} bytes):`, JSON.stringify(body, null, 2));
      
      let presetName = null;
      const presetMatch = pathname.match(/^\/v1\/(\w+)\/messages$/);
      if (presetMatch) {
        presetName = presetMatch[1];
        Logger.debug(`Detected preset: ${presetName}`);
      }
      
      await new ClaudeRequest(req).handleResponse(res, body, presetName);
    } catch (error) {
      Logger.error('Request error:', error.message);
      sendJson(res, 500, { error: error.message });
    }
    return;
  }
  
  
  sendJson(res, 404, { error: 'Not found' });
}

function startServer() {
  loadConfig();

  const server = http.createServer(handleRequest);
  const port = parseInt(config.port) || 3000;

  // Smart host binding: auto-detect Docker or use config
  const host = config.host || (isRunningInDocker() ? '0.0.0.0' : '127.0.0.1');

  server.listen(port, host, () => {
    Logger.info(`claude-code-proxy server listening on ${host}:${port}`);

    // Display authentication status
    const isAuthenticated = OAuthManager.isAuthenticated();
    const expiration = OAuthManager.getTokenExpiration();

    Logger.info('');
    Logger.info('Authentication Status:');
    if (isAuthenticated && expiration) {
      Logger.info(`  ✓ Authenticated until ${expiration.toLocaleString()}`);
    } else {
      Logger.info('  ✗ Not authenticated');
      const authUrl = `http://localhost:${port}/auth/login`;
      Logger.info(`  → Visit ${authUrl} to authenticate`);

      // Auto-open browser if configured (only works when running natively)
      const autoOpenBrowser = config.auto_open_browser !== 'false';
      if (!isAuthenticated && autoOpenBrowser && !isRunningInDocker()) {
        Logger.info('  → Opening browser for authentication...');
        setTimeout(() => openBrowser(authUrl), 1000);
      }
    }
    Logger.info('');
  });

  process.on('SIGTERM', () => {
    Logger.info('Shutting down...');
    server.close(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    Logger.info('Shutting down...');
    server.close(() => process.exit(0));
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { startServer, ClaudeRequest };
