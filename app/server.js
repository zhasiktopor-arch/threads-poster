// Threads Poster — локальный автопостинг в Threads.
// Проекты изолированы: у каждого свой токен, очередь, слоты и журнал.
// Чужой проект не может опубликовать чужие посты.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFile } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 7790;
const DEFAULT_DATA_DIR = process.platform === 'win32'
  ? path.join(process.env.APPDATA || os.homedir(), 'ThreadsPoster')
  : process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library/Application Support/ThreadsPoster')
    : path.join(os.homedir(), '.threads-poster');
const DATA_DIR = process.env.DATA_DIR || DEFAULT_DATA_DIR;
fs.mkdirSync(DATA_DIR, { recursive: true });

const MAX_LEN = 500;
const IS_MAC = process.platform === 'darwin';
const LISTEN_HOST = process.env.HOST || '127.0.0.1';
const ALLOW_ANY_HOST = process.env.ALLOW_ANY_HOST === '1';
const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', ...(process.env.ALLOWED_HOSTS || '').split(',').map((s) => s.trim()).filter(Boolean)];
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const API = 'https://graph.threads.net';
const COLORS = ['#111111', '#2d5bd7', '#1f8a4c', '#c0352b', '#a86400', '#7a4fd1', '#0f766e'];
const GLOBAL_KEYS = new Set(['keep_awake', 'notify', 'auth_secret', 'active_project_id']);

const DEFAULTS = {
  dry_run: '1',
  slots_weekday: JSON.stringify(['08:30', '10:00', '12:30', '15:00', '19:00', '21:00']),
  slots_weekend: JSON.stringify(['10:00', '11:30', '14:00', '17:00', '20:00', '21:30']),
  min_gap_min: '3',
  max_late_hours: '6',
  keep_awake: '1',
  notify: '1',
  token: '', app_secret: '',
  token_expires_at: '0', token_refreshed_at: '0',
  user_id: '', username: '',
};

const db = new DatabaseSync(path.join(DATA_DIR, 'data.db'));
db.exec('PRAGMA journal_mode=WAL;');

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}
function colsOf(name) {
  return db.prepare(`PRAGMA table_info(${name})`).all().map((c) => c.name);
}

