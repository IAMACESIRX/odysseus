/**
 * Email Pro — Thunderbird-inspired Odysseus mail client shell.
 *
 * This is intentionally Odysseus-native rather than a Thunderbird source import:
 * - account / folder rail
 * - quick filter bar
 * - virtualized-ish paged message list
 * - reader pane
 * - compose drawer
 * - IMAP/SMTP through the existing /api/email routes
 */

import { folderDisplayName, sortedFolders } from '../emailInbox.js';
import { showToast, styledConfirm } from '../ui.js';
import { makeWindowDraggable } from '../windowDrag.js';
import { _esc, _escLinkify, _formatBubbleDate, _senderColor, _initials, _sanitizeHtml } from '../emailLibrary/utils.js';

const API_BASE = window.location.origin;
const LIMIT = 50;
const DENSITY_KEY = 'odysseus.emailPro.density';
const PANE_KEY = 'odysseus.emailPro.readerPane';
const ENABLED_KEY = 'odysseus.emailPro.enabled';

const st = {
  open: false,
  accounts: [],
  accountId: null,
  accountName: 'All',
  folders: ['INBOX'],
  folder: 'INBOX',
  filter: 'all',
  query: '',
  messages: [],
  total: 0,
  offset: 0,
  loading: false,
  loadingMore: false,
  selected: new Set(),
  activeUid: null,
  activeMessage: null,
  bodies: new Map(),
  foldersLoading: false,
  density: localStorage.getItem(DENSITY_KEY) || 'comfortable',
  readerPane: localStorage.getItem(PANE_KEY) || 'right',
  searchTimer: null,
};

function acctQS(accountId = st.accountId) {
  return accountId ? `&account_id=${encodeURIComponent(accountId)}` : '';
}

function folderQS() {
  return `folder=${encodeURIComponent(st.folder)}${acctQS()}`;
}

function messageKey(uid, folder = st.folder, accountId = st.accountId) {
  return `${accountId || ''}|${folder}|${uid}`;
}

