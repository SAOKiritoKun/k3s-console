'use strict';

const fs = require('fs');
const {
  HttpError,
  atomicWrite,
  validateConfig,
  maskSecrets,
  deepClone,
  isPlainObject
} = require('./util');

const DEFAULTS = {
  app: {
    title: 'k3s 集群管家',
    host: '127.0.0.1',
    port: 8964,
    accessToken: '',
    autoDetect: true,
    commandTimeoutMs: 60000,
    kubectlTimeoutSeconds: 25
  },
  ssh: {
    defaultUser: 'root',
    defaultPort: 22,
    connectTimeoutMs: 12000,
    hostKeyPolicy: 'accept-new',
    knownHostsPath: '',
    privateKeyPath: '',
    defaultKeyPaths: ['~/.ssh/id_ed25519', '~/.ssh/id_rsa'],
    useSudo: true
  },
  k3s: {
    channel: 'stable',
    installScriptUrl: 'https://get.k3s.io',
    mirror: 'cn',
    mirrorUrl: 'https://rancher-mirror.rancher.cn/k3s',
    offlineDir: '/opt/k3s-offline',
    clusterToken: '',
    apiPort: 6443,
    defaultFlags: [],
    registries: []
  }
};

function mergeDefaults(target, defaults) {
  const out = Array.isArray(defaults) ? [] : {};
  for (const key of Object.keys(defaults)) {
    const dv = defaults[key];
    const tv = target ? target[key] : undefined;
    if (isPlainObject(dv)) {
      out[key] = mergeDefaults(isPlainObject(tv) ? tv : {}, dv);
    } else if (Array.isArray(dv)) {
      out[key] = Array.isArray(tv) ? tv : deepClone(dv);
    } else {
      out[key] = tv === undefined ? dv : tv;
    }
  }
  if (isPlainObject(target)) {
    for (const key of Object.keys(target)) {
      if (!(key in out)) out[key] = target[key];
    }
  }
  return out;
}

class ConfigStore {
  constructor(file) {
    this.file = file;
    this.data = null;
    this.legacyHostsCache = [];
    this.hasLegacyHostsFlag = false;
    this.mtimeMs = 0;
    this.lastCheck = 0;
  }

  load() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        throw new HttpError(500, `找不到配置文件 ${this.file}，请参考 README 创建 config.json`);
      }
      throw new HttpError(500, `读取配置文件失败：${err.message}`);
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      throw new HttpError(500, `config.json 不是合法的 JSON：${err.message}`);
    }
    const errors = validateConfig(parsed);
    if (errors.length) {
      throw new HttpError(500, `config.json 校验失败：${errors.join('；')}`);
    }
    this.data = mergeDefaults(parsed, DEFAULTS);
    this.legacyHostsCache = Array.isArray(parsed.hosts) ? parsed.hosts : [];
    this.hasLegacyHostsFlag = Object.prototype.hasOwnProperty.call(parsed, 'hosts');
    delete this.data.hosts;
    try {
      this.mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch (_) {
      this.mtimeMs = 0;
    }
    this.lastCheck = Date.now();
    return this.data;
  }

  get() {
    if (!this.data) return this.load();
    if (Date.now() - this.lastCheck > 2000) {
      this.lastCheck = Date.now();
      try {
        const stat = fs.statSync(this.file);
        if (stat.mtimeMs !== this.mtimeMs) {
          // 配置文件被外部修改，自动重新加载；若新内容非法，继续使用上一次有效配置
          try {
            this.load();
          } catch (err) {
            console.error(`[config] 热加载失败，继续使用旧配置：${err.message}`);
          }
        }
      } catch (_) { /* 忽略读取失败，保持内存配置 */ }
    }
    return this.data;
  }

  getRaw() {
    return this.get();
  }

  save(next) {
    const clean = deepClone(next);
    delete clean.hosts;
    delete clean.kubeadm;
    const errors = validateConfig(clean);
    if (errors.length) throw new HttpError(400, `配置校验失败：${errors.join('；')}`);
    const merged = mergeDefaults(clean, DEFAULTS);
    delete merged.hosts;
    atomicWrite(this.file, JSON.stringify(merged, null, 2) + '\n');
    this.load();
    return this.data;
  }

  publicConfig() {
    return maskSecrets(deepClone(this.get()));
  }

  legacyHosts() {
    return deepClone(this.legacyHostsCache || []);
  }

  hasLegacyHosts() {
    return !!this.hasLegacyHostsFlag;
  }

  dropLegacyHosts() {
    if (!this.hasLegacyHostsFlag) return false;
    const next = deepClone(this.get());
    delete next.hosts;
    this.save(next);
    return true;
  }

  get app() {
    return this.get().app || {};
  }

  get title() {
    return this.app.title || 'k3s 集群管家';
  }
}

module.exports = { ConfigStore, DEFAULTS };
