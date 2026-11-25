'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const MASK = '__UNCHANGED__';

class HttpError extends Error {
  constructor(status, message, detail) {
    super(message);
    this.name = 'HttpError';
    this.status = status || 500;
    this.detail = detail || null;
  }
}

function sendJson(res, status, payload) {
  if (!res || res.writableEnded || res.destroyed) return false;
  const body = Buffer.from(JSON.stringify(payload));
  try {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff'
    });
    res.end(body);
    return true;
  } catch (_) {
    try { res.destroy(); } catch (_) { /* ignore */ }
    return false;
  }
}

function readBody(req, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    let finished = false;
    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
      req.off('close', onClose);
    };
    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (err) reject(err);
      else resolve(value);
    };
    const failLimit = () => {
      if (settled) return;
      const label = limit >= 1024 * 1024
        ? `${Math.round((limit / 1024 / 1024) * 10) / 10}MB`
        : `${Math.max(1, Math.round(limit / 1024))}KB`;
      finish(new HttpError(413, `请求内容超过限制（${label}）`));
      // 不再把超限内容留在内存里；继续读完请求，让调用方可以正常返回 413。
      try {
        req.on('error', () => { /* 丢弃超限请求体的后续错误 */ });
        req.resume();
      } catch (_) { /* ignore */ }
    };
    const onData = (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        failLimit();
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      finished = true;
      finish(null, Buffer.concat(chunks).toString('utf8'));
    };
    const onError = (err) => finish(err);
    const onAborted = () => finish(new HttpError(400, '请求已中断'));
    const onClose = () => {
      if (!finished) finish(new HttpError(400, '请求已中断'));
    };
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
    req.on('aborted', onAborted);
    req.on('close', onClose);
  });
}

async function readJson(req, limit) {
  const raw = await readBody(req, limit);
  if (!raw.trim()) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new HttpError(400, '请求 JSON 格式不正确');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, '请求 JSON 必须是对象');
  }
  return parsed;
}

function sq(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

function b64(value) {
  return Buffer.from(String(value), 'utf8').toString('base64');
}

function unb64(value) {
  return Buffer.from(String(value), 'base64').toString('utf8');
}

function scriptCommand(script) {
  return `printf %s ${sq(b64(script))} | base64 -d | sh`;
}

function parseSections(text, prefix = '@@') {
  const sections = {};
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (line.startsWith(prefix)) {
      let key = line.slice(prefix.length);
      if (key.endsWith(prefix)) key = key.slice(0, -prefix.length);
      current = key.trim();
      sections[current] = [];
    } else if (current) {
      sections[current].push(line);
    }
  }
  const out = {};
  for (const key of Object.keys(sections)) out[key] = sections[key].join('\n').trim();
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
  return p;
}

function atomicWrite(file, content) {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tmp, content, 'utf8');
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw err;
  }
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch (_) { /* ignore */ }
    throw err;
  }
}

function maskSecrets(config) {
  const copy = deepClone(config);
  if (copy.app && copy.app.accessToken) copy.app.accessToken = MASK;
  if (copy.k3s && copy.k3s.clusterToken) copy.k3s.clusterToken = MASK;
  for (const host of copy.hosts || []) {
    if (host.auth) {
      if (host.auth.password) host.auth.password = MASK;
      if (host.auth.passphrase) host.auth.passphrase = MASK;
      if (host.auth.privateKey) host.auth.privateKey = MASK;
    }
    if (host.k3s && host.k3s.token) host.k3s.token = MASK;
  }
  return copy;
}

function restoreSecrets(next, prev) {
  if (!next || typeof next !== 'object') return next;
  const prevApp = (prev && prev.app) || {};
  if (next.app && next.app.accessToken === MASK) next.app.accessToken = prevApp.accessToken || '';
  if (next.k3s && next.k3s.clusterToken === MASK) {
    next.k3s.clusterToken = (prev && prev.k3s && prev.k3s.clusterToken) || '';
  }

  const prevHosts = new Map();
  for (const host of (prev && prev.hosts) || []) {
    if (host && host.id) prevHosts.set(host.id, host);
  }
  for (const host of next.hosts || []) {
    const old = prevHosts.get(host.id);
    if (!host.auth) host.auth = {};
    if (host.auth.password === MASK) host.auth.password = (old && old.auth && old.auth.password) || '';
    if (host.auth.passphrase === MASK) host.auth.passphrase = (old && old.auth && old.auth.passphrase) || '';
    if (host.auth.privateKey === MASK) host.auth.privateKey = (old && old.auth && old.auth.privateKey) || '';
    if (host.k3s && host.k3s.token === MASK) host.k3s.token = (old && old.k3s && old.k3s.token) || '';
  }
  return next;
}