function migrate() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '#111111',
      note TEXT NOT NULL DEFAULT '',
      paused INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS globals(key TEXT PRIMARY KEY, value TEXT);
  `);

  let legacySettings = null;
  if (!tableExists('posts')) {
    db.exec(`
      CREATE TABLE posts(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        text TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        attempts INTEGER NOT NULL DEFAULT 0,
        threads_id TEXT, permalink TEXT, error TEXT,
        simulated INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL, published_at INTEGER
      );
      CREATE TABLE settings(
        project_id INTEGER NOT NULL,
        key TEXT NOT NULL,
        value TEXT,
        PRIMARY KEY(project_id, key)
      );
      CREATE TABLE log(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL,
        msg TEXT NOT NULL,
        post_id INTEGER,
        project_id INTEGER
      );
    `);
  } else {
    if (!colsOf('posts').includes('project_id')) db.exec('ALTER TABLE posts ADD COLUMN project_id INTEGER');
    if (!tableExists('log')) {
      db.exec(`CREATE TABLE log(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts INTEGER NOT NULL, level TEXT NOT NULL, msg TEXT NOT NULL,
        post_id INTEGER, project_id INTEGER
      )`);
    } else if (!colsOf('log').includes('project_id')) {
      db.exec('ALTER TABLE log ADD COLUMN project_id INTEGER');
    }
    if (!tableExists('settings')) {
      db.exec(`CREATE TABLE settings(
        project_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT,
        PRIMARY KEY(project_id, key)
      )`);
    } else if (!colsOf('settings').includes('project_id')) {
      legacySettings = db.prepare('SELECT key, value FROM settings').all();
      db.exec('ALTER TABLE settings RENAME TO settings_legacy');
      db.exec(`CREATE TABLE settings(
        project_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT,
        PRIMARY KEY(project_id, key)
      )`);
      db.exec('DROP TABLE settings_legacy');
    }
  }

  if (!db.prepare('SELECT id FROM projects LIMIT 1').get()) {
    db.prepare('INSERT INTO projects(name, color, note, paused, created_at) VALUES(?,?,?,0,?)')
      .run('Основной', '#111111', '', Date.now());
  }
  const firstId = db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get().id;
  db.prepare('UPDATE posts SET project_id=? WHERE project_id IS NULL').run(firstId);

  if (legacySettings) {
    const insG = db.prepare('INSERT INTO globals(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
    const insS = db.prepare('INSERT INTO settings(project_id,key,value) VALUES(?,?,?) ON CONFLICT(project_id,key) DO UPDATE SET value=excluded.value');
    for (const row of legacySettings) {
      if (GLOBAL_KEYS.has(row.key)) insG.run(row.key, row.value);
      else insS.run(firstId, row.key, row.value);
    }
  }
  db.exec('CREATE INDEX IF NOT EXISTS posts_proj ON posts(project_id, status, scheduled_at)');
}
migrate();

const getS = db.prepare('SELECT value FROM settings WHERE project_id=? AND key=?');
const setS = db.prepare('INSERT INTO settings(project_id,key,value) VALUES(?,?,?) ON CONFLICT(project_id,key) DO UPDATE SET value=excluded.value');
const pget = (pid, k) => getS.get(pid, k)?.value ?? DEFAULTS[k] ?? '';
const pset = (pid, k, v) => setS.run(pid, k, String(v));
const ggetS = db.prepare('SELECT value FROM globals WHERE key=?');
const gsetS = db.prepare('INSERT INTO globals(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
const gget = (k) => ggetS.get(k)?.value ?? DEFAULTS[k] ?? '';
const gset = (k, v) => gsetS.run(k, String(v));

const insLog = db.prepare('INSERT INTO log(ts,level,msg,post_id,project_id) VALUES(?,?,?,?,?)');
function log(level, msg, postId = null, projectId = null) {
  insLog.run(Date.now(), level, msg, postId, projectId);
  console.log(new Date().toISOString(), level.toUpperCase(), msg);
  db.exec('DELETE FROM log WHERE id < (SELECT MAX(id) - 2000 FROM log)');
  broadcast();
}

const clients = new Set();
let bTimer = null;
function broadcast() {
  if (bTimer) return;
  bTimer = setTimeout(() => {
    bTimer = null;
    for (const res of clients) res.write('event: update\ndata: 1\n\n');
  }, 150);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeColor = (c) => (COLORS.includes(c) ? c : '#111111');

async function call(url, method = 'GET', params = {}) {
  const u = new URL(url);
  const opts = { method, signal: AbortSignal.timeout(30000) };
  if (method === 'GET') for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  else opts.body = new URLSearchParams(params);
  const res = await fetch(u, opts);
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) {
    const e = new Error(j.error?.error_user_msg || j.error?.message || `HTTP ${res.status}`);
    e.code = j.error?.code;
    throw e;
  }
  return j;
}
const th = (pid, method, p, params = {}) => call(`${API}/v1.0/${p}`, method, { ...params, access_token: pget(pid, 'token') });

function assertAccountFree(userId, username, pid) {
  const other = db.prepare(`
    SELECT p.name AS name FROM projects p
    JOIN settings s ON s.project_id = p.id AND s.key = 'user_id' AND s.value = ?
    WHERE p.id != ?
  `).get(String(userId), pid);
  if (other) {
    throw bad(`Аккаунт @${username} уже подключён к проекту «${other.name}». Один аккаунт — один проект, иначе посты смешаются.`);
  }
}

async function fetchProfile(pid) {
  const me = await th(pid, 'GET', 'me', { fields: 'id,username' });
  pset(pid, 'user_id', me.id);
  pset(pid, 'username', me.username || '');
  return me;
}

async function refreshToken(pid) {
  const j = await call(`${API}/refresh_access_token`, 'GET', { grant_type: 'th_refresh_token', access_token: pget(pid, 'token') });
  pset(pid, 'token', j.access_token);
  pset(pid, 'token_refreshed_at', Date.now());
  if (j.expires_in) pset(pid, 'token_expires_at', Date.now() + j.expires_in * 1000);
  return j;
}

async function exchangeToken(pid) {
  const j = await call(`${API}/access_token`, 'GET', {
    grant_type: 'th_exchange_token', client_secret: pget(pid, 'app_secret'), access_token: pget(pid, 'token'),
  });
  pset(pid, 'token', j.access_token);
  pset(pid, 'token_refreshed_at', Date.now());
  if (j.expires_in) pset(pid, 'token_expires_at', Date.now() + j.expires_in * 1000);
  return j;
}

async function connectToken(pid, token, appSecret) {
  const proj = db.prepare('SELECT name FROM projects WHERE id=?').get(pid);
  if (!proj) throw bad('Проект не найден');
  const backup = ['token', 'user_id', 'username', 'app_secret', 'token_expires_at', 'token_refreshed_at']
    .reduce((a, k) => ({ ...a, [k]: pget(pid, k) }), {});
  const restore = () => { for (const [k, v] of Object.entries(backup)) pset(pid, k, v); };

  pset(pid, 'token', String(token).trim());
  if (appSecret !== undefined && String(appSecret).trim() !== '') pset(pid, 'app_secret', String(appSecret).trim());

  let me;
  try {
    me = await fetchProfile(pid);
    assertAccountFree(me.id, me.username || '', pid);
    if (backup.user_id && String(backup.user_id) !== String(me.id)) {
      const queued = db.prepare("SELECT COUNT(*) c FROM posts WHERE project_id=? AND status IN ('queued','failed','missed','publishing')").get(pid).c;
      if (queued) {
        throw bad(`В проекте «${proj.name}» ещё ${queued} постов для @${backup.username || 'прежнего аккаунта'}. Очистите очередь или создайте новый проект — иначе они уйдут в @${me.username}.`);
      }
    }
  } catch (e) {
    restore();
    throw e;
  }

  let kind = 'unknown';
  try { await refreshToken(pid); kind = 'long'; } catch {
    if (pget(pid, 'app_secret')) {
      try { await exchangeToken(pid); kind = 'long'; } catch (e) {
        log('warn', `Не удалось обменять на долгий токен: ${e.message}`, null, pid);
        kind = 'short';
      }
    } else {
      pset(pid, 'token_refreshed_at', Date.now());
      if (pget(pid, 'token_expires_at') === '0') pset(pid, 'token_expires_at', Date.now() + 60 * 86400e3);
    }
  }
  db.prepare('UPDATE projects SET paused=0 WHERE id=?').run(pid);
  log('ok', `Проект «${proj.name}»: подключён @${me.username}${kind === 'short' ? ' (короткий токен — сработает ~1 час)' : ''}`, null, pid);
  return me;
}

async function maybeRefreshToken(pid) {
  if (!pget(pid, 'token')) return;
  const refreshed = Number(pget(pid, 'token_refreshed_at'));
  const expires = Number(pget(pid, 'token_expires_at'));
  const now = Date.now();
  if (now - refreshed < 10 * 86400e3 && (!expires || expires - now > 20 * 86400e3)) return;
  if (now - refreshed < 86400e3) return;
  try { await refreshToken(pid); log('ok', 'Токен Threads продлён на 60 дней', null, pid); }
  catch (e) { pset(pid, 'token_refreshed_at', now - 9 * 86400e3); log('error', `Не удалось продлить токен: ${e.message}`, null, pid); }
}

async function assertSameAccount(pid, proj) {
  const me = await th(pid, 'GET', 'me', { fields: 'id,username' });
  const uid = pget(pid, 'user_id');
  if (uid && String(me.id) !== String(uid)) {
    db.prepare('UPDATE projects SET paused=1 WHERE id=?').run(pid);
    throw Object.assign(new Error(
      `Стоп: токен проекта «${proj.name}» сейчас от @${me.username}, а проект привязан к @${pget(pid, 'username')}. Посты не отправлены, проект на паузе.`,
    ), { accountMismatch: true });
  }
  if (!uid) {
    assertAccountFree(me.id, me.username || '', pid);
    pset(pid, 'user_id', me.id);
    pset(pid, 'username', me.username || '');
  }
  return me;
}

async function publishToThreads(pid, text) {
  const c = await th(pid, 'POST', 'me/threads', { media_type: 'TEXT', text });
  await sleep(4000);
  let pub;
  for (let i = 0; ; i++) {
    try { pub = await th(pid, 'POST', 'me/threads_publish', { creation_id: c.id }); break; }
    catch (e) { if (i >= 3) throw e; await sleep(10000); }
  }
  let permalink = null;
  try { permalink = (await th(pid, 'GET', pub.id, { fields: 'permalink' })).permalink || null; } catch {}
  return { id: pub.id, permalink };
}

function notify(title, body) {
  if (!IS_MAC || gget('notify') !== '1') return;
  const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\s+/g, ' ').slice(0, 180);
  execFile('osascript', ['-e', `display notification "${esc(body)}" with title "${esc(title)}" sound name "Glass"`], () => {});
}

let caff = null;
function updateCaffeinate() {
  const need = IS_MAC && gget('keep_awake') === '1' &&
    !!db.prepare("SELECT 1 FROM posts WHERE status='queued' AND scheduled_at < ? LIMIT 1").get(Date.now() + 24 * 3600e3);
  if (need && !caff) {
    caff = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore' });
    caff.on('exit', () => { caff = null; });
  } else if (!need && caff) { caff.kill(); caff = null; }
}

let busy = false;
const warnedNoToken = new Set();
const upd = {
  publishing: db.prepare("UPDATE posts SET status='publishing' WHERE id=?"),
  done: db.prepare("UPDATE posts SET status='published', threads_id=?, permalink=?, simulated=?, error=NULL, published_at=? WHERE id=?"),
  retry: db.prepare("UPDATE posts SET status='queued', attempts=?, error=?, scheduled_at=? WHERE id=?"),
  fail: db.prepare("UPDATE posts SET status='failed', attempts=?, error=? WHERE id=?"),
  back: db.prepare("UPDATE posts SET status='queued', error=? WHERE id=?"),
};

async function tickProject(proj) {
  const pid = proj.id;
  if (proj.paused) return;
  await maybeRefreshToken(pid);
  const now = Date.now();
  const maxLate = Number(pget(pid, 'max_late_hours')) * 3600e3;
  if (maxLate > 0) {
    const late = db.prepare("SELECT id FROM posts WHERE project_id=? AND status='queued' AND attempts=0 AND scheduled_at < ?").all(pid, now - maxLate);
    for (const r of late) {
      db.prepare("UPDATE posts SET status='missed', error=? WHERE id=?").run(
        `Компьютер был выключен или спал — пост опоздал больше чем на ${pget(pid, 'max_late_hours')} ч`, r.id,
      );
      log('warn', `Пост #${r.id} пропущен: опоздал больше чем на ${pget(pid, 'max_late_hours')} ч. Можно вернуть в очередь.`, r.id, pid);
    }
  }
  const last = db.prepare("SELECT MAX(published_at) m FROM posts WHERE project_id=? AND status='published'").get(pid).m || 0;
  if (now - last < Number(pget(pid, 'min_gap_min')) * 60e3) return;
  const p = db.prepare("SELECT * FROM posts WHERE project_id=? AND status='queued' AND scheduled_at<=? ORDER BY scheduled_at, id LIMIT 1").get(pid, now);
  if (!p) return;

  const dry = pget(pid, 'dry_run') === '1';
  if (!dry && !pget(pid, 'token')) {
    if (!warnedNoToken.has(pid)) log('warn', `Проект «${proj.name}»: боевой режим, но Threads не подключён — посты ждут.`, null, pid);
    warnedNoToken.add(pid);
    return;
  }
  warnedNoToken.delete(pid);

  upd.publishing.run(p.id);
  const who = dry ? 'тест, в Threads не уходит' : `@${pget(pid, 'username') || '?'}`;
  log('info', `Публикую пост #${p.id} · проект «${proj.name}» · ${who}`, p.id, pid);
  try {
    let r;
    if (dry) {
      await sleep(process.env.SELFTEST === '1' ? 30 : 1200);
      r = { id: null, permalink: null };
    } else {
      await assertSameAccount(pid, proj);
      r = await publishToThreads(pid, p.text);
    }
    upd.done.run(r.id, r.permalink, dry ? 1 : 0, Date.now(), p.id);
    log('ok', dry ? `Пост #${p.id} «опубликован» в тестовом режиме проекта «${proj.name}»` : `Пост #${p.id} опубликован в @${pget(pid, 'username')}`, p.id, pid);
    notify(dry ? 'Threads · тест' : 'Опубликовано в Threads', `${proj.name}: ${p.text}`);
  } catch (e) {
    if (e.accountMismatch) {
      upd.back.run(e.message, p.id);
      log('error', e.message, p.id, pid);
      notify('Threads: стоп', e.message);
      return;
    }
    const attempts = p.attempts + 1;
    if (attempts < 3) {
      upd.retry.run(attempts, e.message, Date.now() + 5 * 60e3, p.id);
      log('warn', `Пост #${p.id}: ошибка «${e.message}». Повтор через 5 минут (попытка ${attempts + 1} из 3).`, p.id, pid);
    } else {
      upd.fail.run(attempts, e.message, p.id);
      log('error', `Пост #${p.id} не опубликован: ${e.message}`, p.id, pid);
      notify('Threads: ошибка', `${proj.name} · пост #${p.id}: ${e.message}`);
    }
  }
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    const projects = db.prepare('SELECT * FROM projects ORDER BY id').all();
    for (const proj of projects) {
      try { await tickProject(proj); }
      catch (e) { log('error', `Планировщик «${proj.name}»: ${e.message}`, null, proj.id); }
    }
  } catch (e) {
    log('error', `Планировщик: ${e.message}`);
  } finally {
    busy = false;
    updateCaffeinate();
  }
}