function fmtDate(m) {
  if (!m) return '';
  const v = m.date || m.date_display || '';
  if (!v) return '';
  const d = new Date(v);
  if (!Number.isNaN(d.getTime())) {
    const now = new Date();
    const sameDay = d.toDateString() === now.toDateString();
    const ageMs = now - d;
    if (sameDay) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    if (ageMs < 6 * 24 * 60 * 60 * 1000) return d.toLocaleDateString([], { weekday: 'short' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }
  return String(v).replace(/\s+[+-]\d{4}.*$/, '');
}

function senderName(m) {
  const sentLike = /sent|draft|outbox/i.test(st.folder || '');
  if (sentLike && m?.to) return `To: ${String(m.to).split(',')[0].trim()}`;
  return m?.from_name || m?.from_address || 'Unknown sender';
}

function hasMore() {
  return st.messages.length < st.total;
}

function modal() { return document.getElementById('email-pro-modal'); }
function el(id) { return document.getElementById(id); }

export async function openEmailProLibrary(opts = {}) {
  closeEmailProLibrary();
  st.open = true;
  st.selected.clear();
  st.activeUid = opts.uid || null;
  st.activeMessage = null;
  st.messages = [];
  st.total = 0;
  st.offset = 0;
  st.query = '';
  st.filter = 'all';
  if (Object.prototype.hasOwnProperty.call(opts, 'account_id')) st.accountId = opts.account_id || null;
  if (opts.folder) st.folder = opts.folder;

  const node = document.createElement('div');
  node.id = 'email-pro-modal';
  node.className = `modal email-pro-modal email-pro-density-${st.density} email-pro-pane-${st.readerPane}`;
  node.innerHTML = renderShell();
  document.body.appendChild(node);

  try { makeWindowDraggable?.(node.querySelector('.email-pro-window'), node.querySelector('.email-pro-titlebar')); } catch (_) {}
  wireShell(node);
  renderAll();
  await loadAccounts();
  await loadFolders();
  await loadMessages({ reset: true });
}

export function closeEmailProLibrary() {
  const m = modal();
  if (m) m.remove();
  st.open = false;
}

function renderShell() {
  return `
    <div class="modal-content email-pro-window" role="dialog" aria-modal="true" aria-label="Email Pro">
      <div class="email-pro-titlebar">
        <div class="email-pro-title-main">
          <span class="email-pro-app-icon" aria-hidden="true">✉</span>
          <div>
            <div class="email-pro-title">Email Pro</div>
            <div class="email-pro-subtitle">Thunderbird-inspired tri-pane mail client</div>
          </div>
        </div>
        <div class="email-pro-title-actions">
          <button class="email-pro-icon-btn" id="email-pro-legacy" title="Switch to the legacy email view">Legacy</button>
          <button class="email-pro-icon-btn" id="email-pro-min" title="Minimize">—</button>
          <button class="email-pro-icon-btn danger" id="email-pro-close" title="Close">×</button>
        </div>
      </div>

      <div class="email-pro-toolbar">
        <button class="email-pro-primary" id="email-pro-compose">Compose</button>
        <button class="email-pro-tool" id="email-pro-refresh">Refresh</button>
        <button class="email-pro-tool" id="email-pro-archive" disabled>Archive</button>
        <button class="email-pro-tool" id="email-pro-delete" disabled>Delete</button>
        <button class="email-pro-tool" id="email-pro-read" disabled>Mark read</button>
        <button class="email-pro-tool" id="email-pro-unread" disabled>Unread</button>
        <div class="email-pro-search-wrap">
          <input id="email-pro-search" class="email-pro-search" placeholder="Search mail" autocomplete="off" />
          <button id="email-pro-search-clear" class="email-pro-search-clear" title="Clear search">×</button>
        </div>
        <select id="email-pro-density" class="email-pro-select" title="Density">
          <option value="compact">Compact</option>
          <option value="comfortable">Comfortable</option>
          <option value="spacious">Spacious</option>
        </select>
        <select id="email-pro-pane-mode" class="email-pro-select" title="Reader pane">
          <option value="right">Right pane</option>
          <option value="bottom">Bottom pane</option>
          <option value="focus">Focus reader</option>
        </select>
      </div>

      <div class="email-pro-quickbar">
        <button class="email-pro-chip active" data-filter="all">All</button>
        <button class="email-pro-chip" data-filter="unread">Unread</button>
        <button class="email-pro-chip" data-filter="favorites">Starred</button>
        <button class="email-pro-chip" data-filter="undone">Undone</button>
        <button class="email-pro-chip" data-filter="unanswered">Unanswered</button>
        <button class="email-pro-chip" data-filter="has-attachments">Attachments</button>
        <span class="email-pro-status" id="email-pro-status">Ready</span>
      </div>

      <div class="email-pro-main">
        <aside class="email-pro-sidebar">
          <div class="email-pro-section-label">Accounts</div>
          <div id="email-pro-accounts" class="email-pro-accounts"></div>
          <div class="email-pro-section-label folders-label">Folders</div>
          <div id="email-pro-folders" class="email-pro-folders"></div>
        </aside>

        <section class="email-pro-list-pane">
          <div class="email-pro-list-head">
            <label class="email-pro-select-all"><input type="checkbox" id="email-pro-select-all"> <span id="email-pro-count-label">0 messages</span></label>
            <span id="email-pro-folder-label" class="email-pro-folder-label">Inbox</span>
          </div>
          <div id="email-pro-list" class="email-pro-list" tabindex="0"></div>
          <div class="email-pro-list-foot">
            <button id="email-pro-load-more" class="email-pro-load-more">Load older mail</button>
          </div>
        </section>

        <section id="email-pro-reader" class="email-pro-reader-pane">
          <div class="email-pro-empty-reader">
            <div class="email-pro-empty-icon">✉</div>
            <h3>Select a message</h3>
            <p>Read, reply, forward, summarize, or convert mail into Odysseus tasks.</p>
          </div>
        </section>
      </div>
    </div>
  `;
}

function wireShell(root) {
  el('email-pro-close')?.addEventListener('click', closeEmailProLibrary);
  el('email-pro-min')?.addEventListener('click', () => root.classList.toggle('email-pro-minimized'));
  el('email-pro-legacy')?.addEventListener('click', async () => {
    // User-requested toggle: remember Legacy until they click Email Pro again.
    localStorage.setItem(ENABLED_KEY, '0');
    closeEmailProLibrary();
    const legacy = await import('../emailLibrary.js');
    legacy.openEmailLibrary({ legacy: true, account_id: st.accountId, folder: st.folder });
  });
  el('email-pro-refresh')?.addEventListener('click', () => loadMessages({ reset: true, force: true }));
  el('email-pro-compose')?.addEventListener('click', () => openCompose());
  el('email-pro-load-more')?.addEventListener('click', () => loadMore());
  el('email-pro-select-all')?.addEventListener('change', e => {
    st.selected.clear();
    if (e.target.checked) st.messages.forEach(m => st.selected.add(String(m.uid)));
    renderMessageList();
    updateBulkState();
  });
  el('email-pro-density').value = st.density;
  el('email-pro-density')?.addEventListener('change', e => {
    st.density = e.target.value;
    localStorage.setItem(DENSITY_KEY, st.density);
    modal()?.classList.remove('email-pro-density-compact', 'email-pro-density-comfortable', 'email-pro-density-spacious');
    modal()?.classList.add(`email-pro-density-${st.density}`);
  });
  el('email-pro-pane-mode').value = st.readerPane;
  el('email-pro-pane-mode')?.addEventListener('change', e => {
    st.readerPane = e.target.value;
    localStorage.setItem(PANE_KEY, st.readerPane);
    modal()?.classList.remove('email-pro-pane-right', 'email-pro-pane-bottom', 'email-pro-pane-focus');
    modal()?.classList.add(`email-pro-pane-${st.readerPane}`);
  });
  el('email-pro-search')?.addEventListener('input', e => {
    st.query = e.target.value.trim();
    clearTimeout(st.searchTimer);
    st.searchTimer = setTimeout(() => loadMessages({ reset: true }), 350);
  });
  el('email-pro-search-clear')?.addEventListener('click', () => {
    const input = el('email-pro-search');
    if (input) input.value = '';
    st.query = '';
    loadMessages({ reset: true });
  });
  root.querySelectorAll('.email-pro-chip[data-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      st.filter = btn.dataset.filter;
      root.querySelectorAll('.email-pro-chip').forEach(b => b.classList.toggle('active', b === btn));
      loadMessages({ reset: true });
    });
  });
  el('email-pro-archive')?.addEventListener('click', () => bulkAction('archive'));
  el('email-pro-delete')?.addEventListener('click', () => bulkAction('delete'));
  el('email-pro-read')?.addEventListener('click', () => bulkAction('read'));
  el('email-pro-unread')?.addEventListener('click', () => bulkAction('unread'));
  el('email-pro-list')?.addEventListener('scroll', () => {
    const list = el('email-pro-list');
    if (!list || st.loading || st.loadingMore || !hasMore()) return;
    if (list.scrollTop + list.clientHeight >= list.scrollHeight - 260) loadMore();
  });
  document.addEventListener('keydown', keyHandler, true);
}

