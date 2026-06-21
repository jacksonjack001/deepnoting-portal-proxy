const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const https = require("https");
const Logger = require("./Logger");
const AccountStore = require("./AccountStore");

const OAUTH_CONFIG = {
  client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  authorize_url: "https://claude.ai/oauth/authorize",
  token_url: "https://platform.claude.com/v1/oauth/token",
  redirect_uri: "https://platform.claude.com/oauth/code/callback",
  scope: "org:create_api_key user:profile user:inference"
};

class OAuthManager {
  constructor() {
    const baseDir = path.join(
      process.env.HOME || process.env.USERPROFILE,
      ".claude-code-proxy"
    );
    this.defaultTokenPath = path.join(baseDir, "tokens.json");
    this.defaultAccountPath = path.join(baseDir, "accounts.json");
    this.tokenPath = this.defaultTokenPath;
    this.accountPath = this.defaultAccountPath;
    this.cachedToken = null;
    this.refreshPromise = null;
    this.refreshPromises = new Map();
  }

  syncStorePaths() {
    AccountStore.tokenPath = this.tokenPath;
    AccountStore.accountsPath = this.accountPath === this.defaultAccountPath
      ? path.join(path.dirname(this.tokenPath), "accounts.json")
      : this.accountPath;
    return AccountStore;
  }

  generatePKCE() {
    const code_verifier = crypto.randomBytes(32).toString("base64url");
    const code_challenge = crypto
      .createHash("sha256")
      .update(code_verifier)
      .digest("base64url");
    const state = crypto.randomBytes(32).toString("base64url");

    return { code_verifier, code_challenge, state };
  }

  buildAuthorizationURL(pkce) {
    const params = new URLSearchParams({
      code: "true",
      client_id: OAUTH_CONFIG.client_id,
      response_type: "code",
      redirect_uri: OAUTH_CONFIG.redirect_uri,
      scope: OAUTH_CONFIG.scope,
      code_challenge: pkce.code_challenge,
      code_challenge_method: "S256",
      state: pkce.state
    });

    return `${OAUTH_CONFIG.authorize_url}?${params.toString()}`;
  }