function parseSlots(pid, key) {
  try { return JSON.parse(pget(pid, key)).filter((s) => /^\d{1,2}:\d{2}$/.test(s)).sort((a, b) => toMin(a) - toMin(b)); }
  catch { return []; }
}
const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + m; };

function nextFreeSlots(pid, n) {
  const wd = parseSlots(pid, 'slots_weekday');
  const we = parseSlots(pid, 'slots_weekend');
  if (!wd.length && !we.length) return [];
  const now = Date.now();
  const taken = db.prepare("SELECT scheduled_at t FROM posts WHERE project_id=? AND status IN ('queued','publishing','published') AND scheduled_at > ?")
    .all(pid, now - 86400e3).map((r) => r.t);
  const out = [];
  const day0 = new Date(); day0.setHours(0, 0, 0, 0);
  for (let d = 0; d < 400 && out.length < n; d++) {
    const date = new Date(day0); date.setDate(day0.getDate() + d);
    const dow = date.getDay();
    for (const s of (dow === 0 || dow === 6) ? we : wd) {
      const t = new Date(date); const m = toMin(s); t.setHours(Math.floor(m / 60), m % 60, 0, 0);
      const ts = t.getTime();
      if (ts < now + 60e3) continue;
      if ([...taken, ...out].some((x) => Math.abs(x - ts) < 20 * 60e3)) continue;
      out.push(ts);
      if (out.length >= n) break;
    }
  }
  return out;
}