function keyHandler(e) {
  if (!st.open || e.defaultPrevented) return;
  const target = e.target;
  const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
  if (typing) return;
  if (e.key === 'Escape') {
    const composer = document.querySelector('.email-pro-compose-drawer');
    if (composer) composer.remove(); else closeEmailProLibrary();
    e.preventDefault();
  } else if (e.key.toLowerCase() === 'r' && st.activeMessage) {
    openCompose({ replyTo: st.activeMessage });
    e.preventDefault();
  } else if (e.key.toLowerCase() === 'c') {
    openCompose();
    e.preventDefault();
  } else if (e.key === 'Delete' && st.selected.size) {
    bulkAction('delete');
    e.preventDefault();
  }
}

function setStatus(text, busy = false) {
  const s = el('email-pro-status');
  if (!s) return;
  s.textContent = text;
  s.classList.toggle('busy', busy);
}

async function loadAccounts() {
  try {
    const res = await fetch(`${API_BASE}/api/email/accounts`, { credentials: 'same-origin' });
    const data = await res.json();
    st.accounts = data.accounts || [];
    if (st.accounts.length && !st.accountId) {
      const def = st.accounts.find(a => a.is_default) || st.accounts[0];
      st.accountId = def.id;
    }
    renderAccounts();
  } catch (err) {
    console.error('Email Pro account load failed', err);
    st.accounts = [];
    renderAccounts();
  }
}