function validateHosts(hosts, label = 'hosts') {
  const errors = [];
  if (!Array.isArray(hosts)) return [`${label} 必须是数组`];
  const ids = new Set();
  for (const [index, host] of hosts.entries()) {
    const itemLabel = `${label}[${index}]`;
    if (!isPlainObject(host)) { errors.push(`${itemLabel} 必须是对象`); continue; }
    if (!host.id) errors.push(`${itemLabel}.id 不能为空`);
    else if (ids.has(host.id)) errors.push(`${label} 中存在重复 id：${host.id}`);
    else ids.add(host.id);
    const transport = host.transport || 'ssh';
    if (!['ssh', 'local', 'kubeconfig'].includes(transport)) {
      errors.push(`${itemLabel}.transport 只能是 ssh / local / kubeconfig`);
    }
    if (!host.name) errors.push(`${itemLabel}.name 不能为空`);
    if (transport === 'ssh' && !host.host) errors.push(`${itemLabel}.host 不能为空`);
    if (transport === 'kubeconfig' && !host.kubeconfig) errors.push(`${itemLabel}.kubeconfig 不能为空`);
    if (host.port !== undefined && host.port !== '' && (!Number.isInteger(Number(host.port)) || Number(host.port) < 1 || Number(host.port) > 65535)) {
      errors.push(`${itemLabel}.port 不是合法端口`);
    }
  }
  return errors;
}

function validateConfig(config) {
  const errors = [];
  if (!isPlainObject(config)) return ['配置文件根节点必须是对象'];
  if (config.hosts !== undefined) errors.push(...validateHosts(config.hosts));
  const app = config.app || {};
  if (app.port !== undefined && (!Number.isInteger(Number(app.port)) || Number(app.port) < 1 || Number(app.port) > 65535)) {
    errors.push('app.port 不是合法端口');
  }
  const k3s = config.k3s || {};
  if (k3s.mirror !== undefined && typeof k3s.mirror !== 'string') {
    errors.push('k3s.mirror 必须是字符串（例如 "cn" 或 ""）');
  }
  if (k3s.mirrorUrl !== undefined && typeof k3s.mirrorUrl !== 'string') {
    errors.push('k3s.mirrorUrl 必须是字符串');
  }
  return errors;
}

function formatError(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  const parts = [];
  if (err.message) parts.push(err.message);
  if (err.detail) parts.push(String(err.detail));
  if (!parts.length) parts.push(String(err));
  return parts.join(' | ');
}

function safeId(input) {
  const base = String(input || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return base || 'host-' + crypto.randomBytes(3).toString('hex');
}

function formatBytesText(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

function truncate(text, max = 12000) {
  const str = String(text || '');
  if (str.length <= max) return str;
  return str.slice(0, max) + `\n…（输出已截断，共 ${str.length} 字符）`;
}

function relativeAge(iso) {
  if (!iso) return '-';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return '-';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return `${Math.floor(d / 30)}mo`;
}

// 进度推送节流：百分比变了才推，且两次至少隔 intervalMs（100% 立即推，避免收尾丢最后一帧）。
// 传 null / NaN 表示“总量未知”，此时只按时间节流。
function createProgressThrottle(intervalMs = 250) {
  let lastAt = 0;
  let lastPct = null;
  return {
    tick(pct, now = Date.now()) {
      const value = Number.isFinite(pct) ? Math.max(0, Math.min(100, Math.round(pct))) : null;
      if (value === 100) {
        lastAt = now;
        lastPct = value;
        return true;
      }
      if (value !== null && value === lastPct) return false;
      if (now - lastAt < intervalMs) return false;
      lastAt = now;
      lastPct = value;
      return true;
    }
  };
}

module.exports = {
  MASK,
  HttpError,
  sendJson,
  readBody,
  readJson,
  sq,
  b64,
  unb64,
  scriptCommand,
  parseSections,
  sleep,
  deepClone,
  isPlainObject,
  expandHome,
  atomicWrite,
  maskSecrets,
  restoreSecrets,
  validateHosts,
  validateConfig,
  formatError,
  safeId,
  truncate,
  formatBytesText,
  relativeAge,
  createProgressThrottle
};