const len = (s) => [...s].length;
const normText = (s) => String(s).trim().replace(/\s+/g, ' ').toLowerCase();

function findDupes(pid, texts) {
  const since = Date.now() - 30 * 86400e3;
  const rows = db.prepare(`
    SELECT p.text text, p.status status, pr.name name, pr.id pid
    FROM posts p JOIN projects pr ON pr.id = p.project_id
    WHERE p.status IN ('queued','publishing','failed','missed')
       OR (p.status='published' AND COALESCE(p.published_at, 0) > ?)
  `).all(since);
  const by = new Map();
  for (const r of rows) {
    const k = normText(r.text);
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r);
  }
  const dupes = [];
  const seen = new Map();
  for (const t of texts) {
    const k = normText(t);
    const hits = by.get(k) || [];
    const batch = seen.get(k) || 0;
    seen.set(k, batch + 1);
    const other = [...new Set(hits.filter((h) => h.pid !== pid).map((h) => h.name))];
    const same = hits.filter((h) => h.pid === pid).length;
    if (!other.length && !same && !batch) continue;
    dupes.push({
      preview: t.replace(/\s+/g, ' ').slice(0, 80),
      other,
      same,
      batch: batch > 0,
    });
  }
  return dupes;
}
function formatDupes(dupes) {
  const lines = dupes.map((d) => {
    const bits = [];
    if (d.batch) bits.push('повторяется в этой вставке');
    if (d.same) bits.push('уже есть в этом проекте');
    if (d.other.length) bits.push(`есть в ${d.other.map((n) => `«${n}»`).join(', ')}`);
    return `«${d.preview}» — ${bits.join(' и ')}`;
  });
  return `Похожий текст уже стоит в очереди:\n${lines.join('\n')}\nЕсли это осознанно (тот же текст в другой аккаунт) — подтвердите ещё раз.`;
}

function publicSettings(pid) {
  return {
    dry_run: pget(pid, 'dry_run') === '1',
    slots_weekday: parseSlots(pid, 'slots_weekday'),
    slots_weekend: parseSlots(pid, 'slots_weekend'),
    min_gap_min: Number(pget(pid, 'min_gap_min')),
    max_late_hours: Number(pget(pid, 'max_late_hours')),
    keep_awake: gget('keep_awake') === '1',
    is_mac: IS_MAC,
    auth: !!APP_PASSWORD,
    notify: gget('notify') === '1',
    connected: !!pget(pid, 'token'),
    has_app_secret: !!pget(pid, 'app_secret'),
    username: pget(pid, 'username'),
    token_expires_at: Number(pget(pid, 'token_expires_at') || 0),
  };
}

function listProjects() {
  return db.prepare('SELECT id, name, color, note, paused FROM projects ORDER BY id').all().map((p) => ({
    id: p.id,
    name: p.name,
    color: safeColor(p.color),
    note: p.note || '',
    paused: !!p.paused,
    queued: db.prepare("SELECT COUNT(*) c FROM posts WHERE project_id=? AND status='queued'").get(p.id).c,
    problems: db.prepare("SELECT COUNT(*) c FROM posts WHERE project_id=? AND status IN ('failed','missed')").get(p.id).c,
    username: pget(p.id, 'username'),
    connected: !!pget(p.id, 'token'),
    dry_run: pget(p.id, 'dry_run') === '1',
  }));
}

function resolveProject(id) {
  const n = Number(id);
  if (n) {
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(n);
    if (p) return p;
  }
  const active = Number(gget('active_project_id'));
  if (active) {
    const p = db.prepare('SELECT * FROM projects WHERE id=?').get(active);
    if (p) return p;
  }
  return db.prepare('SELECT * FROM projects ORDER BY id LIMIT 1').get();
}

function state(pid) {
  const proj = resolveProject(pid);
  const since = Date.now() - 14 * 86400e3;
  const posts = db.prepare(`SELECT id, text, scheduled_at, status, attempts, permalink, error, simulated, published_at
    FROM posts WHERE project_id=? AND (status IN ('queued','publishing','failed','missed') OR scheduled_at > ? OR published_at > ?)
    ORDER BY scheduled_at, id`).all(proj.id, since, since);
  const logRows = db.prepare(`SELECT id, ts, level, msg, post_id FROM log
    WHERE project_id=? OR project_id IS NULL ORDER BY id DESC LIMIT 150`).all(proj.id);
  return {
    now: Date.now(),
    project: { id: proj.id, name: proj.name, color: safeColor(proj.color), note: proj.note || '', paused: !!proj.paused },
    projects: listProjects(),
    colors: COLORS,
    settings: publicSettings(proj.id),
    posts, log: logRows, maxLen: MAX_LEN,
    installer: fs.existsSync(path.join(__dirname, 'ThreadsPoster-windows.zip')),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 2e6) { reject(new Error('Слишком большой запрос')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('Плохой JSON')); } });
    req.on('error', reject);
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });
const insPost = db.prepare('INSERT INTO posts(project_id, text, scheduled_at, status, created_at) VALUES(?,?,?,?,?)');

