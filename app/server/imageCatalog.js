'use strict';

const fs = require('fs');
const path = require('path');
const { HttpError, atomicWrite, isPlainObject } = require('./util');

/**
 * 镜像清单（分类 + 镜像）持久化在 data/image-management/images.json。
 * 服务启动时调用 ensureFile()：文件不存在就建一个空清单，页面和磁盘始终对得上。
 * 读取只读盘；界面上的增删改通过 update() 写回这个文件。
 * 每次请求都重新读盘，所以改完文件刷新页面即可生效，不需要重启。
 */

// 从镜像引用里取 tag，用于 versions 留空时的兜底
function imageTagOf(ref) {
  const text = String(ref || '');
  const slash = text.lastIndexOf('/');
  const colon = text.lastIndexOf(':');
  return colon > slash ? text.slice(colon + 1) : 'latest';
}

function slugId(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function uniqueId(base, used) {
  let id = base || 'item';
  let index = 2;
  while (used.has(id)) id = base + '-' + index++;
  used.add(id);
  return id;
}

function normalizeCategory(value, index, used) {
  const source = isPlainObject(value) ? value : {};
  const label = String(source.label || '').trim();
  if (!label) return null;
  return { id: uniqueId(String(source.id || '').trim() || slugId(label) || 'category-' + (index + 1), used), label };
}

function normalizeImage(value, index, used) {
  const source = isPlainObject(value) ? value : {};
  const name = String(source.name || '').trim();
  const image = String(source.image || '').trim();
  if (!name || !image) return null;
  const versions = [];
  (Array.isArray(source.versions) ? source.versions : []).forEach((item) => {
    const version = String(item === undefined || item === null ? '' : item).trim();
    if (version && versions.indexOf(version) === -1) versions.push(version);
  });
  return {
    id: uniqueId(String(source.id || '').trim() || slugId(name) || 'image-' + (index + 1), used),
    name,
    ico: String(source.ico || '').trim() || 'box',
    kind: String(source.kind || '').trim(),
    tone: String(source.tone || '').trim() || 'neutral',
    image,
    versions: versions.length ? versions : [imageTagOf(image)],
    page: String(source.page || '').trim(),
    desc: String(source.desc || '').trim()
  };
}

// 校验并规整清单：缺字段的条目丢掉并计入 skipped，结构不对直接报错
function normalizeCatalog(value) {
  if (!isPlainObject(value)) throw new HttpError(500, 'images.json 顶层必须是 JSON 对象');
  if (!Array.isArray(value.categories)) throw new HttpError(500, 'images.json 缺少 categories 数组');
  if (!Array.isArray(value.images)) throw new HttpError(500, 'images.json 缺少 images 数组');
  const usedCategories = new Set();
  const categories = [];
  let skipped = 0;
  value.categories.forEach((item, index) => {
    const category = normalizeCategory(item, index, usedCategories);
    if (!category) {
      skipped += 1;
      return;
    }
    categories.push(category);
  });
  const usedImages = new Set();
  const images = [];
  value.images.forEach((item, index) => {
    const image = normalizeImage(item, index, usedImages);
    if (!image) {
      skipped += 1;
      return;
    }
    images.push(image);
  });
  return { categories, images, skipped };
}

class ImageCatalogStore {
  constructor(file) {
    this.file = file;
  }

  exists() {
    return fs.existsSync(this.file);
  }

  // 启动时调用：文件不存在就建一个空清单（data 目录一起建出来），返回是否新建
  ensureFile() {
    if (this.exists()) return false;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    atomicWrite(this.file, JSON.stringify({ categories: [], images: [] }, null, 2) + '\n');
    return true;
  }

  // 只读：文件不存在就返回空清单（页面显示没有镜像），不会自动生成
  read() {
    let raw;
    try {
      raw = fs.readFileSync(this.file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return { categories: [], images: [], skipped: 0, missing: true };
      throw new HttpError(500, '读取 images.json 失败：' + err.message);
    }
    const text = raw.replace(/^\uFEFF/, '');
    if (!text.trim()) throw new HttpError(500, 'images.json 是空文件，请写入 categories 和 images');
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new HttpError(500, 'images.json 不是合法 JSON：' + err.message);
    }
    return { ...normalizeCatalog(parsed), missing: false };
  }

  // 覆盖写回：data 目录不存在会一起建出来
  write(catalog) {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    atomicWrite(this.file, JSON.stringify({ categories: catalog.categories, images: catalog.images }, null, 2) + '\n');
  }

  // 读 → 改 → 校验 → 写，返回写完后的清单
  update(mutate) {
    const current = this.read();
    const next = mutate({
      categories: current.categories.map((item) => ({ ...item })),
      images: current.images.map((item) => ({ ...item }))
    });
    const saved = normalizeCatalog(next);
    this.write(saved);
    return { categories: saved.categories, images: saved.images, skipped: 0, missing: false };
  }
}

// 中文名称生成不出英文 slug，用短哈希兜底，保证 id 稳定且不会重复
function shortHash(text) {
  let hash = 7;
  const value = String(text);
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) % 0xffffffff;
  }
  return hash.toString(36).padStart(5, '0');
}

// 分类 id：用分类名生成（如 database）；中文名用 cat-xxxxx
function newCategoryId(label, categories) {
  const used = new Set(categories.map((item) => item.id));
  const base = slugId(label) || 'cat-' + shortHash(label);
  let id = base;
  let index = 2;
  while (used.has(id)) id = base + '-' + index++;
  return id;
}

// 镜像 id：用镜像名生成（如 mysql）；中文名用 img-xxxxx
function newImageId(name, images) {
  const used = new Set(images.map((item) => item.id));
  const base = slugId(name) || 'img-' + shortHash(name);
  let id = base;
  let index = 2;
  while (used.has(id)) id = base + '-' + index++;
  return id;
}

module.exports = { ImageCatalogStore, normalizeCatalog, newCategoryId, newImageId };
