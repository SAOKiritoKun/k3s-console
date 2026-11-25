'use strict';

const fs = require('fs');
const path = require('path');
const { HttpError, atomicWrite, isPlainObject } = require('./util');

const DEFAULT_REPOSITORY = 'docker.io';
const DEFAULT_FILE = Object.freeze({
  repository: DEFAULT_REPOSITORY,
  username: '',
  password: '',
  updatedAt: ''
});

function normalizeRepository(value) {
  let repository = String(value || '').trim();
  if (!repository) return DEFAULT_REPOSITORY;
  repository = repository.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (repository.length > 253) throw new HttpError(400, '镜像仓库地址过长');
  if (!/^[A-Za-z0-9.-]+(?::\d{1,5})?(?:\/[A-Za-z0-9._-]+)*$/.test(repository)) {
    throw new HttpError(400, '镜像仓库地址格式不正确，应为 host 或 host:port，可带路径前缀');
  }
  if (repository.split('/').some((part) => part === '.' || part === '..')) {
    throw new HttpError(400, '镜像仓库地址不能包含 . 或 .. 路径');
  }
  return repository;
}

class ImageRepositoryStore {
  constructor(file) {
    this.file = file;
    this.data = { ...DEFAULT_FILE };
  }

  load() {
    let missing = false;
    try {
      const raw = fs.readFileSync(this.file, 'utf8');
      if (!raw.replace(/^\uFEFF/, '').trim()) {
        this.data = { ...DEFAULT_FILE };
        this.persist();
        return this.data;
      }
      const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
      this.data = this.normalize(parsed);
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        missing = true;
      } else {
        console.error(`[data] 读取 ${path.basename(this.file)} 失败，使用默认公共仓库：${err.message}`);
      }
      this.data = { ...DEFAULT_FILE };
    }
    if (missing) this.persist();
    return this.data;
  }

  persist() {
    atomicWrite(this.file, JSON.stringify(this.data, null, 2) + '\n');
  }

  normalize(value) {
    const source = isPlainObject(value) ? value : {};
    return {
      repository: normalizeRepository(source.repository),
      username: String(source.username || '').trim().slice(0, 256),
      password: String(source.password || '').slice(0, 1024),
      updatedAt: String(source.updatedAt || '')
    };
  }

  get() {
    return { ...this.data };
  }

  publicConfig() {
    const data = this.get();
    return {
      repository: data.repository || DEFAULT_REPOSITORY,
      username: data.username,
      hasPassword: !!data.password,
      updatedAt: data.updatedAt,
      isDefault: (data.repository || DEFAULT_REPOSITORY) === DEFAULT_REPOSITORY && !data.username && !data.password
    };
  }

  save(input) {
    const current = this.get();
    const inputObj = isPlainObject(input) ? input : {};
    const nextUsername = String(inputObj.username !== undefined ? inputObj.username : current.username || '').trim();
    if (nextUsername && nextUsername !== current.username && !inputObj.password) {
      throw new HttpError(400, '修改用户名时请重新填写密码或 Token');
    }
    const next = this.normalize({ ...current, ...inputObj });
    if (inputObj.password === undefined) next.password = current.password;
    next.repository = normalizeRepository(next.repository);
    if (!next.username) next.password = '';
    if (next.username && !next.password) throw new HttpError(400, '填写用户名时请同时填写密码或 Token');
    if (!next.username && next.password) throw new HttpError(400, '填写密码或 Token 时请同时填写用户名');
    next.updatedAt = new Date().toISOString();
    this.data = next;
    atomicWrite(this.file, JSON.stringify(next, null, 2) + '\n');
    return this.publicConfig();
  }

  resolve(image) {
    const ref = String(image || '').trim();
    if (!ref) return '';
    const first = ref.split('/')[0];
    const hasRegistry = ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
    if (hasRegistry) return ref;
    const repository = this.data.repository || DEFAULT_REPOSITORY;
    const rest = ref.replace(/^library\//, '');
    if (repository === DEFAULT_REPOSITORY) {
      if (rest.includes('/')) return `docker.io/${rest}`;
      return `docker.io/library/${rest}`;
    }
    return `${repository.replace(/\/+$/, '')}/${rest}`;
  }

  credentials() {
    return this.data.username ? { username: this.data.username, password: this.data.password } : null;
  }
}

module.exports = { ImageRepositoryStore, normalizeRepository, DEFAULT_REPOSITORY };