function projectIdFrom(req, url) {
  const h = Number(req.headers['x-project']);
  const q = Number(url.searchParams.get('project'));
  return (Number.isFinite(h) && h > 0 ? h : 0) || (Number.isFinite(q) && q > 0 ? q : 0) || 0;
}

function mustProject(req, url) {
  const p = resolveProject(projectIdFrom(req, url));
  if (!p) throw bad('Нет ни одного проекта');
  return p;
}

function createProject(b) {
  const name = String(b.name || '').trim().slice(0, 40);
  if (!name) throw bad('Введите название проекта');
  const count = db.prepare('SELECT COUNT(*) c FROM projects').get().c;
  const color = COLORS.includes(b.color) ? b.color : COLORS[count % COLORS.length];
  const note = String(b.note || '').trim().slice(0, 140);
  const info = db.prepare('INSERT INTO projects(name, color, note, paused, created_at) VALUES(?,?,?,0,?)').run(name, color, note, Date.now());
  const id = Number(info.lastInsertRowid);
  pset(id, 'dry_run', '1');
  gset('active_project_id', id);
  log('info', `Создан проект «${name}». Своя очередь, своё время, свой аккаунт — с остальными не смешивается.`, null, id);
  return { ok: true, id };
}

function updateProject(id, b) {
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
  if (!p) throw bad('Проект не найден');
  let { name, color, note, paused } = p;
  if (b.name !== undefined) {
    name = String(b.name).trim().slice(0, 40);
    if (!name) throw bad('Пустое название');
  }
  if (b.color !== undefined) {
    if (!COLORS.includes(b.color)) throw bad('Неверный цвет');
    color = b.color;
  }
  if (b.note !== undefined) note = String(b.note).trim().slice(0, 140);
  if (b.paused !== undefined) paused = b.paused ? 1 : 0;
  db.prepare('UPDATE projects SET name=?, color=?, note=?, paused=? WHERE id=?').run(name, color, note, paused, id);
  if (paused && !p.paused) log('warn', `Проект «${name}» на паузе — посты не публикуются`, null, id);
  else if (!paused && p.paused) log('ok', `Проект «${name}» снова публикует по своему расписанию`, null, id);
  else log('info', `Проект «${name}» обновлён`, null, id);
  return { ok: true };
}

function deleteProject(id) {
  const n = db.prepare('SELECT COUNT(*) c FROM projects').get().c;
  if (n <= 1) throw bad('Нельзя удалить единственный проект');
  const p = db.prepare('SELECT * FROM projects WHERE id=?').get(id);
  if (!p) throw bad('Проект не найден');
  const posts = db.prepare('SELECT COUNT(*) c FROM posts WHERE project_id=?').get(id).c;
  db.prepare('DELETE FROM posts WHERE project_id=?').run(id);
  db.prepare('DELETE FROM settings WHERE project_id=?').run(id);
  db.prepare('DELETE FROM log WHERE project_id=?').run(id);
  db.prepare('DELETE FROM projects WHERE id=?').run(id);
  const next = db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get().id;
  if (Number(gget('active_project_id')) === id) gset('active_project_id', next);
  log('warn', `Удалён проект «${p.name}» и его посты (${posts}). Остальные проекты не тронуты.`);
  return { ok: true, id: next };
}

function addPosts(pid, b) {
  const proj = db.prepare('SELECT name FROM projects WHERE id=?').get(pid);
  const texts = (Array.isArray(b.texts) ? b.texts : []).map((t) => String(t).trim()).filter(Boolean);
  if (!texts.length) throw bad('Нет текста постов');
  const tooLong = texts.findIndex((t) => len(t) > MAX_LEN);
  if (tooLong >= 0) throw bad(`Пост №${tooLong + 1} длиннее ${MAX_LEN} символов (${len(texts[tooLong])})`);
  const dupes = findDupes(pid, texts);
  if (dupes.length && !b.force) {
    const e = bad(formatDupes(dupes));
    e.status = 409;
    e.dupes = dupes;
    throw e;
  }
  let times;
  if (b.mode === 'slots') {
    times = nextFreeSlots(pid, texts.length);
    if (times.length < texts.length) throw bad('Не хватает слотов — проверьте расписание в настройках этого проекта');
  } else if (b.mode === 'at') {
    const start = Number(b.at); const step = Math.max(1, Number(b.stepMin) || 60) * 60e3;
    if (!start) throw bad('Укажите дату и время');
    times = texts.map((_, i) => start + i * step);
  } else if (b.mode === 'now') {
    const step = Number(pget(pid, 'min_gap_min')) * 60e3;
    times = texts.map((_, i) => Date.now() + i * step);
  } else throw bad('Неизвестный режим');
  const now = Date.now();
  texts.forEach((t, i) => insPost.run(pid, t, times[i], 'queued', now));
  log('info', `В проект «${proj.name}» добавлено постов: ${texts.length}`, null, pid);
  setTimeout(tick, 300);
  return { ok: true, count: texts.length };
}

function clearPosts(pid, scope) {
  const where = {
    queued: "status='queued'",
    problems: "status IN ('failed','missed')",
    unpublished: "status IN ('queued','failed','missed')",
  }[scope];
  if (!where) throw bad('Неизвестная очистка');
  const proj = db.prepare('SELECT name FROM projects WHERE id=?').get(pid);
  const r = db.prepare(`DELETE FROM posts WHERE project_id=? AND ${where}`).run(pid);
  log('warn', `Проект «${proj.name}»: очищено ${r.changes} (режим «${scope}»). Опубликованное не трогали. Другие проекты не трогали.`, null, pid);
  return { ok: true, deleted: r.changes };
}

