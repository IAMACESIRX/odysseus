/**
 * Device-local Mail Pro cache.
 *
 * Uses IndexedDB rather than localStorage so Mail Pro can cache large inboxes,
 * opened message bodies, and image blobs per device. This is intentionally
 * frontend-only: the server remains source of truth, while the UI paints from
 * cache immediately and refreshes in the background.
 */

const DB_NAME = 'odysseus-mail-pro-cache-v1';
const DB_VERSION = 1;
const NAV_TTL_MS = 24 * 60 * 60 * 1000;
const LIST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const BODY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const IMAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_IMAGES = 1500;
const MAX_BODIES = 2000;
const MAX_LISTS = 1000;
const MAX_IMAGE_BYTES = 16 * 1024 * 1024;

let _dbPromise = null;
const _objectUrls = new Map();

function now() { return Date.now(); }

function openDb() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB is unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('nav')) db.createObjectStore('nav', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('lists')) db.createObjectStore('lists', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('bodies')) db.createObjectStore('bodies', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('images')) db.createObjectStore('images', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      ['nav', 'lists', 'bodies', 'images'].forEach(name => {
        const store = req.transaction.objectStore(name);
        if (!store.indexNames.contains('cached_at')) store.createIndex('cached_at', 'cached_at');
      });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('Failed to open IndexedDB'));
  }).catch(err => {
    console.warn('Mail Pro cache disabled:', err);
    _dbPromise = null;
    throw err;
  });
  return _dbPromise;
}

async function withStore(name, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode);
    const store = tx.objectStore(name);
    let out;
    tx.oncomplete = () => resolve(out);
    tx.onerror = () => reject(tx.error || new Error(`IndexedDB ${name} transaction failed`));
    tx.onabort = () => reject(tx.error || new Error(`IndexedDB ${name} transaction aborted`));
    try { out = fn(store); } catch (err) { reject(err); }
  });
}

async function idbGet(storeName, key) {
  try {
    return await withStore(storeName, 'readonly', store => new Promise((resolve, reject) => {
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    }));
  } catch (_) { return null; }
}

async function idbPut(storeName, value) {
  try {
    await withStore(storeName, 'readwrite', store => store.put(value));
    return true;
  } catch (err) {
    console.warn('Mail Pro cache write failed:', err);
    return false;
  }
}

async function idbDelete(storeName, key) {
  try {
    await withStore(storeName, 'readwrite', store => store.delete(key));
    return true;
  } catch (_) { return false; }
}

async function getAllByAge(storeName) {
  try {
    return await withStore(storeName, 'readonly', store => new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    }));
  } catch (_) { return []; }
}

async function pruneStore(storeName, maxItems, ttlMs) {
  const rows = await getAllByAge(storeName);
  const cutoff = now() - ttlMs;
  const stale = rows.filter(r => (r.cached_at || 0) < cutoff).map(r => r.key);
  const overflow = rows
    .slice()
    .sort((a, b) => (a.cached_at || 0) - (b.cached_at || 0))
    .slice(0, Math.max(0, rows.length - maxItems))
    .map(r => r.key);
  const keys = [...new Set([...stale, ...overflow])];
  await Promise.all(keys.map(k => idbDelete(storeName, k)));
}

function safeClone(value) {
  try { return JSON.parse(JSON.stringify(value)); } catch (_) { return value; }
}

export function navKey(accountId = null) {
  return `nav:${accountId || 'all'}`;
}

export function listKey({ accountId = null, folder = 'INBOX', folderAccountId = null, filter = 'all', query = '' } = {}) {
  return [
    'list',
    accountId || 'all',
    folderAccountId || 'unified',
    folder || 'INBOX',
    filter || 'all',
    query || '',
  ].map(v => encodeURIComponent(String(v))).join(':');
}

export function bodyKey(message = {}) {
  return ['body', message.account_id || '', message.folder || 'INBOX', message.uid || ''].map(v => encodeURIComponent(String(v))).join(':');
}

export async function getNav(key) {
  const row = await idbGet('nav', key);
  return row?.data || null;
}

