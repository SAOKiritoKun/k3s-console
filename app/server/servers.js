'use strict';

const fs = require('fs');
const {
  HttpError,
  atomicWrite,
  deepClone,
  isPlainObject,
  maskSecrets,
  restoreSecrets,
  validateHosts
} = require('./util');

// 内置分组：始终存在、不可删除。所有服务器都必须挂在某个分组下，
// 有了这个兜底分组，就可以保证「分组列表永远不会为空」这一不变式。
const DEFAULT_GROUP = '默认分组';
const GROUP_NAME_MAX = 40;

const HOST_DEFAULTS = {
  transport: 'ssh',
  role: 'auto',
  group: DEFAULT_GROUP,
  port: 22,
  user: 'root',
  auth: { type: 'password' },
  k3s: {}
};

function normalizeGroupName(value) {
  return String(value === undefined || value === null ? '' : value).trim().replace(/\s+/g, ' ');
}

function normalizeHost(host) {
  const value = isPlainObject(host) ? host : {};
  const group = normalizeGroupName(value.group) || DEFAULT_GROUP;
  return {
    ...HOST_DEFAULTS,
    ...value,
    group,
    auth: { type: 'password', ...(isPlainObject(value.auth) ? value.auth : {}) },
    k3s: { ...(isPlainObject(value.k3s) ? value.k3s : {}) }
  };
}