function requeueProblems(pid) {
  const proj = db.prepare('SELECT name FROM projects WHERE id=?').get(pid);
  const rows = db.prepare("SELECT id FROM posts WHERE project_id=? AND status IN ('failed','missed') ORDER BY scheduled_at, id").all(pid);
  if (!rows.length) throw bad('Нет ошибок и пропусков');
  const times = nextFreeSlots(pid, rows.length);
  const gap = Number(pget(pid, 'min_gap_min')) * 60e3;
  const updOne = db.prepare("UPDATE posts SET status='queued', attempts=0, error=NULL, scheduled_at=? WHERE id=?");
  rows.forEach((row, i) => updOne.run(times[i] || (Date.now() + (i + 1) * gap), row.id));
  log('info', `Проект «${proj.name}»: ${rows.length} постов с ошибкой/пропуском возвращены в слоты`, null, pid);
  setTimeout(tick, 300);
  return { ok: true, count: rows.length };
}

function loadPost(id, pid) {
  const p = db.prepare('SELECT * FROM posts WHERE id=?').get(id);
  if (!p) throw bad('Пост не найден');
  if (p.project_id !== pid) throw bad('Этот пост из другого проекта');
  return p;
}

const routes = {
  state: (_b, proj) => state(proj.id),

  addPosts: (b, proj) => addPosts(proj.id, b),

  clear: (b, proj) => clearPosts(proj.id, b.scope),

  requeue: (_b, proj) => requeueProblems(proj.id),

  patchPost: (b, proj, id) => {
    const p = loadPost(id, proj.id);
    if (p.status === 'published' || p.status === 'publishing') throw bad('Опубликованный пост не редактируется');
    const text = b.text !== undefined ? String(b.text).trim() : p.text;
    if (!text) throw bad('Пустой текст');
    if (len(text) > MAX_LEN) throw bad(`Длиннее ${MAX_LEN} символов`);
    const at = b.scheduled_at !== undefined ? Number(b.scheduled_at) : p.scheduled_at;
    if (!at) throw bad('Неверное время');
    let dest = p.project_id;
    if (b.project_id !== undefined && Number(b.project_id) !== p.project_id) {
      const to = db.prepare('SELECT * FROM projects WHERE id=?').get(Number(b.project_id));
      if (!to) throw bad('Проект не найден');
      dest = to.id;
      log('info', `Пост #${id} перенесён из «${proj.name}» в «${to.name}». Опубликуется уже в аккаунт того проекта.`, id, to.id);
    }
    db.prepare("UPDATE posts SET text=?, scheduled_at=?, project_id=?, status='queued', attempts=0, error=NULL WHERE id=?").run(text, at, dest, id);
    if (dest === p.project_id) log('info', `Пост #${id} изменён`, id, proj.id);
    setTimeout(tick, 300);
    return { ok: true };
  },

  now: (_b, proj, id) => {
    loadPost(id, proj.id);
    const r = db.prepare("UPDATE posts SET scheduled_at=?, status='queued', attempts=0, error=NULL WHERE id=? AND project_id=? AND status NOT IN ('published','publishing')").run(Date.now(), id, proj.id);
    if (!r.changes) throw bad('Нельзя');
    log('info', `Пост #${id} поставлен на публикацию сейчас · «${proj.name}»`, id, proj.id);
    setTimeout(tick, 300);
    return { ok: true };
  },

  duplicate: (_b, proj, id) => {
    const p = loadPost(id, proj.id);
    const times = nextFreeSlots(proj.id, 1);
    const at = times[0] || (Date.now() + Number(pget(proj.id, 'min_gap_min')) * 60e3);
    insPost.run(proj.id, p.text, at, 'queued', Date.now());
    log('info', `Пост #${id} скопирован в очередь проекта «${proj.name}»`, null, proj.id);
    return { ok: true };
  },

  delPost: (_b, proj, id) => {
    loadPost(id, proj.id);
    const r = db.prepare("DELETE FROM posts WHERE id=? AND project_id=? AND status!='publishing'").run(id, proj.id);
    if (!r.changes) throw bad('Нельзя удалить');
    log('info', `Пост #${id} удалён из «${proj.name}»`, null, proj.id);
    return { ok: true };
  },

  settings: (b, proj) => {
    const pid = proj.id;
    if (b.dry_run !== undefined) {
      pset(pid, 'dry_run', b.dry_run ? '1' : '0');
      log(b.dry_run ? 'info' : 'ok', b.dry_run
        ? `«${proj.name}»: тестовый режим — в Threads ничего не уходит`
        : `«${proj.name}»: БОЕВОЙ режим — посты уходят только в @${pget(pid, 'username') || 'подключённый аккаунт'}`, null, pid);
    }
    for (const k of ['slots_weekday', 'slots_weekend']) {
      if (b[k] !== undefined) {
        const arr = (Array.isArray(b[k]) ? b[k] : String(b[k]).split(/[,\s]+/))
          .map((s) => String(s).trim()).filter(Boolean)
          .map((s) => { const m = s.match(/^(\d{1,2})[:.](\d{2})$/); if (!m || +m[1] > 23 || +m[2] > 59) throw bad(`Неверное время «${s}»`); return `${m[1].padStart(2, '0')}:${m[2]}`; });
        pset(pid, k, JSON.stringify([...new Set(arr)]));
      }
    }
    if (b.min_gap_min !== undefined) pset(pid, 'min_gap_min', Math.max(1, Math.min(240, Number(b.min_gap_min) || 3)));
    if (b.max_late_hours !== undefined) pset(pid, 'max_late_hours', Math.max(0, Math.min(72, Number(b.max_late_hours) || 0)));
    if (b.keep_awake !== undefined) gset('keep_awake', b.keep_awake ? '1' : '0');
    if (b.notify !== undefined) gset('notify', b.notify ? '1' : '0');
    updateCaffeinate();
    broadcast();
    return { ok: true };
  },

  token: async (b, proj) => {
    if (!b.token || String(b.token).trim().length < 20) throw bad('Вставьте токен целиком');
    try {
      const me = await connectToken(proj.id, String(b.token), b.app_secret);
      return { ok: true, username: me.username };
    } catch (e) {
      broadcast();
      if (e.status) throw e;
      throw bad(`Threads не принял токен: ${e.message}`);
    }
  },

  disconnect: (_b, proj) => {
    for (const k of ['token', 'username', 'user_id']) pset(proj.id, k, '');
    pset(proj.id, 'token_expires_at', 0);
    pset(proj.id, 'dry_run', '1');
    log('warn', `Threads отключён у проекта «${proj.name}». Другие проекты со своими токенами работают как раньше. Включён тестовый режим.`, null, proj.id);
    return { ok: true };
  },

  notify: () => { notify('Threads Poster', 'Уведомления работают'); return { ok: true }; },

  createProject: (b) => createProject(b),

  patchProject: (b, _proj, id) => updateProject(id, b),

  delProject: (_b, _proj, id) => deleteProject(id),

  active: (b) => {
    const p = db.prepare('SELECT id FROM projects WHERE id=?').get(Number(b.id));
    if (!p) throw bad('Проект не найден');
    gset('active_project_id', p.id);
    return { ok: true };
  },
};

