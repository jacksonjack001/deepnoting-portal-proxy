const fs = require('fs');
const path = require('path');
const AccountStore = require('./AccountStore');

describe('AccountStore', () => {
  const originalTokenPath = AccountStore.tokenPath;
  const originalAccountsPath = AccountStore.accountsPath;
  let testDir;

  beforeEach(() => {
    testDir = path.join(__dirname, '.test-account-store');
    AccountStore.tokenPath = path.join(testDir, 'tokens.json');
    AccountStore.accountsPath = path.join(testDir, 'accounts.json');

    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }

    AccountStore.tokenPath = originalTokenPath;
    AccountStore.accountsPath = originalAccountsPath;
  });

  it('creates and activates accounts, then syncs the legacy token file', () => {
    const first = AccountStore.upsertOAuthAccount({
      access_token: 'token-1',
      refresh_token: 'refresh-1',
      expires_at: Date.now() + 3600000
    }, { label: 'Primary' });

    const second = AccountStore.upsertOAuthAccount({
      access_token: 'token-2',
      refresh_token: 'refresh-2',
      expires_at: Date.now() + 7200000
    }, { label: 'Backup', setActive: false });

    expect(AccountStore.getActiveAccountId()).toBe(first.id);

    AccountStore.activateAccount(second.id);

    expect(AccountStore.getActiveAccountId()).toBe(second.id);
    expect(AccountStore.getActiveAccount().label).toBe('Backup');

    const legacyTokens = JSON.parse(fs.readFileSync(AccountStore.tokenPath, 'utf8'));
    expect(legacyTokens.access_token).toBe('token-2');
  });

  it('removes the active account and promotes the next one', () => {
    const first = AccountStore.upsertOAuthAccount({
      access_token: 'token-1',
      refresh_token: 'refresh-1',
      expires_at: Date.now() + 3600000
    }, { label: 'Primary' });

    const second = AccountStore.upsertOAuthAccount({
      access_token: 'token-2',
      refresh_token: 'refresh-2',
      expires_at: Date.now() + 7200000
    }, { label: 'Backup', setActive: false });

    const result = AccountStore.removeAccount(first.id);

    expect(result.removed).toBe(true);
    expect(AccountStore.getActiveAccountId()).toBe(second.id);
    expect(AccountStore.listAccounts()).toHaveLength(1);
  });
});
