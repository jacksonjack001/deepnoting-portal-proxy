const state = {
  dashboard: null,
  activeTab: 'overview',
  toastTimer: null
};

const elements = {
  topQuotaPill: document.getElementById('topQuotaPill'),
  refreshDashboardBtn: document.getElementById('refreshDashboardBtn'),
  refreshActiveQuotaBtn: document.getElementById('refreshActiveQuotaBtn'),
  refreshAllBtn: document.getElementById('refreshAllBtn'),
  openAddAccountBtn: document.getElementById('openAddAccountBtn'),
  manageAddAccountBtn: document.getElementById('manageAddAccountBtn'),
  launchAuthBtn: document.getElementById('launchAuthBtn'),
  closeModalBtn: document.getElementById('closeModalBtn'),
  cancelAddAccountBtn: document.getElementById('cancelAddAccountBtn'),
  accountModal: document.getElementById('accountModal'),
  accountLabelInput: document.getElementById('accountLabelInput'),
  tabBar: document.getElementById('tabBar'),
  summaryGrid: document.getElementById('summaryGrid'),
  overviewMeta: document.getElementById('overviewMeta'),
  overviewMainCard: document.getElementById('overviewMainCard'),
  overviewHighlightsCard: document.getElementById('overviewHighlightsCard'),
  overviewAccountsGrid: document.getElementById('overviewAccountsGrid'),
  accountsGrid: document.getElementById('accountsGrid'),
  usageCards: document.getElementById('usageCards'),
  usageTableBody: document.getElementById('usageTableBody'),
  settingsGrid: document.getElementById('settingsGrid'),
  toast: document.getElementById('toast')
};

function formatNumber(value) {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(value || 0);
}

function formatCompact(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) >= 1_000_000) {
    return `${(number / 1_000_000).toFixed(1)}M`;
  }
  if (Math.abs(number) >= 1_000) {
    return `${(number / 1_000).toFixed(1)}k`;
  }
  return String(number);
}

function formatPercent(utilization) {
  if (typeof utilization !== 'number') {
    return 'No data';
  }
  return `${Math.round(utilization * 100)}%`;
}

function clampPercent(utilization) {
  if (typeof utilization !== 'number') {
    return 0;
  }
  return Math.max(0, Math.min(100, utilization * 100));
}