function authSecret() {
  let v = gget('auth_secret');
  if (!v) { v = crypto.randomBytes(32).toString('hex'); gset('auth_secret', v); }
  return v;
}
const sign = (v) => crypto.createHmac('sha256', authSecret()).update(v).digest('hex');
function makeSession() { const exp = Date.now() + 30 * 86400e3; return `${exp}.${sign(String(exp))}`; }
function validSession(req) {
  const m = (req.headers.cookie || '').match(/(?:^|;\s*)tp_s=([^;]+)/);
  if (!m) return false;
  const [exp, sig] = m[1].split('.');
  if (!exp || !sig || Number(exp) < Date.now()) return false;
  const good = sign(exp);
  return sig.length === good.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good));
}
const loginFails = new Map();
const LOGIN_HTML = (err) => `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Threads Poster — вход</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f6f5f2;font:15px -apple-system,system-ui,sans-serif;color:#111}@media(prefers-color-scheme:dark){body{background:#0e0e0f;color:#f2f2f2}form{background:#18181a!important;border-color:#2a2a2e!important}input{background:#0e0e0f;color:#f2f2f2;border-color:#2a2a2e!important}}
form{background:#fff;border:1px solid #e6e3dc;border-radius:16px;padding:28px;width:min(340px,90vw);display:grid;gap:12px}h1{font-size:18px;margin:0 0 4px}input{font:inherit;padding:11px;border:1px solid #e6e3dc;border-radius:10px}button{font:inherit;font-weight:600;padding:11px;border:0;border-radius:10px;background:#111;color:#fff;cursor:pointer}.e{color:#c0352b;font-size:13px}</style></head>
<body><form method="post" action="/login"><h1>Threads Poster</h1>${err ? `<div class="e">${err}</div>` : ''}<input type="password" name="password" placeholder="Пароль" autofocus required><button>Войти</button></form></body></html>`;

async function handleLogin(req, res) {
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
  const f = loginFails.get(ip) || { n: 0, t: 0 };
  if (f.n >= 5 && Date.now() - f.t < 15 * 60e3) {
    res.writeHead(429, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_HTML('Слишком много попыток. Подождите 15 минут.'));
  }
  let body = '';
  for await (const c of req) { body += c; if (body.length > 4096) break; }
  const pw = new URLSearchParams(body).get('password') || '';
  const a = crypto.createHash('sha256').update(pw).digest(), b = crypto.createHash('sha256').update(APP_PASSWORD).digest();
  if (!crypto.timingSafeEqual(a, b)) {
    loginFails.set(ip, { n: f.n + 1, t: Date.now() });
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_HTML('Неверный пароль'));
  }
  loginFails.delete(ip);
  res.writeHead(303, { Location: '/', 'Set-Cookie': `tp_s=${makeSession()}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${30 * 86400}` });
  res.end();
}

function match(method, pathname) {
  if (method === 'GET' && pathname === '/api/state') return ['state'];
  if (method === 'POST' && pathname === '/api/posts') return ['addPosts'];
  if (method === 'POST' && pathname === '/api/posts/clear') return ['clear'];
  if (method === 'POST' && pathname === '/api/posts/requeue') return ['requeue'];
  if (method === 'POST' && pathname === '/api/settings') return ['settings'];
  if (method === 'POST' && pathname === '/api/token') return ['token'];
  if (method === 'POST' && pathname === '/api/token/disconnect') return ['disconnect'];
  if (method === 'POST' && pathname === '/api/test-notify') return ['notify'];
  if (method === 'POST' && pathname === '/api/projects') return ['createProject'];
  if (method === 'POST' && pathname === '/api/active') return ['active'];
  let m = pathname.match(/^\/api\/projects\/(\d+)$/);
  if (m && method === 'PATCH') return ['patchProject', Number(m[1])];
  if (m && method === 'DELETE') return ['delProject', Number(m[1])];
  m = pathname.match(/^\/api\/posts\/(\d+)(\/now|\/duplicate)?$/);
  if (m && method === 'PATCH' && !m[2]) return ['patchPost', Number(m[1])];
  if (m && method === 'DELETE' && !m[2]) return ['delPost', Number(m[1])];
  if (m && method === 'POST' && m[2] === '/now') return ['now', Number(m[1])];
  if (m && method === 'POST' && m[2] === '/duplicate') return ['duplicate', Number(m[1])];
  return null;
}