class ServerStore {
  constructor(file) {
    this.file = file;
    this.items = [];
    this.groups = [DEFAULT_GROUP];
    this.exists = false;
    this.loaded = false;
    this.mtimeMs = 0;
    this.lastCheck = 0;
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') {
        throw new HttpError(500, `读取服务器数据失败：${err.message}`);
      }
      this.items = [];
      this.groups = [DEFAULT_GROUP];
      this.exists = false;
      this.loaded = true;
      this.mtimeMs = 0;
      this.lastCheck = Date.now();
      return false;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new HttpError(500, `data/server.json 不是合法的 JSON：${err.message}`);
    }

    let servers;
    let storedGroups = [];
    if (Array.isArray(parsed)) {
      servers = parsed;
    } else if (isPlainObject(parsed) && Array.isArray(parsed.servers)) {
      servers = parsed.servers;
      if (Array.isArray(parsed.groups)) storedGroups = parsed.groups;
    } else if (isPlainObject(parsed) && Array.isArray(parsed.hosts)) {
      servers = parsed.hosts;
      if (Array.isArray(parsed.groups)) storedGroups = parsed.groups;
    } else {
      throw new HttpError(500, 'data/server.json 必须是服务器数组，或包含 servers 数组的对象');
    }

    const errors = validateHosts(servers, 'servers');
    if (errors.length) throw new HttpError(500, `data/server.json 校验失败：${errors.join('；')}`);

    // 旧数据可能没有 groups 字段，或者服务器用的是文件里没登记的分组名。
    // 统一按「默认分组 + 文件里登记的 + 服务器实际使用的」重建，保证不漏组。
    const ordered = [];
    const seen = new Set();
    const push = (name) => {
      const key = normalizeGroupName(name);
      if (!key || seen.has(key)) return;
      seen.add(key);
      ordered.push(key);
    };
    push(DEFAULT_GROUP);
    for (const name of storedGroups) push(name);
    const normalized = servers.map(normalizeHost);
    for (const host of normalized) push(host.group);

    this.groups = ordered;
    this.items = normalized;
    this.exists = true;
    this.loaded = true;
    try {
      this.mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch (_) {
      this.mtimeMs = 0;
    }
    this.lastCheck = Date.now();
    return true;
  }

  get() {
    if (!this.loaded) this.load();
    if (Date.now() - this.lastCheck > 2000) {
      this.lastCheck = Date.now();
      try {
        const stat = fs.statSync(this.file);
        if (stat.mtimeMs !== this.mtimeMs) {
          try {
            this.load();
          } catch (err) {
            console.error(`[servers] 热加载失败，继续使用内存数据：${err.message}`);
          }
        }
      } catch (_) { /* 保持内存数据 */ }
    }
    return this.items;
  }

  all() {
    return this.get();
  }

  count() {
    return this.get().length;
  }

  has(id) {
    return this.get().some((host) => host.id === id);
  }

  host(id) {
    const host = this.get().find((item) => item.id === id);
    if (!host) throw new HttpError(404, `找不到主机：${id}`);
    return host;
  }

  publicList() {
    return maskSecrets({ hosts: deepClone(this.get()) }).hosts;
  }

  /* ---------------- 分组 ---------------- */

  listGroups() {
    this.get();
    return this.groups.slice();
  }

  groupCounts() {
    const counts = new Map();
    for (const name of this.listGroups()) counts.set(name, 0);
    for (const host of this.get()) {
      const key = normalizeGroupName(host.group) || DEFAULT_GROUP;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return counts;
  }

  hasGroup(name) {
    const key = normalizeGroupName(name);
    return !!key && this.listGroups().includes(key);
  }

  hostsInGroup(name) {
    const key = normalizeGroupName(name);
    return this.get().filter((host) => (normalizeGroupName(host.group) || DEFAULT_GROUP) === key);
  }

  addGroup(name) {
    const key = normalizeGroupName(name);
    if (!key) throw new HttpError(400, '分组名称不能为空');
    if (key.length > GROUP_NAME_MAX) throw new HttpError(400, `分组名称不能超过 ${GROUP_NAME_MAX} 个字符`);
    if (/[\\/]/.test(key)) throw new HttpError(400, '分组名称不能包含斜杠');
    this.get();
    if (this.groups.includes(key)) throw new HttpError(409, `分组已存在：${key}`);
    this.groups = [...this.groups, key];
    this.persist();
    return key;
  }

  removeGroup(name) {
    const key = normalizeGroupName(name);
    if (!key) throw new HttpError(400, '分组名称不能为空');
    this.get();
    if (!this.groups.includes(key)) throw new HttpError(404, `找不到分组：${key}`);
    if (key === DEFAULT_GROUP) {
      throw new HttpError(400, `${DEFAULT_GROUP}是内置分组，不能删除；服务器必须始终挂在一个分组下`);
    }
    const removed = this.hostsInGroup(key).map((host) => ({ id: host.id, name: host.name }));
    this.groups = this.groups.filter((item) => item !== key);
    this.items = this.get().filter((host) => (normalizeGroupName(host.group) || DEFAULT_GROUP) !== key);
    this.persist();
    return { removed };
  }

  renameGroup(from, to) {
    const oldKey = normalizeGroupName(from);
    const newKey = normalizeGroupName(to);
    if (!oldKey) throw new HttpError(400, '原分组名称不能为空');
    if (!newKey) throw new HttpError(400, '新分组名称不能为空');
    if (newKey.length > GROUP_NAME_MAX) throw new HttpError(400, `分组名称不能超过 ${GROUP_NAME_MAX} 个字符`);
    this.get();
    if (!this.groups.includes(oldKey)) throw new HttpError(404, `找不到分组：${oldKey}`);
    if (oldKey === newKey) return newKey;
    if (oldKey === DEFAULT_GROUP) throw new HttpError(400, `${DEFAULT_GROUP}是内置分组，不能重命名`);
    if (this.groups.includes(newKey)) throw new HttpError(409, `分组已存在：${newKey}`);
    this.groups = this.groups.map((item) => (item === oldKey ? newKey : item));
    this.items = this.get().map((host) => (
      (normalizeGroupName(host.group) || DEFAULT_GROUP) === oldKey ? { ...host, group: newKey } : host
    ));
    this.persist();
    return newKey;
  }

  /* ---------------- 持久化 ---------------- */

  persist() {
    const normalized = this.items.map(normalizeHost);
    const errors = validateHosts(normalized, 'servers');
    if (errors.length) throw new HttpError(400, `服务器数据校验失败：${errors.join('；')}`);
    const groups = this.groups.length ? this.groups.slice() : [DEFAULT_GROUP];
    if (!groups.includes(DEFAULT_GROUP)) groups.unshift(DEFAULT_GROUP);
    atomicWrite(this.file, JSON.stringify({ groups, servers: normalized }, null, 2) + '\n');
    this.load();
    return this.items;
  }

  save(servers) {
    const list = Array.isArray(servers) ? servers : [];
    const normalized = list.map(normalizeHost);
    const errors = validateHosts(normalized, 'servers');
    if (errors.length) throw new HttpError(400, `服务器数据校验失败：${errors.join('；')}`);
    // 保存服务器时补登记它们用到的分组，避免出现「服务器挂在不存在的分组下」
    const groups = [DEFAULT_GROUP];
    for (const item of this.groups) {
      if (item && !groups.includes(item)) groups.push(item);
    }
    for (const host of normalized) {
      if (host.group && !groups.includes(host.group)) groups.push(host.group);
    }
    atomicWrite(this.file, JSON.stringify({ groups, servers: normalized }, null, 2) + '\n');
    this.load();
    return this.items;
  }

  add(host) {
    const next = normalizeHost(host);
    if (!next.id) throw new HttpError(400, '服务器 id 不能为空');
    if (this.has(next.id)) throw new HttpError(409, `主机 id 已存在：${next.id}`);
    this.get();
    if (!this.groups.includes(next.group)) throw new HttpError(400, `分组不存在：${next.group}`);
    const list = deepClone(this.get());
    list.push(next);
    this.save(list);
    return this.host(next.id);
  }

  update(id, patch) {
    const current = this.host(id);
    const source = isPlainObject(patch) ? patch : {};
    const merged = { ...current, ...source, id };
    if (isPlainObject(source.auth)) merged.auth = { ...(current.auth || {}), ...source.auth };
    if (isPlainObject(source.k3s)) merged.k3s = { ...(current.k3s || {}), ...source.k3s };
    if (source.group !== undefined) {
      const key = normalizeGroupName(source.group) || DEFAULT_GROUP;
      if (!this.hasGroup(key)) throw new HttpError(400, `分组不存在：${key}`);
      merged.group = key;
    }
    const restored = restoreSecrets({ hosts: [merged] }, { hosts: [current] }).hosts[0];
    const list = this.get().map((host) => (host.id === id ? normalizeHost(restored) : host));
    this.save(list);
    return this.host(id);
  }

  remove(id) {
    const list = this.get();
    if (!list.some((host) => host.id === id)) throw new HttpError(404, `找不到主机：${id}`);
    this.save(list.filter((host) => host.id !== id));
    return true;
  }

  // 只移动分组，不动其它连接信息；也不清 detect 缓存，避免整列表闪成「读取中」
  moveToGroup(id, name) {
    const host = this.host(id);
    const key = normalizeGroupName(name) || DEFAULT_GROUP;
    if (!this.hasGroup(key)) throw new HttpError(400, `分组不存在：${key}。请先新增分组`);
    if ((normalizeGroupName(host.group) || DEFAULT_GROUP) === key) return host;
    this.items = this.get().map((item) => (item.id === id ? { ...item, group: key } : item));
    this.persist();
    return this.host(id);
  }
}

module.exports = { ServerStore, normalizeHost, normalizeGroupName, HOST_DEFAULTS, DEFAULT_GROUP, GROUP_NAME_MAX };
