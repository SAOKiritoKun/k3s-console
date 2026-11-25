'use strict';

const fs = require('fs');
const path = require('path');
const { HttpError, atomicWrite } = require('./util');

function templateLabel(filename) {
  return String(filename || '').replace(/\.ya?ml$/i, '');
}

class TemplateStore {
  constructor(dir) {
    this.dir = dir;
  }

  ensureDir() {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  fileName(name) {
    let base = String(name || '').trim();
    if (!base) throw new HttpError(400, '模板名称不能为空');
    if (!/\.ya?ml$/i.test(base)) base += '.yaml';
    base = base
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[. ]+/, '');
    if (!base || !/\.ya?ml$/i.test(base) || /^\.ya?ml$/i.test(base)) {
      throw new HttpError(400, '模板名称不合法');
    }
    if ([...base].length > 160) throw new HttpError(400, '模板名称过长');
    return base;
  }

  filePath(id) {
    const name = String(id || '');
    if (!name || name !== path.basename(name) || !/\.ya?ml$/i.test(name)) {
      throw new HttpError(400, '模板 id 不合法');
    }
    const full = path.resolve(this.dir, name);
    const rel = path.relative(this.dir, full);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.includes(path.sep)) {
      throw new HttpError(400, '模板 id 不合法');
    }
    return full;
  }

  list() {
    this.ensureDir();
    const files = fs.readdirSync(this.dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.ya?ml$/i.test(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => templateLabel(a).localeCompare(templateLabel(b), 'zh-CN'));
    const templates = [];
    for (const id of files) {
      try {
        templates.push({
          id,
          name: templateLabel(id),
          yaml: fs.readFileSync(path.join(this.dir, id), 'utf8')
        });
      } catch (_) { /* 跳过读取失败的文件 */ }
    }
    return templates;
  }

  get(id) {
    const full = this.filePath(id);
    let yaml;
    try {
      yaml = fs.readFileSync(full, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') throw new HttpError(404, `模板不存在：${templateLabel(id)}`);
      throw new HttpError(500, `读取模板失败：${err.message}`);
    }
    return { id: path.basename(full), name: templateLabel(path.basename(full)), yaml };
  }

  save(name, yaml, options = {}) {
    const content = String(yaml === undefined || yaml === null ? '' : yaml);
    if (!content.trim()) throw new HttpError(400, 'YAML 内容不能为空');
    this.ensureDir();
    const id = this.fileName(name);
    const full = path.join(this.dir, id);
    const createOnly = options.createOnly === true;
    const overwrite = options.overwrite === true;
    const originalName = options.originalName ? this.fileName(options.originalName) : '';
    if (createOnly && !overwrite && fs.existsSync(full)) {
      throw new HttpError(409, `文件名已存在：${id}`);
    }
    if (originalName) {
      const originalFull = this.filePath(originalName);
      const sameFile = process.platform === 'win32'
        ? path.resolve(originalFull).toLowerCase() === path.resolve(full).toLowerCase()
        : originalFull === full;
      if (!sameFile) {
        if (!fs.existsSync(originalFull)) throw new HttpError(404, `原配置文件不存在：${originalName}`);
        const targetExists = fs.existsSync(full);
        if (targetExists && !overwrite) throw new HttpError(409, `文件名已存在：${id}`);
        const previousTarget = targetExists ? fs.readFileSync(full, 'utf8') : null;
        atomicWrite(full, content);
        try {
          fs.unlinkSync(originalFull);
        } catch (err) {
          if (err.code !== 'ENOENT') {
            // 删除旧文件失败时回滚目标文件，避免同时留下两份配置；
            // 如果目标是覆盖已有文件，则恢复原内容而不是直接删除。
            let rollbackError = null;
            try {
              if (previousTarget === null) fs.unlinkSync(full);
              else atomicWrite(full, previousTarget);
            } catch (cleanupErr) {
              rollbackError = cleanupErr;
            }
            const suffix = rollbackError ? `；回滚目标文件也失败：${rollbackError.message}` : '；已回滚目标文件';
            throw new HttpError(500, `重命名模板失败：${err.message}${suffix}`);
          }
        }
        return this.get(id);
      }
    }
    atomicWrite(full, content);
    return this.get(id);
  }

  remove(id) {
    const full = this.filePath(id);
    try {
      fs.unlinkSync(full);
    } catch (err) {
      if (err.code === 'ENOENT') throw new HttpError(404, `模板不存在：${templateLabel(id)}`);
      throw new HttpError(500, `删除模板失败：${err.message}`);
    }
    return true;
  }
}

module.exports = { TemplateStore, templateLabel };