function seedDemo() {
  if (process.env.SEED_DEMO !== '1') return;
  if (db.prepare('SELECT COUNT(*) c FROM posts').get().c) return;
  if (db.prepare('SELECT COUNT(*) c FROM projects').get().c !== 1) return;
  if (pget(db.prepare('SELECT id FROM projects ORDER BY id LIMIT 1').get().id, 'token')) return;
  const a = db.prepare('SELECT * FROM projects ORDER BY id LIMIT 1').get();
  db.prepare('UPDATE projects SET name=?, color=?, note=? WHERE id=?').run(
    'Клиника', '#2d5bd7', 'Демо · свой аккаунт и своя очередь', a.id,
  );
  const info = db.prepare('INSERT INTO projects(name, color, note, paused, created_at) VALUES(?,?,?,0,?)').run(
    'Матрасы', '#1f8a4c', 'Демо · другой аккаунт, другие тексты', Date.now(),
  );
  const b = Number(info.lastInsertRowid);
  const clinic = [
    'Записаться к стоматологу страшно только до первого нормального врача. Потом жалеешь, что тянул.',
    'Зумер на приёме: «можно без боли, без лекции и чтобы я успел на созвон?» Можно. Для этого мы и здесь.',
    'Бесплатная консультация — это не «потом выставим счёт за воздух». Смотрим, говорим честно, решаете вы.',
  ];
  const mattress = [
    'Матрас за 40 тысяч и за 140 ощущаются одинаково первые 15 секунд в магазине. Разница — на третью неделю.',
    'Если просыпаетесь с затёкшей шеей, дело почти никогда не в подушке «не той стороной».',
    'Приезжайте полежать 10 минут. Не купите — хотя бы поймёте, какое вам жёстко.',
  ];
  const now = Date.now();
  const slotsA = nextFreeSlots(a.id, clinic.length);
  const slotsB = nextFreeSlots(b, mattress.length);
  clinic.forEach((t, i) => insPost.run(a.id, t, slotsA[i] || now + (i + 1) * 3600e3, 'queued', now));
  mattress.forEach((t, i) => insPost.run(b, t, slotsB[i] || now + (i + 1) * 3600e3, 'queued', now));
  const missedAt = now - 26 * 3600e3;
  const miss = insPost.run(a.id, 'Акция на гигиену — этот пост пример «пропущен», он не уйдёт в матрасы.', missedAt, 'queued', now);
  db.prepare("UPDATE posts SET status='missed', error=? WHERE id=?").run('Пример: компьютер спал, пост не ушёл в чужой аккаунт', Number(miss.lastInsertRowid));
  const pub = insPost.run(a.id, 'Открылись в субботу. Да, специально, чтобы не отпрашиваться с работы.', now - 3 * 3600e3, 'queued', now);
  db.prepare("UPDATE posts SET status='published', simulated=1, published_at=?, error=NULL WHERE id=?").run(now - 3 * 3600e3, Number(pub.lastInsertRowid));
  gset('active_project_id', a.id);
  log('info', 'Демо: два проекта с разными текстами. Переключите сверху — очереди не общие.', null, a.id);
}

seedDemo();

const server = http.createServer(async (req, res) => {
  if (!ALLOW_ANY_HOST) {
    const host = (req.headers.host || '').split(':')[0];
    if (!ALLOWED_HOSTS.includes(host)) { res.writeHead(403); return res.end(); }
  }
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (APP_PASSWORD) {
    if (url.pathname === '/login') {
      if (req.method === 'POST') return handleLogin(req, res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(LOGIN_HTML(''));
    }
    if (url.pathname === '/logout') {
      res.writeHead(303, { Location: '/login', 'Set-Cookie': 'tp_s=; Path=/; Max-Age=0' }); return res.end();
    }
    if (!validSession(req)) {
      if (url.pathname.startsWith('/api/')) return json(res, 401, { error: 'Нужно войти' });
      res.writeHead(303, { Location: '/login' }); return res.end();
    }
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    return fs.createReadStream(path.join(__dirname, 'public/index.html')).pipe(res);
  }
  if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/ThreadsPoster-windows.zip') {
    const file = path.join(__dirname, 'ThreadsPoster-windows.zip');
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
    const st = fs.statSync(file);
    res.writeHead(200, {
      'Content-Type': 'application/zip',
      'Content-Disposition': 'attachment; filename="ThreadsPoster-windows.zip"',
      'Content-Length': st.size,
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(file).pipe(res);
  }
  if (req.method === 'GET' && url.pathname === '/api/events') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (process.env.SELFTEST === '1' && req.method === 'POST' && url.pathname === '/api/selftest/tick') {
    await tick();
    return json(res, 200, { ok: true });
  }
  if (process.env.SELFTEST === '1' && req.method === 'POST' && url.pathname === '/api/selftest/claim') {
    try {
      const b = await readBody(req);
      const pid = Number(b.project_id);
      assertAccountFree(String(b.user_id), b.username || '', pid);
      pset(pid, 'user_id', String(b.user_id));
      pset(pid, 'username', b.username || '');
      pset(pid, 'token', 'x'.repeat(40));
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, e.status || 500, { error: e.message });
    }
  }

  if (!url.pathname.startsWith('/api/')) { res.writeHead(404); return res.end('Not found'); }
  if (req.method !== 'GET' && req.headers['x-app'] !== '1') return json(res, 403, { error: 'forbidden' });

  const hit = match(req.method, url.pathname);
  if (!hit) return json(res, 404, { error: 'Не найдено' });
  try {
    const body = req.method === 'GET' ? {} : await readBody(req);
    const proj = mustProject(req, url);
    const out = await routes[hit[0]](body, proj, hit[1]);
    json(res, 200, out);
  } catch (e) {
    json(res, e.status || 500, { error: e.message, dupes: e.dupes });
  }
});

const stuck = db.prepare("UPDATE posts SET status='queued' WHERE status='publishing'").run();
if (stuck.changes) log('warn', `Возвращено в очередь после перезапуска: ${stuck.changes}`);

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.error(`Порт ${PORT} занят — программа уже запущена`); process.exit(3); }
  throw e;
});
server.listen(PORT, LISTEN_HOST, () => {
  console.log(`Threads Poster: http://${LISTEN_HOST}:${PORT}  (данные: ${DATA_DIR})`);
  log('info', 'Программа запущена');
  setInterval(tick, 15000);
  setTimeout(tick, 1500);
});