async function loadFolders() {
  st.foldersLoading = true;
  renderFolders();
  try {
    const res = await fetch(`${API_BASE}/api/email/folders?_=${Date.now()}${acctQS()}`, { credentials: 'same-origin' });
    const data = await res.json();
    st.folders = sortedFolders(data.folders || ['INBOX']);
    if (!st.folders.includes(st.folder)) st.folder = st.folders[0] || 'INBOX';
  } catch (err) {
    console.error('Email Pro folder load failed', err);
    st.folders = ['INBOX'];
  } finally {
    st.foldersLoading = false;
    renderFolders();
  }
}

async function loadMessages({ reset = false, force = false } = {}) {
  if (st.loading) return;
  st.loading = true;
  if (reset) {
    st.offset = 0;
    st.messages = [];
    st.total = 0;
    st.selected.clear();
    st.activeUid = null;
    st.activeMessage = null;
    renderReaderEmpty();
  }
  renderMessageList();
  setStatus('Loading mail…', true);
  try {
    const params = new URLSearchParams();
    params.set('folder', st.folder);
    params.set('limit', String(LIMIT));
    params.set('offset', String(st.offset));
    params.set('filter', st.filter === 'has-attachments' ? 'all' : st.filter);
    if (st.accountId) params.set('account_id', st.accountId);
    if (st.filter === 'has-attachments') params.set('has_attachments', '1');
    if (force) params.set('_', String(Date.now()));
    const endpoint = st.query ? '/api/email/search' : '/api/email/list';
    if (st.query) {
      params.set('q', st.query);
      params.set('limit', String(LIMIT));
      params.delete('offset');
      params.delete('filter');
      if (st.filter === 'has-attachments') params.set('has_attachments', '1');
    }
    const res = await fetch(`${API_BASE}${endpoint}?${params.toString()}`, { credentials: 'same-origin' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const incoming = data.emails || [];
    st.messages = reset || st.query ? incoming : [...st.messages, ...incoming];
    st.total = Number(data.total ?? st.messages.length) || st.messages.length;
    st.offset = st.messages.length;
    setStatus(st.query ? `Search: ${st.messages.length} result${st.messages.length === 1 ? '' : 's'}` : `${st.messages.length} of ${st.total}`);
    renderAll();
    const pending = st.activeUid || null;
    if (pending) {
      const msg = st.messages.find(m => String(m.uid) === String(pending));
      if (msg) selectMessage(msg);
    }
  } catch (err) {
    console.error(err);
    setStatus(err.message || 'Mail load failed');
    showToast?.(err.message || 'Mail load failed');
    renderAll();
  } finally {
    st.loading = false;
    renderMessageList();
    updateBulkState();
  }
}

async function loadMore() {
  if (st.query || !hasMore() || st.loadingMore) return;
  st.loadingMore = true;
  setStatus('Loading older mail…', true);
  try {
    await loadMessages({ reset: false });
  } finally {
    st.loadingMore = false;
  }
}

function renderAll() {
  renderAccounts();
  renderFolders();
  renderMessageList();
  updateBulkState();
}

function renderAccounts() {
  const box = el('email-pro-accounts');
  if (!box) return;
  const accounts = st.accounts.length ? st.accounts : [{ id: '', name: 'Default account', from_address: '', is_default: true }];
  box.innerHTML = accounts.map(a => {
    const active = String(st.accountId || '') === String(a.id || '');
    const label = a.name || a.from_address || a.imap_user || 'Account';
    const sub = a.from_address || a.imap_user || (a.is_default ? 'Default' : '');
    return `<button class="email-pro-account ${active ? 'active' : ''}" data-account-id="${_esc(a.id || '')}">
      <span class="email-pro-avatar" style="--avatar-color:${_senderColor(label)}">${_esc(_initials(label))}</span>
      <span class="email-pro-account-text"><strong>${_esc(label)}</strong><small>${_esc(sub)}</small></span>
    </button>`;
  }).join('');
  box.querySelectorAll('.email-pro-account').forEach(btn => {
    btn.addEventListener('click', async () => {
      st.accountId = btn.dataset.accountId || null;
      st.accountName = btn.textContent.trim();
      await loadFolders();
      await loadMessages({ reset: true, force: true });
    });
  });
}

function folderIcon(name) {
  const n = String(name || '').toLowerCase();
  if (n.includes('sent')) return '↗';
  if (n.includes('draft')) return '✎';
  if (n.includes('trash') || n.includes('deleted')) return '⌫';
  if (n.includes('junk') || n.includes('spam')) return '⚠';
  if (n.includes('archive')) return '▣';
  return '▤';
}

function renderFolders() {
  const box = el('email-pro-folders');
  if (!box) return;
  if (st.foldersLoading) {
    box.innerHTML = '<div class="email-pro-sidebar-loading">Loading folders…</div>';
    return;
  }
  box.innerHTML = (st.folders || ['INBOX']).map(f => `
    <button class="email-pro-folder ${f === st.folder ? 'active' : ''}" data-folder="${_esc(f)}">
      <span>${folderIcon(f)}</span><span>${_esc(folderDisplayName(f))}</span>
    </button>
  `).join('');
  box.querySelectorAll('.email-pro-folder').forEach(btn => {
    btn.addEventListener('click', () => {
      st.folder = btn.dataset.folder || 'INBOX';
      loadMessages({ reset: true, force: true });
    });
  });
}

function renderMessageList() {
  const list = el('email-pro-list');
  const folderLabel = el('email-pro-folder-label');
  const count = el('email-pro-count-label');
  const loadMoreBtn = el('email-pro-load-more');
  if (folderLabel) folderLabel.textContent = folderDisplayName(st.folder);
  if (count) count.textContent = `${st.messages.length}${st.total ? ` of ${st.total}` : ''} message${st.messages.length === 1 ? '' : 's'}`;
  if (loadMoreBtn) {
    loadMoreBtn.hidden = !!st.query || !hasMore();
    loadMoreBtn.disabled = st.loading || st.loadingMore;
    loadMoreBtn.textContent = st.loadingMore ? 'Loading older mail…' : 'Load older mail';
  }
  if (!list) return;
  if (!st.messages.length) {
    list.innerHTML = st.loading
      ? skeletonRows()
      : `<div class="email-pro-empty-list"><strong>No mail here.</strong><span>Try another folder, account, or filter.</span></div>`;
    return;
  }
  list.innerHTML = st.messages.map(renderMessageRow).join('') + (st.loading && st.offset === 0 ? skeletonRows() : '');
  list.querySelectorAll('.email-pro-message').forEach(row => {
    row.addEventListener('click', e => {
      if (e.target.closest('input,button')) return;
      const msg = st.messages.find(m => String(m.uid) === String(row.dataset.uid));
      if (msg) selectMessage(msg);
    });
    row.querySelector('.email-pro-row-check')?.addEventListener('change', e => {
      const uid = String(row.dataset.uid);
      if (e.target.checked) st.selected.add(uid); else st.selected.delete(uid);
      row.classList.toggle('selected', st.selected.has(uid));
      updateBulkState();
    });
    row.querySelector('.email-pro-row-star')?.addEventListener('click', async e => {
      e.stopPropagation();
      const msg = st.messages.find(m => String(m.uid) === String(row.dataset.uid));
      if (msg) await toggleStar(msg);
    });
  });
}

function skeletonRows() {
  return Array.from({ length: 8 }, (_, i) => `<div class="email-pro-message skeleton" style="--i:${i}"><span></span><b></b><em></em></div>`).join('');
}

function renderMessageRow(m) {
  const uid = String(m.uid);
  const active = String(st.activeUid || '') === uid;
  const selected = st.selected.has(uid);
  const unread = !m.is_read;
  const tags = Array.isArray(m.tags) ? m.tags : [];
  const preview = m.cached_summary || m.snippet || m.to || m.cc || '';
  return `
    <article class="email-pro-message ${active ? 'active' : ''} ${selected ? 'selected' : ''} ${unread ? 'unread' : ''}" data-uid="${_esc(uid)}">
      <div class="email-pro-row-left">
        <input class="email-pro-row-check" type="checkbox" ${selected ? 'checked' : ''} aria-label="Select message" />
        <button class="email-pro-row-star ${m.is_flagged ? 'active' : ''}" title="Star" aria-label="Star">★</button>
      </div>
      <div class="email-pro-sender-avatar" style="--avatar-color:${_senderColor(senderName(m))}">${_esc(_initials(senderName(m)))}</div>
      <div class="email-pro-row-main">
        <div class="email-pro-row-top">
          <strong class="email-pro-row-sender">${_esc(senderName(m))}</strong>
          <span class="email-pro-row-date">${_esc(fmtDate(m))}</span>
        </div>
        <div class="email-pro-row-subject">${_esc(m.subject || '(no subject)')}</div>
        <div class="email-pro-row-preview">${m.has_attachments ? '<span class="email-pro-attach">📎</span>' : ''}${_esc(preview)}</div>
        ${tags.length ? `<div class="email-pro-row-tags">${tags.slice(0, 4).map(t => `<span>${_esc(t)}</span>`).join('')}</div>` : ''}
      </div>
    </article>
  `;
}

function updateBulkState() {
  const any = st.selected.size > 0;
  ['email-pro-archive', 'email-pro-delete', 'email-pro-read', 'email-pro-unread'].forEach(id => {
    const b = el(id);
    if (b) b.disabled = !any;
  });
  const cb = el('email-pro-select-all');
  if (cb) {
    cb.checked = st.messages.length > 0 && st.messages.every(m => st.selected.has(String(m.uid)));
    cb.indeterminate = st.selected.size > 0 && !cb.checked;
  }
}

async function selectMessage(m) {
  st.activeUid = String(m.uid);
  st.activeMessage = m;
  renderMessageList();
  const reader = el('email-pro-reader');
  if (!reader) return;
  reader.innerHTML = `<div class="email-pro-reader-loading">Loading message…</div>`;
  const key = messageKey(m.uid);
  try {
    let data = st.bodies.get(key);
    if (!data) {
      const res = await fetch(`${API_BASE}/api/email/read/${encodeURIComponent(m.uid)}?${folderQS()}`, { credentials: 'same-origin' });
      data = await res.json();
      if (data.error) throw new Error(data.error);
      st.bodies.set(key, data);
    }
    st.activeMessage = { ...m, ...data };
    if (!m.is_read) {
      m.is_read = true;
      fetch(`${API_BASE}/api/email/mark-read/${encodeURIComponent(m.uid)}?${folderQS()}`, { method: 'POST', credentials: 'same-origin' }).catch(() => {});
    }
    renderReader(st.activeMessage);
    renderMessageList();
  } catch (err) {
    reader.innerHTML = `<div class="email-pro-reader-error">${_esc(err.message || 'Unable to read message')}</div>`;
  }
}

function renderReaderEmpty() {
  const reader = el('email-pro-reader');
  if (!reader) return;
  reader.innerHTML = `<div class="email-pro-empty-reader"><div class="email-pro-empty-icon">✉</div><h3>Select a message</h3><p>The reader pane keeps context while you work through mail.</p></div>`;
}

function renderReader(data) {
  const reader = el('email-pro-reader');
  if (!reader) return;
  const body = data.body_html
    ? _sanitizeHtml(data.body_html)
    : _escLinkify(data.body || data.text || '').replace(/\n/g, '<br>');
  reader.innerHTML = `
    <div class="email-pro-reader-head">
      <div class="email-pro-reader-subject">${_esc(data.subject || '(no subject)')}</div>
      <div class="email-pro-reader-actions">
        <button class="email-pro-tool" data-reader-action="reply">Reply</button>
        <button class="email-pro-tool" data-reader-action="forward">Forward</button>
        <button class="email-pro-tool" data-reader-action="archive">Archive</button>
        <button class="email-pro-tool danger" data-reader-action="delete">Delete</button>
      </div>
    </div>
    <div class="email-pro-reader-meta">
      <div class="email-pro-reader-avatar" style="--avatar-color:${_senderColor(senderName(data))}">${_esc(_initials(senderName(data)))}</div>
      <div>
        <div><strong>${_esc(data.from_name || data.from_address || senderName(data))}</strong> <span>${_esc(data.from_address || '')}</span></div>
        <div class="email-pro-reader-to">To: ${_esc(data.to || '')}</div>
        <div class="email-pro-reader-date">${_esc(_formatBubbleDate(data.date || data.date_display || '') || data.date_display || '')}</div>
      </div>
    </div>
    ${Array.isArray(data.attachments) && data.attachments.length ? renderAttachments(data) : ''}
    <div class="email-pro-reader-body">${body}</div>
  `;
  reader.querySelectorAll('[data-reader-action]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.readerAction;
      if (action === 'reply') openCompose({ replyTo: data });
      else if (action === 'forward') openCompose({ forward: data });
      else if (action === 'archive') await singleAction(data, 'archive');
      else if (action === 'delete') await singleAction(data, 'delete');
    });
  });
}

