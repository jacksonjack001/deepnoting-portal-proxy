const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Logger = require("./Logger");
const { parseQuotaHeaders } = require("./quota");

class AccountStore {
  constructor() {
    const home = process.env.HOME || process.env.USERPROFILE;
    this.baseDir = path.join(home, ".claude-code-proxy");
    this.accountsPath = path.join(this.baseDir, "accounts.json");
    this.tokenPath = path.join(this.baseDir, "tokens.json");
  }

  getDefaultData() {
    return {
      version: 1,
      active_account_id: null,
      accounts: []
    };
  }

  ensureMigratedFromLegacy() {
    if (fs.existsSync(this.accountsPath)) {
      return;
    }

    const legacyTokens = this.readJsonFile(this.tokenPath);
    if (!legacyTokens || !legacyTokens.access_token || !legacyTokens.refresh_token) {
      return;
    }

    const now = new Date().toISOString();
    const account = this.buildAccount(
      {
        label: "Primary Account",
        source: "oauth",
        access_token: legacyTokens.access_token,
        refresh_token: legacyTokens.refresh_token,
        expires_at: legacyTokens.expires_at
      },
      null,
      now
    );

    this.writeData({
      version: 1,
      active_account_id: account.id,
      accounts: [account]
    });
  }

  readJsonFile(filePath) {
    try {
      if (!fs.existsSync(filePath)) {
        return null;
      }

      return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (error) {
      Logger.warn(`Failed to read ${path.basename(filePath)}: ${error.message}`);
      return null;
    }
  }

  loadData() {
    this.ensureMigratedFromLegacy();
    const data = this.readJsonFile(this.accountsPath) || this.getDefaultData();
    return this.normalizeData(data);
  }

  normalizeData(data) {
    const safe = data && typeof data === "object" ? data : this.getDefaultData();
    const accounts = Array.isArray(safe.accounts)
      ? safe.accounts.map((account, index) => this.buildAccount(account, account?.id || `acct_${index}`))
      : [];

    const activeId = accounts.some((account) => account.id === safe.active_account_id)
      ? safe.active_account_id
      : (accounts[0]?.id || null);

    return {
      version: 1,
      active_account_id: activeId,
      accounts
    };
  }

  buildAccount(account, forcedId = null, nowIso = new Date().toISOString()) {
    const usage = account?.usage && typeof account.usage === "object" ? account.usage : {};

    return {
      id: forcedId || account?.id || `acct_${crypto.randomUUID()}`,
      label: account?.label || "Claude Account",
      source: account?.source || "oauth",
      org_id: account?.org_id || null,
      access_token: account?.access_token || null,
      refresh_token: account?.refresh_token || null,
      expires_at: account?.expires_at || null,
      created_at: account?.created_at || nowIso,
      updated_at: account?.updated_at || nowIso,
      last_used_at: account?.last_used_at || null,
      quota: account?.quota || null,
      usage: {
        request_count: Number(usage.request_count) || 0,
        input_tokens: Number(usage.input_tokens) || 0,
        output_tokens: Number(usage.output_tokens) || 0,
        cache_creation_input_tokens: Number(usage.cache_creation_input_tokens) || 0,
        cache_read_input_tokens: Number(usage.cache_read_input_tokens) || 0,
        last_model: usage.last_model || null,
        last_request_id: usage.last_request_id || null,
        last_status_code: usage.last_status_code || null,
        last_error: usage.last_error || null,
        last_response_at: usage.last_response_at || null
      }
    };
  }

  ensureDirectory(filePath) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  setSecurePermissions(filePath) {
    if (process.platform !== "win32") {
      fs.chmodSync(filePath, 0o600);
    }
  }

  writeJsonFile(filePath, data) {
    this.ensureDirectory(filePath);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
    this.setSecurePermissions(filePath);
  }

  writeLegacyTokens(tokens) {
    this.writeJsonFile(this.tokenPath, {
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_at: tokens.expires_at
    });
  }

  clearLegacyTokens() {
    if (fs.existsSync(this.tokenPath)) {
      fs.unlinkSync(this.tokenPath);
    }
  }

  writeData(data) {
    const normalized = this.normalizeData(data);
    this.writeJsonFile(this.accountsPath, normalized);
    return normalized;
  }

  withData(mutator) {
    const data = this.loadData();
    const result = mutator(data);
    const shouldPersist = result === undefined ? data : result;
    return this.writeData(shouldPersist);
  }

  hasAccounts() {
    return this.loadData().accounts.length > 0;
  }

  listAccounts() {
    return this.loadData().accounts;
  }

  getAccount(accountId) {
    return this.loadData().accounts.find((account) => account.id === accountId) || null;
  }

  getAccountTokens(accountId) {
    const account = this.getAccount(accountId);
    if (!account) {
      return null;
    }

    return {
      access_token: account.access_token,
      refresh_token: account.refresh_token,
      expires_at: account.expires_at
    };
  }

  getActiveAccountId() {
    return this.loadData().active_account_id;
  }

  getActiveAccount() {
    const data = this.loadData();
    return data.accounts.find((account) => account.id === data.active_account_id) || null;
  }

  upsertOAuthAccount(tokens, { label = null, setActive = true, source = "oauth", orgId = null } = {}) {
    const now = new Date().toISOString();
    let selectedAccount = null;

    const updated = this.withData((data) => {
      const existing = data.accounts.find((account) => (
        (tokens.refresh_token && account.refresh_token === tokens.refresh_token) ||
        (tokens.access_token && account.access_token === tokens.access_token)
      ));

      if (existing) {
        existing.label = label || existing.label;
        existing.source = source || existing.source;
        existing.org_id = orgId || existing.org_id;
        existing.access_token = tokens.access_token;
        existing.refresh_token = tokens.refresh_token;
        existing.expires_at = tokens.expires_at;
        existing.updated_at = now;
        selectedAccount = existing;
      } else {
        selectedAccount = this.buildAccount({
          label: label || `Claude Account ${data.accounts.length + 1}`,
          source,
          org_id: orgId,
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_at: tokens.expires_at
        }, null, now);
        data.accounts.push(selectedAccount);
      }

      if (setActive || !data.active_account_id) {
        data.active_account_id = selectedAccount.id;
      }

      return data;
    });

    const activeAccount = updated.accounts.find((account) => account.id === updated.active_account_id) || null;
    if (activeAccount) {
      this.writeLegacyTokens(activeAccount);
    }

    return selectedAccount;
  }

  updateAccountTokens(accountId, tokens, { label = null, orgId = null } = {}) {
    const now = new Date().toISOString();
    let updatedAccount = null;

    const updated = this.withData((data) => {
      const account = data.accounts.find((entry) => entry.id === accountId);
      if (!account) {
        return data;
      }

      account.access_token = tokens.access_token;
      account.refresh_token = tokens.refresh_token;
      account.expires_at = tokens.expires_at;
      account.updated_at = now;
      if (label) {
        account.label = label;
      }
      if (orgId) {
        account.org_id = orgId;
      }

      updatedAccount = account;
      return data;
    });

    if (updated.active_account_id === accountId && updatedAccount) {
      this.writeLegacyTokens(updatedAccount);
    }

    return updatedAccount;
  }

  activateAccount(accountId) {
    let activated = null;

    const updated = this.withData((data) => {
      const account = data.accounts.find((entry) => entry.id === accountId);
      if (!account) {
        return data;
      }

      data.active_account_id = accountId;
      activated = account;
      return data;
    });

    if (!activated) {
      return null;
    }

    const activeAccount = updated.accounts.find((account) => account.id === updated.active_account_id);
    this.writeLegacyTokens(activeAccount);
    return activeAccount;
  }

  renameAccount(accountId, label) {
    const cleanLabel = String(label || "").trim().slice(0, 80);
    if (!cleanLabel) {
      return null;
    }

    let renamed = null;
    this.withData((data) => {
      const account = data.accounts.find((entry) => entry.id === accountId);
      if (!account) {
        return data;
      }

      account.label = cleanLabel;
      renamed = account;
      return data;
    });

    return renamed;
  }

  removeAccount(accountId) {
    let removed = false;
    let nextActive = null;

    const updated = this.withData((data) => {
      const nextAccounts = data.accounts.filter((account) => account.id !== accountId);
      removed = nextAccounts.length !== data.accounts.length;
      data.accounts = nextAccounts;

      if (!removed) {
        return data;
      }

      if (data.active_account_id === accountId) {
        data.active_account_id = data.accounts[0]?.id || null;
      }

      nextActive = data.accounts.find((account) => account.id === data.active_account_id) || null;
      return data;
    });

    if (!removed) {
      return { removed: false, active_account_id: updated.active_account_id };
    }

    if (nextActive) {
      this.writeLegacyTokens(nextActive);
    } else {
      this.clearLegacyTokens();
    }

    return {
      removed: true,
      active_account_id: updated.active_account_id
    };
  }

  recordQuota(accountId, headersOrQuota, { orgId = null } = {}) {
    const quota = headersOrQuota?.updated_at ? headersOrQuota : parseQuotaHeaders(headersOrQuota);
    if (!quota) {
      return null;
    }

    let updatedAccount = null;
    this.withData((data) => {
      const account = data.accounts.find((entry) => entry.id === accountId);
      if (!account) {
        return data;
      }

      account.quota = quota;
      account.updated_at = new Date().toISOString();
      account.last_used_at = account.quota.updated_at;
      if (orgId) {
        account.org_id = orgId;
      }

      updatedAccount = account;
      return data;
    });

    return updatedAccount;
  }

  recordRequest(accountId, { statusCode = null, model = null, requestId = null, error = null } = {}) {
    let updatedAccount = null;
    this.withData((data) => {
      const account = data.accounts.find((entry) => entry.id === accountId);
      if (!account) {
        return data;
      }

      const now = new Date().toISOString();
      account.usage.request_count += 1;
      account.usage.last_status_code = statusCode;
      account.usage.last_model = model || account.usage.last_model;
      account.usage.last_request_id = requestId || account.usage.last_request_id;
      account.usage.last_error = error || null;
      account.usage.last_response_at = now;
      account.updated_at = now;
      account.last_used_at = now;
      updatedAccount = account;
      return data;
    });

    return updatedAccount;
  }

  recordUsage(accountId, usage = {}) {
    let updatedAccount = null;
    this.withData((data) => {
      const account = data.accounts.find((entry) => entry.id === accountId);
      if (!account) {
        return data;
      }

      account.usage.input_tokens += Number(usage.input_tokens) || 0;
      account.usage.output_tokens += Number(usage.output_tokens) || 0;
      account.usage.cache_creation_input_tokens += Number(usage.cache_creation_input_tokens) || 0;
      account.usage.cache_read_input_tokens += Number(usage.cache_read_input_tokens) || 0;
      account.updated_at = new Date().toISOString();
      updatedAccount = account;
      return data;
    });

    return updatedAccount;
  }

  toClientAccount(account, activeAccountId) {
    return {
      id: account.id,
      label: account.label,
      source: account.source,
      org_id: account.org_id,
      expires_at: account.expires_at ? new Date(account.expires_at).toISOString() : null,
      created_at: account.created_at,
      updated_at: account.updated_at,
      last_used_at: account.last_used_at,
      is_active: account.id === activeAccountId,
      quota: account.quota,
      usage: account.usage
    };
  }

  getOverview(accounts, activeAccountId) {
    const totals = accounts.reduce((acc, account) => {
      acc.requests += account.usage.request_count;
      acc.input_tokens += account.usage.input_tokens;
      acc.output_tokens += account.usage.output_tokens;
      acc.cache_creation_input_tokens += account.usage.cache_creation_input_tokens;
      acc.cache_read_input_tokens += account.usage.cache_read_input_tokens;
      return acc;
    }, {
      requests: 0,
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0
    });

    const exhausted = accounts.filter((account) => {
      const fiveHour = account.quota?.unified?.five_hour;
      const sevenDay = account.quota?.unified?.seven_day;
      return (
        (fiveHour?.status && fiveHour.status !== "allowed") ||
        (sevenDay?.status && sevenDay.status !== "allowed") ||
        (typeof fiveHour?.utilization === "number" && fiveHour.utilization >= 1) ||
        (typeof sevenDay?.utilization === "number" && sevenDay.utilization >= 1)
      );
    }).length;

    const highestWeeklyUsage = accounts.reduce((best, account) => {
      const utilization = account.quota?.unified?.seven_day?.utilization;
      if (typeof utilization !== "number") {
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

    const activeAccount = accounts.find((account) => account.id === activeAccountId) || null;

    return {
      total_accounts: accounts.length,
      active_accounts: activeAccount ? 1 : 0,
      exhausted_accounts: exhausted,
      active_account_id: activeAccountId,
      active_account_label: activeAccount?.label || null,
      highest_weekly_usage: highestWeeklyUsage,
      totals
    };
  }

  getDashboardData(extra = {}) {
    const data = this.loadData();
    const accounts = data.accounts.map((account) => this.toClientAccount(account, data.active_account_id));

    return {
      overview: this.getOverview(data.accounts, data.active_account_id),
      accounts,
      meta: {
        accounts_path: this.accountsPath,
        tokens_path: this.tokenPath,
        ...extra
      }
    };
  }
}

module.exports = new AccountStore();