export async function setNav(key, data) {
  await idbPut('nav', { key, data: safeClone(data), cached_at: now() });
  pruneStore('nav', 50, NAV_TTL_MS).catch(() => {});
}

export async function getList(key) {
  const row = await idbGet('lists', key);
  return row?.data || null;
}

export async function setList(key, data) {
  await idbPut('lists', { key, data: safeClone(data), cached_at: now() });
  pruneStore('lists', MAX_LISTS, LIST_TTL_MS).catch(() => {});
}

export async function getBody(key) {
  const row = await idbGet('bodies', key);
  return row?.data || null;
}

export async function setBody(key, data) {
  await idbPut('bodies', { key, data: safeClone(data), cached_at: now() });
  pruneStore('bodies', MAX_BODIES, BODY_TTL_MS).catch(() => {});
}

export async function patchCachedMessage(listKeyValue, messageKeyFn, message, patch) {
  const cached = await getList(listKeyValue);
  if (!cached || !Array.isArray(cached.emails)) return;
  cached.emails = cached.emails.map(row => messageKeyFn(row) === messageKeyFn(message) ? { ...row, ...patch } : row);
  await setList(listKeyValue, cached);
}

export async function removeCachedMessages(listKeyValue, messageKeyFn, keys) {
  const cached = await getList(listKeyValue);
  if (!cached || !Array.isArray(cached.emails)) return;
  const keySet = new Set(keys);
  cached.emails = cached.emails.filter(row => !keySet.has(messageKeyFn(row)));
  cached.total = Math.max(0, Number(cached.total || cached.emails.length) - keySet.size);
  await setList(listKeyValue, cached);
}

function cachedImageObjectUrl(key, blob) {
  const existing = _objectUrls.get(key);
  if (existing) return existing;
  const url = URL.createObjectURL(blob);
  _objectUrls.set(key, url);
  return url;
}

async function getImage(key) {
  const row = await idbGet('images', key);
  if (!row?.blob) return null;
  return row.blob;
}

async function setImage(key, blob, contentType = '') {
  await idbPut('images', { key, blob, content_type: contentType, size: blob.size || 0, cached_at: now() });
  pruneStore('images', MAX_IMAGES, IMAGE_TTL_MS).catch(() => {});
}

export async function cacheImagesIn(root) {
  if (!root) return;
  const imgs = [...root.querySelectorAll('img[src]')];
  for (const img of imgs) {
    const src = img.getAttribute('src') || '';
    if (!src || src.startsWith('blob:') || src.startsWith('data:')) continue;
    if (!src.includes('/api/email/pro/image-proxy') && !src.includes('/api/email/inline/')) continue;
    const key = `img:${src}`;
    try {
      const cached = await getImage(key);
      if (cached) {
        img.src = cachedImageObjectUrl(key, cached);
        img.dataset.mailProImageCached = '1';
        continue;
      }
      const res = await fetch(src, { credentials: 'same-origin', cache: 'force-cache' });
      if (!res.ok) continue;
      const blob = await res.blob();
      if (!blob || blob.size <= 0 || blob.size > MAX_IMAGE_BYTES) continue;
      await setImage(key, blob, blob.type || res.headers.get('Content-Type') || '');
      img.src = cachedImageObjectUrl(key, blob);
      img.dataset.mailProImageCached = '1';
    } catch (err) {
      console.debug('Mail Pro image cache skipped:', err);
    }
  }
}

export async function clearMailProCache() {
  const db = await openDb();
  await Promise.all([...db.objectStoreNames].map(name => new Promise((resolve, reject) => {
    const tx = db.transaction(name, 'readwrite');
    tx.objectStore(name).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  })));
  for (const url of _objectUrls.values()) URL.revokeObjectURL(url);
  _objectUrls.clear();
}

export function warmCache() {
  openDb().then(() => {
    pruneStore('lists', MAX_LISTS, LIST_TTL_MS).catch(() => {});
    pruneStore('bodies', MAX_BODIES, BODY_TTL_MS).catch(() => {});
    pruneStore('images', MAX_IMAGES, IMAGE_TTL_MS).catch(() => {});
  }).catch(() => {});
}