  async exchangeCodeForTokens(code, code_verifier, state) {
    const payload = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      state,
      client_id: OAUTH_CONFIG.client_id,
      code_verifier,
      redirect_uri: OAUTH_CONFIG.redirect_uri
    }).toString();

    try {
      const response = await this.makeTokenRequest(payload);
      Logger.info("Successfully exchanged authorization code for tokens");
      return response;
    } catch (error) {
      Logger.error("Failed to exchange code for tokens", error);
      throw error;
    }
  }

  async refreshAccessToken(accountId = null) {
    const refreshKey = accountId || "active";

    if (!accountId && !this.refreshPromise && this.refreshPromises.has(refreshKey)) {
      this.refreshPromises.delete(refreshKey);
    }

    if (this.refreshPromises.has(refreshKey)) {
      Logger.debug(`Token refresh already in progress for ${refreshKey}, waiting...`);
      return this.refreshPromises.get(refreshKey);
    }

    const refreshTask = (async () => {
      try {
        const tokens = this.loadTokens(accountId);
        if (!tokens || !tokens.refresh_token) {
          throw new Error("No refresh token available");
        }

        const formPayload = new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: tokens.refresh_token,
          client_id: OAUTH_CONFIG.client_id
        }).toString();

        const response = await this.makeTokenRequest(formPayload);
        const newTokens = {
          access_token: response.access_token,
          refresh_token: response.refresh_token || tokens.refresh_token,
          expires_at: Date.now() + (response.expires_in * 1000)
        };

        this.saveTokens(newTokens, accountId ? { accountId } : {});
        if (!accountId) {
          this.cachedToken = newTokens.access_token;
        }

        Logger.info(`Successfully refreshed access token for ${refreshKey}`);
        return response;
      } finally {
        this.refreshPromises.delete(refreshKey);
        if (!accountId) {
          this.refreshPromise = null;
        }
      }
    })();

    this.refreshPromises.set(refreshKey, refreshTask);
    if (!accountId) {
      this.refreshPromise = refreshTask;
    }

    return refreshTask;
  }

  makeTokenRequest(payload) {
    return new Promise((resolve, reject) => {
      const url = new URL(OAUTH_CONFIG.token_url);

      const req = https.request({
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "Content-Length": Buffer.byteLength(payload)
        }
      }, (res) => {
        let data = "";

        res.on("data", (chunk) => {
          data += chunk;
        });

        res.on("end", () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(data));
            } catch (error) {
              reject(new Error(`Failed to parse token response: ${error.message}`));
            }
            return;
          }

          if (res.headers["cf-mitigated"] === "challenge") {
            reject(new Error(
              `Token request was blocked by Cloudflare on ${url.hostname}. ` +
              "This usually means the OAuth token host is outdated or no longer accepts server-side token exchange."
            ));
            return;
          }

          reject(new Error(`Token request failed with status ${res.statusCode}: ${data}`));
        });
      });

      req.on("error", reject);
      req.write(payload);
      req.end();
    });
  }

  writeLegacyTokenFile(tokens) {
    const dir = path.dirname(this.tokenPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(this.tokenPath, JSON.stringify(tokens, null, 2), "utf8");
    if (process.platform !== "win32") {
      fs.chmodSync(this.tokenPath, 0o600);
    }
  }

  loadTokens(accountId = null) {
    const store = this.syncStorePaths();

    if (accountId) {
      return store.getAccountTokens(accountId);
    }

    const activeAccount = store.getActiveAccount();
    if (activeAccount?.access_token && activeAccount?.refresh_token) {
      return {
        access_token: activeAccount.access_token,
        refresh_token: activeAccount.refresh_token,
        expires_at: activeAccount.expires_at
      };
    }

    try {
      if (!fs.existsSync(this.tokenPath)) {
        return null;
      }

      return JSON.parse(fs.readFileSync(this.tokenPath, "utf8"));
    } catch (error) {
      Logger.error("Failed to load tokens from file", error);
      return null;
    }
  }

  saveTokens(tokens, options = {}) {
    const store = this.syncStorePaths();
    const { accountId = null, label = null, setActive = true, orgId = null } = options;

    try {
      this.writeLegacyTokenFile(tokens);
      Logger.info("Tokens saved successfully");
    } catch (error) {
      Logger.error("Failed to save legacy token file", error);
      throw error;
    }

    try {
      if (accountId) {
        return store.updateAccountTokens(accountId, tokens, { label, orgId });
      }

      return store.upsertOAuthAccount(tokens, {
        label,
        setActive,
        source: "oauth",
        orgId
      });
    } catch (error) {
      Logger.error("Failed to sync account store", error);
      throw error;
    }
  }

  async getValidAccessToken(accountId = null) {
    if (!accountId && this.cachedToken) {
      const tokens = this.loadTokens();
      if (tokens && tokens.expires_at > Date.now() + 60000) {
        return this.cachedToken;
      }
    }

    const tokens = this.loadTokens(accountId);
    if (!tokens) {
      throw new Error("No authentication tokens found. Please authenticate first.");
    }

    if (tokens.expires_at <= Date.now() + 60000) {
      Logger.info(`Access token expired or expiring soon, refreshing ${accountId || "active"}...`);
      await this.refreshAccessToken(accountId);
      const refreshed = this.loadTokens(accountId);
      if (!refreshed) {
        throw new Error("Failed to reload tokens after refresh");
      }
      if (!accountId) {
        this.cachedToken = refreshed.access_token;
      }
      return refreshed.access_token;
    }

    if (!accountId) {
      this.cachedToken = tokens.access_token;
    }

    return tokens.access_token;
  }

  isAuthenticated() {
    const tokens = this.loadTokens();
    return !!(tokens && tokens.access_token && tokens.refresh_token);
  }

  getTokenExpiration() {
    const tokens = this.loadTokens();
    if (!tokens || !tokens.expires_at) {
      return null;
    }
    return new Date(tokens.expires_at);
  }

  getActiveAccountId() {
    return this.syncStorePaths().getActiveAccountId();
  }

  getActiveAccount() {
    return this.syncStorePaths().getActiveAccount();
  }

  getAccount(accountId) {
    return this.syncStorePaths().getAccount(accountId);
  }

  listAccounts() {
    return this.syncStorePaths().listAccounts();
  }

  activateAccount(accountId) {
    this.cachedToken = null;
    return this.syncStorePaths().activateAccount(accountId);
  }

  renameAccount(accountId, label) {
    return this.syncStorePaths().renameAccount(accountId, label);
  }

  removeAccount(accountId) {
    this.cachedToken = null;
    return this.syncStorePaths().removeAccount(accountId);
  }

  updateAccountQuota(accountId, headersOrQuota, meta = {}) {
    return this.syncStorePaths().recordQuota(accountId, headersOrQuota, meta);
  }

  recordProxyResponse(accountId, meta = {}) {
    return this.syncStorePaths().recordRequest(accountId, meta);
  }

  recordUsage(accountId, usage = {}) {
    return this.syncStorePaths().recordUsage(accountId, usage);
  }

  getDashboardData(extra = {}) {
    return this.syncStorePaths().getDashboardData(extra);
  }

  logout(accountId = null) {
    try {
      const targetAccountId = accountId || this.getActiveAccountId();

      if (targetAccountId) {
        this.removeAccount(targetAccountId);
      } else if (fs.existsSync(this.tokenPath)) {
        fs.unlinkSync(this.tokenPath);
      }

      this.cachedToken = null;
    } catch (error) {
      Logger.error("Failed to delete tokens", error);
      throw error;
    }
  }
}

module.exports = new OAuthManager();