function formatDate(value) {
  if (!value) {
    return 'Not available';
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not available' : date.toLocaleString();
}

function formatRelative(value) {
  if (!value) {
    return 'Never';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'Never';
  }

  const diffMs = Date.now() - date.getTime();
  const diffMinutes = Math.round(diffMs / 60000);
  if (Math.abs(diffMinutes) < 1) {
    return 'Just now';
  }
  if (Math.abs(diffMinutes) < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.round(diffMinutes / 60);
  if (Math.abs(diffHours) < 24) {
    return `${diffHours}h ago`;
  }

  const diffDays = Math.round(diffHours / 24);
  return `${diffDays}d ago`;
}

function shortOrgId(orgId) {
  if (!orgId) {
    return 'Unknown organization';
  }
  return orgId.length > 18 ? `${orgId.slice(0, 8)}...${orgId.slice(-6)}` : orgId;
}

function escapeHtml(value) {
  return String(value || '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    elements.toast.classList.remove('visible');
  }, 2400);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed with status ${response.status}`);
  }
  return payload;
}

function openModal() {
  elements.accountModal.classList.remove('hidden');
  elements.accountModal.setAttribute('aria-hidden', 'false');
  elements.accountLabelInput.focus();
}

function closeModal() {
  elements.accountModal.classList.add('hidden');
  elements.accountModal.setAttribute('aria-hidden', 'true');
}

function setActiveTab(tab) {
  state.activeTab = tab;
  document.querySelectorAll('.tab').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.tab === tab);
  });
  document.querySelectorAll('[data-panel]').forEach((panel) => {
    panel.classList.toggle('panel-visible', panel.dataset.panel === tab);
  });
}

function renderSummaryCards() {
  const dashboard = state.dashboard;
  if (!dashboard) {
    return;
  }

  const overview = dashboard.overview;
  const activeAccount = dashboard.accounts.find((account) => account.is_active) || null;
  const activeQuota = dashboard.meta.live_proxy_probe?.quota || activeAccount?.quota || null;
  const fallback = dashboard.meta.fallback;

  const cards = [
    {
      label: 'Connected Accounts',
      value: overview.total_accounts,
      hint: overview.active_account_label ? `Active: ${overview.active_account_label}` : 'No active account selected'
    },
    {
      label: 'Active 5-Hour Window',
      value: activeQuota?.unified?.five_hour ? formatPercent(activeQuota.unified.five_hour.utilization) : 'No data',
      hint: activeQuota?.unified?.five_hour?.reset_at
        ? `Resets at ${formatDate(activeQuota.unified.five_hour.reset_at)}`
        : 'Live value from /v1/messages headers'
    },
    {
      label: 'Active 7-Day Window',
      value: activeQuota?.unified?.seven_day ? formatPercent(activeQuota.unified.seven_day.utilization) : 'No data',
      hint: activeQuota?.unified?.seven_day?.reset_at
        ? `Resets at ${formatDate(activeQuota.unified.seven_day.reset_at)}`
        : 'Live value from /v1/messages headers'
    },
    {
      label: 'Live Source',
      value: dashboard.meta.live_proxy_probe?.source ? 'Proxy /v1/messages' : (fallback.enabled ? 'Stored Snapshot' : 'Stored Snapshot'),
      hint: dashboard.meta.live_proxy_probe?.request_id
        ? `Request ${dashboard.meta.live_proxy_probe.request_id} via ${dashboard.meta.live_proxy_probe.target || '/v1/messages'}`
        : (dashboard.meta.live_proxy_probe?.error || 'Refresh to force a live proxy header probe')
    }
  ];

  elements.summaryGrid.innerHTML = cards.map((card) => `
    <article class="summary-card">
      <div class="summary-label">${escapeHtml(card.label)}</div>
      <div class="summary-value">${escapeHtml(card.value)}</div>
      <div class="summary-hint">${escapeHtml(card.hint)}</div>
    </article>
  `).join('');
}

function renderOverview() {
  const dashboard = state.dashboard;
  if (!dashboard) {
    return;
  }

  const overview = dashboard.overview;
  const totals = overview.totals;
  const activeAccount = dashboard.accounts.find((account) => account.is_active) || null;
  const highestWeekly = overview.highest_weekly_usage;
  const activeQuota = dashboard.meta.live_proxy_probe?.quota || activeAccount?.quota || null;
  const liveProbe = dashboard.meta.live_proxy_probe;

  elements.topQuotaPill.textContent = `${overview.exhausted_accounts} exhausted`;
  if (liveProbe?.error) {
    elements.overviewMeta.textContent = `Live probe failed: ${liveProbe.error}`;
  } else if (activeAccount) {
    elements.overviewMeta.textContent = liveProbe?.refreshed_at
      ? `Active account: ${activeAccount.label} | live headers refreshed ${formatRelative(liveProbe.refreshed_at)}`
      : `Active account: ${activeAccount.label}`;
  } else {
    elements.overviewMeta.textContent = 'No active OAuth account';
  }

  elements.overviewMainCard.innerHTML = `
    <div class="metric-grid">
      <div class="metric">
        <div class="metric-label">Active</div>
        <div class="metric-value">${overview.active_accounts}</div>
      </div>
      <div class="metric">
        <div class="metric-label">5h Utilization</div>
        <div class="metric-value">${activeQuota?.unified?.five_hour ? formatPercent(activeQuota.unified.five_hour.utilization) : 'No data'}</div>
      </div>
      <div class="metric">
        <div class="metric-label">7d Utilization</div>
        <div class="metric-value">${activeQuota?.unified?.seven_day ? formatPercent(activeQuota.unified.seven_day.utilization) : 'No data'}</div>
      </div>
    </div>
    <div class="account-copy">
      ${activeAccount
        ? `Live routing currently uses <strong>${escapeHtml(activeAccount.label)}</strong>. This card is sourced from a real proxy request to <strong>/v1/messages</strong>, matching the same header family you checked with curl.`
        : 'Authenticate an account to start proxying Claude requests and storing real quota snapshots.'}
    </div>
  `;

  elements.overviewHighlightsCard.innerHTML = `
    <div class="metric-grid">
      <div class="metric">
        <div class="metric-label">Highest Weekly Usage</div>
        <div class="metric-value">${highestWeekly ? formatPercent(highestWeekly.utilization) : 'No data'}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Requests</div>
        <div class="metric-value">${formatCompact(totals.requests)}</div>
      </div>
      <div class="metric">
        <div class="metric-label">Input / Output</div>
        <div class="metric-value">${formatCompact(totals.input_tokens)} / ${formatCompact(totals.output_tokens)}</div>
      </div>
    </div>
    <div class="account-copy">
      ${liveProbe?.error
        ? `The live proxy probe failed, so these values may be stale. Error: ${escapeHtml(liveProbe.error)}`
        : (highestWeekly
          ? `${escapeHtml(highestWeekly.label)} currently has the highest observed 7-day utilization and resets at ${escapeHtml(formatDate(highestWeekly.reset_at))}.`
          : 'Refresh the dashboard to fetch a live proxy header snapshot.')}
    </div>
  `;

  elements.overviewAccountsGrid.innerHTML = renderAccountCards(dashboard.accounts, true);
}

function renderQuotaBlock(title, quotaWindow, variant) {
  if (!quotaWindow || typeof quotaWindow.utilization !== 'number') {
    return `
      <div class="quota-block">
        <div class="quota-line">
          <div class="quota-title">${escapeHtml(title)}</div>
          <div class="quota-value">No snapshot</div>
        </div>
        <div class="quota-bar"><div class="quota-fill quota-fill-${variant}" style="width:0%"></div></div>
        <div class="quota-status">Use "Refresh Quota" to populate this window.</div>
      </div>
    `;
  }

  return `
    <div class="quota-block">
      <div class="quota-line">
        <div class="quota-title">${escapeHtml(title)}</div>
        <div class="quota-value">${escapeHtml(formatPercent(quotaWindow.utilization))} used</div>
      </div>
      <div class="quota-bar">
        <div class="quota-fill quota-fill-${variant}" style="width:${clampPercent(quotaWindow.utilization)}%"></div>
      </div>
      <div class="quota-status">
        Status: ${escapeHtml(quotaWindow.status || 'unknown')} | Resets at ${escapeHtml(formatDate(quotaWindow.reset_at))}
      </div>
    </div>
  `;
}

function renderEmptyState() {
  return `
    <div class="empty-state">
      <h3 class="empty-title">No linked accounts yet</h3>
      <p class="empty-copy">Start by authenticating a Claude subscription. The dashboard will then show real 5-hour and 7-day quota windows from Anthropic response headers.</p>
      <button class="primary-button" type="button" data-action="open-modal">Add Account</button>
    </div>
  `;
}

function renderAccountCards(accounts, compact = false) {
  if (!accounts.length) {
    return renderEmptyState();
  }

  return accounts.map((account) => {
    const unified = account.quota?.unified || null;
    const overageTag = unified?.overage_status && unified.overage_status !== 'rejected'
      ? `<span class="tag tag-warning">Overage ${escapeHtml(unified.overage_status)}</span>`
      : '';

    return `
      <article class="account-card" data-account-id="${escapeHtml(account.id)}">
        <div class="account-head">
          <div class="account-title-wrap">
            <div class="avatar">${escapeHtml((account.label || 'A').slice(0, 1).toUpperCase())}</div>
            <div class="account-title">
              <h3>${escapeHtml(account.label)}</h3>
              <div class="account-meta">
                Org: ${escapeHtml(shortOrgId(account.org_id))}<br>
                Expires: ${escapeHtml(formatDate(account.expires_at))}
              </div>
            </div>
          </div>
          <div class="account-actions">
            ${account.is_active ? '<span class="tag tag-active">Active</span>' : `<button class="ghost-button small" type="button" data-action="activate" data-id="${escapeHtml(account.id)}">Use This</button>`}
            <button class="ghost-button small" type="button" data-action="refresh" data-id="${escapeHtml(account.id)}">Refresh Quota</button>
            <button class="ghost-button small" type="button" data-action="rename" data-id="${escapeHtml(account.id)}">Rename</button>
            <button class="ghost-button small" type="button" data-action="delete" data-id="${escapeHtml(account.id)}">Delete</button>
          </div>
        </div>

        <div class="metric-grid">
          <div class="metric">
            <div class="metric-label">Requests</div>
            <div class="metric-value">${formatCompact(account.usage.request_count)}</div>
          </div>
          <div class="metric">
            <div class="metric-label">Input Tokens</div>
            <div class="metric-value">${formatCompact(account.usage.input_tokens)}</div>
          </div>
          <div class="metric">
            <div class="metric-label">Output Tokens</div>
            <div class="metric-value">${formatCompact(account.usage.output_tokens)}</div>
          </div>
        </div>

        <div class="quota-stack">
          ${renderQuotaBlock('Rate Limit (5h)', unified?.five_hour, 'five')}
          ${renderQuotaBlock('Weekly Limit (7d)', unified?.seven_day, 'seven')}
        </div>

        <div class="account-foot">
          <div>
            Last used: ${escapeHtml(formatRelative(account.last_used_at))}<br>
            Last model: ${escapeHtml(account.usage.last_model || 'Unknown')}
          </div>
          <div>
            ${account.is_active ? '<span class="tag tag-active">Routing Now</span>' : '<span class="tag tag-muted">Standby</span>'}
            ${overageTag}
          </div>
        </div>
      </article>
    `;
  }).join('');
}

function renderAccounts() {
  if (!state.dashboard) {
    return;
  }

  const accountsMarkup = renderAccountCards(state.dashboard.accounts, false);
  elements.accountsGrid.innerHTML = accountsMarkup;
}

function renderUsage() {
  const dashboard = state.dashboard;
  if (!dashboard) {
    return;
  }

  const totals = dashboard.overview.totals;
  const totalInputTokens =
    (Number(totals.input_tokens) || 0) +
    (Number(totals.cache_creation_input_tokens) || 0) +
    (Number(totals.cache_read_input_tokens) || 0);
  const totalOutputTokens = Number(totals.output_tokens) || 0;
  const totalTokens = totalInputTokens + totalOutputTokens;
  const usageCards = [
    ['Requests', formatCompact(totals.requests)],
    ['Total Tokens', formatCompact(totalTokens)],
    ['Total Input', formatCompact(totalInputTokens)],
    ['Total Output', formatCompact(totalOutputTokens)],
    ['Cache Read', formatCompact(totals.cache_read_input_tokens)],
    ['Cache Write', formatCompact(totals.cache_creation_input_tokens)]
  ];

  elements.usageCards.innerHTML = usageCards.map(([label, value]) => `
    <article class="usage-card">
      <div class="summary-label">${escapeHtml(label)}</div>
      <div class="summary-value">${escapeHtml(value)}</div>
    </article>
  `).join('');

  if (!dashboard.accounts.length) {
    elements.usageTableBody.innerHTML = `
      <tr>
        <td colspan="7" class="empty-copy">No account usage is available yet.</td>
      </tr>
    `;
    return;
  }

  elements.usageTableBody.innerHTML = dashboard.accounts.map((account) => `
    <tr>
      <td>${escapeHtml(account.label)}${account.is_active ? ' (active)' : ''}</td>
      <td>${formatNumber(account.usage.request_count)}</td>
      <td>${formatCompact((Number(account.usage.input_tokens) || 0) + (Number(account.usage.cache_creation_input_tokens) || 0) + (Number(account.usage.cache_read_input_tokens) || 0))}</td>
      <td>${formatCompact(account.usage.output_tokens)}</td>
      <td>${formatCompact(account.usage.cache_read_input_tokens)}</td>
      <td>${escapeHtml(account.usage.last_model || 'Unknown')}</td>
      <td>${escapeHtml(formatRelative(account.usage.last_response_at))}</td>
    </tr>
  `).join('');
}

function renderSettings() {
  const dashboard = state.dashboard;
  if (!dashboard) {
    return;
  }

  const meta = dashboard.meta;
  const cards = [
    {
      title: 'Runtime',
      lines: [
        ['Host', meta.server.host],
        ['Port', meta.server.port],
        ['Authenticated', meta.auth.authenticated ? 'Yes' : 'No'],
        ['Token Expires', meta.auth.expires_at ? formatDate(meta.auth.expires_at) : 'Not available']
      ]
    },
    {
      title: 'Storage',
      lines: [
        ['Accounts File', meta.accounts_path],
        ['Active Token File', meta.tokens_path],
        ['Dashboard', '/dashboard'],
        ['Proxy Endpoint', '/v1/messages']
      ]
    },
    {
      title: 'Fallback',
      lines: [
        ['Enabled', meta.fallback.enabled ? 'Yes' : 'No'],
        ['Credentials Detected', meta.fallback.detected ? 'Yes' : 'No'],
        ['Last Error', meta.fallback.error || 'None'],
        ['Auto Open Browser', meta.config.auto_open_browser ? 'Yes' : 'No']
      ]
    },
    {
      title: 'Notes',
      lines: [
        ['Quota Source', 'Anthropic response headers'],
        ['5h Window', 'anthropic-ratelimit-unified-5h-*'],
        ['7d Window', 'anthropic-ratelimit-unified-7d-*'],
        ['Refresh Behavior', 'Sends one tiny probe request']
      ]
    }
  ];

  elements.settingsGrid.innerHTML = cards.map((card) => `
    <article class="settings-card">
      <h3>${escapeHtml(card.title)}</h3>
      <div class="settings-list">
        ${card.lines.map(([label, value]) => `
          <div class="settings-line">
            <span>${escapeHtml(label)}</span>
            <span class="settings-code">${escapeHtml(value)}</span>
          </div>
        `).join('')}
      </div>
    </article>
  `).join('');
}

function renderAll() {
  renderSummaryCards();
  renderOverview();
  renderAccounts();
  renderUsage();
  renderSettings();
}

async function loadDashboard(refreshLive = true) {
  const query = refreshLive ? '?refresh=1' : '';
  const dashboard = await requestJson(`/admin/dashboard${query}`);
  state.dashboard = dashboard;
  renderAll();

  if (dashboard.meta?.live_proxy_probe?.error) {
    showToast(dashboard.meta.live_proxy_probe.error);
  }
}

async function refreshActiveQuota() {
  const activeId = state.dashboard?.overview?.active_account_id;
  if (!activeId) {
    showToast('No active account to refresh.');
    return;
  }

  await refreshQuota(activeId);
}

async function refreshQuota(accountId) {
  await requestJson(`/admin/accounts/${encodeURIComponent(accountId)}/refresh-quota`, {
    method: 'POST'
  });
  showToast('Quota refreshed.');
  await loadDashboard(false);
}

async function activateAccount(accountId) {
  await requestJson(`/admin/accounts/${encodeURIComponent(accountId)}/activate`, {
    method: 'POST'
  });
  showToast('Active account updated.');
  await loadDashboard(true);
}

async function renameAccount(accountId) {
  const account = state.dashboard?.accounts.find((item) => item.id === accountId);
  if (!account) {
    return;
  }

  const nextLabel = window.prompt('Rename account', account.label);
  if (!nextLabel || !nextLabel.trim()) {
    return;
  }

  await requestJson(`/admin/accounts/${encodeURIComponent(accountId)}`, {
    method: 'PATCH',
    body: JSON.stringify({ label: nextLabel.trim() })
  });
  showToast('Account renamed.');
  await loadDashboard(false);
}

async function deleteAccount(accountId) {
  const account = state.dashboard?.accounts.find((item) => item.id === accountId);
  if (!account) {
    return;
  }

  const confirmed = window.confirm(`Delete account "${account.label}"?`);
  if (!confirmed) {
    return;
  }

  await requestJson(`/admin/accounts/${encodeURIComponent(accountId)}`, {
    method: 'DELETE'
  });
  showToast('Account removed.');
  await loadDashboard(true);
}

function launchAddAccountFlow() {
  const label = elements.accountLabelInput.value.trim();
  const query = label ? `?label=${encodeURIComponent(label)}` : '';
  const popup = window.open(`/auth/login${query}`, 'claude-proxy-auth', 'width=860,height=900');
  if (!popup) {
    showToast('Popup blocked. Allow popups and try again.');
    return;
  }
  closeModal();
}

document.body.addEventListener('click', async (event) => {
  const actionTarget = event.target.closest('[data-action]');
  if (actionTarget) {
    const action = actionTarget.dataset.action;
    const accountId = actionTarget.dataset.id;

    try {
      if (action === 'activate') {
        await activateAccount(accountId);
      } else if (action === 'refresh') {
        await refreshQuota(accountId);
      } else if (action === 'rename') {
        await renameAccount(accountId);
      } else if (action === 'delete') {
        await deleteAccount(accountId);
      } else if (action === 'open-modal') {
        openModal();
      }
    } catch (error) {
      showToast(error.message);
    }

    return;
  }

  const closeTarget = event.target.closest('[data-close-modal]');
  if (closeTarget) {
    closeModal();
  }
});

elements.refreshDashboardBtn.addEventListener('click', async () => {
  try {
    await loadDashboard(true);
    showToast('Dashboard refreshed.');
  } catch (error) {
    showToast(error.message);
  }
});

elements.refreshAllBtn.addEventListener('click', async () => {
  try {
    await loadDashboard(true);
    showToast('Dashboard reloaded.');
  } catch (error) {
    showToast(error.message);
  }
});

elements.refreshActiveQuotaBtn.addEventListener('click', async () => {
  try {
    await refreshActiveQuota();
  } catch (error) {
    showToast(error.message);
  }
});

elements.openAddAccountBtn.addEventListener('click', openModal);
elements.manageAddAccountBtn.addEventListener('click', openModal);
elements.launchAuthBtn.addEventListener('click', launchAddAccountFlow);
elements.closeModalBtn.addEventListener('click', closeModal);
elements.cancelAddAccountBtn.addEventListener('click', closeModal);

elements.tabBar.addEventListener('click', (event) => {
  const button = event.target.closest('.tab');
  if (!button) {
    return;
  }
  setActiveTab(button.dataset.tab);
});

window.addEventListener('message', async (event) => {
  if (event.origin !== window.location.origin) {
    return;
  }

  if (event.data?.type === 'claude-proxy-auth-success') {
    showToast('New account linked.');
    await loadDashboard(true);
  }
});

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeModal();
  }
});

loadDashboard(true).catch((error) => {
  elements.overviewMeta.textContent = error.message;
  showToast(error.message);
});