function renderAttachments(data) {
  return `<div class="email-pro-attachments">${data.attachments.map((a, idx) => `
    <a class="email-pro-attachment" href="/api/email/attachment/${encodeURIComponent(data.uid)}/${idx}?${folderQS()}" target="_blank" rel="noopener">📎 ${_esc(a.filename || `Attachment ${idx + 1}`)}</a>
  `).join('')}</div>`;
}

async function toggleStar(m) {
  const endpoint = m.is_flagged ? 'unflag' : 'flag';
  try {
    const res = await fetch(`${API_BASE}/api/email/${endpoint}/${encodeURIComponent(m.uid)}?${folderQS()}`, { method: 'POST', credentials: 'same-origin' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.success === false) throw new Error(data.error || 'Star update failed');
    m.is_flagged = !m.is_flagged;
    renderMessageList();
  } catch (err) {
    showToast?.(err.message || 'Star update failed');
  }
}

async function singleAction(m, action) {
  st.selected.clear();
  st.selected.add(String(m.uid));
  await bulkAction(action);
}

async function bulkAction(action) {
  const ids = [...st.selected];
  if (!ids.length) return;
  if (action === 'delete') {
    const ok = await styledConfirm?.(`Delete ${ids.length} message${ids.length === 1 ? '' : 's'}?`);
    if (ok === false) return;
  }
  setStatus(`${action}…`, true);
  const calls = ids.map(uid => {
    let url = '';
    let method = 'POST';
    if (action === 'archive') url = `/api/email/archive/${encodeURIComponent(uid)}?${folderQS()}`;
    if (action === 'delete') { url = `/api/email/delete/${encodeURIComponent(uid)}?${folderQS()}`; method = 'DELETE'; }
    if (action === 'read') url = `/api/email/mark-read/${encodeURIComponent(uid)}?${folderQS()}`;
    if (action === 'unread') url = `/api/email/mark-unread/${encodeURIComponent(uid)}?${folderQS()}`;
    return fetch(`${API_BASE}${url}`, { method, credentials: 'same-origin' }).catch(err => ({ ok: false, err }));
  });
  await Promise.all(calls);
  st.selected.clear();
  await loadMessages({ reset: true, force: true });
}

function openCompose({ replyTo = null, forward = null } = {}) {
  document.querySelector('.email-pro-compose-drawer')?.remove();
  const subjectPrefix = replyTo ? 'Re: ' : forward ? 'Fwd: ' : '';
  const src = replyTo || forward || {};
  const to = replyTo ? (src.from_address || '') : '';
  const subjectRaw = src.subject || '';
  const subject = subjectRaw && !subjectRaw.toLowerCase().startsWith(subjectPrefix.toLowerCase().trim())
    ? `${subjectPrefix}${subjectRaw}`
    : subjectRaw;
  const quoted = replyTo || forward ? `\n\n--- Original message ---\nFrom: ${src.from_address || src.from_name || ''}\nDate: ${src.date_display || src.date || ''}\nSubject: ${src.subject || ''}\n\n${src.body || ''}` : '';

  const drawer = document.createElement('div');
  drawer.className = 'email-pro-compose-drawer';
  drawer.innerHTML = `
    <div class="email-pro-compose-head">
      <strong>${replyTo ? 'Reply' : forward ? 'Forward' : 'New message'}</strong>
      <button class="email-pro-icon-btn" data-close>×</button>
    </div>
    <div class="email-pro-compose-fields">
      <input id="email-pro-compose-to" placeholder="To" value="${_esc(to)}" />
      <input id="email-pro-compose-cc" placeholder="Cc" />
      <input id="email-pro-compose-subject" placeholder="Subject" value="${_esc(subject)}" />
    </div>
    <textarea id="email-pro-compose-body" placeholder="Write your message…">${_esc(quoted)}</textarea>
    <div class="email-pro-compose-actions">
      <button class="email-pro-primary" id="email-pro-compose-send">Send</button>
      <button class="email-pro-tool" data-close>Discard</button>
      <span id="email-pro-compose-status"></span>
    </div>
  `;
  modal()?.appendChild(drawer);
  drawer.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => drawer.remove()));
  drawer.querySelector('#email-pro-compose-send')?.addEventListener('click', async () => {
    const status = drawer.querySelector('#email-pro-compose-status');
    const payload = {
      to: drawer.querySelector('#email-pro-compose-to').value.trim(),
      cc: drawer.querySelector('#email-pro-compose-cc').value.trim() || null,
      subject: drawer.querySelector('#email-pro-compose-subject').value.trim(),
      body: drawer.querySelector('#email-pro-compose-body').value,
      account_id: st.accountId || null,
      in_reply_to: replyTo?.message_id || null,
      references: replyTo?.references || replyTo?.message_id || null,
    };
    if (!payload.to || !payload.subject) {
      status.textContent = 'To and subject required.';
      return;
    }
    status.textContent = 'Sending…';
    try {
      const res = await fetch(`${API_BASE}/api/email/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok || data.success === false) throw new Error(data.error || 'Send failed');
      status.textContent = 'Sent.';
      showToast?.('Email sent');
      setTimeout(() => drawer.remove(), 650);
    } catch (err) {
      status.textContent = err.message || 'Send failed';
    }
  });
  setTimeout(() => drawer.querySelector('#email-pro-compose-to')?.focus(), 50);
}
