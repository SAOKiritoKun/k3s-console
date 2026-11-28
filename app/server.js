'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const {
  HttpError,
  sendJson,
  readJson,
  maskSecrets,
  restoreSecrets,
  formatError,
  safeId,
  formatBytesText,
  createProgressThrottle
} = require('./server/util');
const { ConfigStore } = require('./server/config');
const { ServerStore, DEFAULT_GROUP } = require('./server/servers');
const { TemplateStore } = require('./server/templates');
const { ImageRepositoryStore } = require('./server/imageRepository');
const { ImageCatalogStore, newCategoryId, newImageId } = require('./server/imageCatalog');
const { Transport, hasSsh2 } = require('./server/transport');
const kube = require('./server/kube');
const inspect = require('./server/inspect');
const deploy = require('./server/deploy');
const offline = require('./server/offline');
const { TerminalManager } = require('./server/terminal');
const { JobManager } = require('./server/jobs');

const ROOT = __dirname;
const PROJECT_ROOT = path.resolve(ROOT, '..');
const CONFIG_FILE = path.join(PROJECT_ROOT, 'config.json');
const DATA_DIR = path.join(PROJECT_ROOT, 'data');
const SERVERS_FILE = path.join(DATA_DIR, 'server.json');
// 镜像相关配置统一放在 data/image-management/ 下（仓库配置、后续的镜像清单都放这里）
const IMAGE_MANAGEMENT_DIR = path.join(DATA_DIR, 'image-management');
const IMAGE_REPOSITORY_FILE = path.join(IMAGE_MANAGEMENT_DIR, 'images-repository.json');
// 镜像清单（分类 + 镜像）：工程自带的预置文件，只读，不自动生成
const IMAGE_CATALOG_FILE = path.join(IMAGE_MANAGEMENT_DIR, 'images.json');
const LEGACY_IMAGE_REPOSITORY_FILE = path.join(DATA_DIR, 'image-repository.json');
const TEMPLATES_DIR = path.join(DATA_DIR, 'deployment-templates');
const LEGACY_TEMPLATES_DIR = path.join(DATA_DIR, 'deploymentTemplates');
const LOGS_DIR = path.join(PROJECT_ROOT, 'logs');
const JOBS_DIR = path.join(LOGS_DIR, 'operations');
// 镜像导出会先把远程 tar 拉到控制端临时目录，再由浏览器下载，便于在跟踪窗口里展示进度。
const EXPORT_TMP_DIR = path.join(LOGS_DIR, 'tmp');
const VERSION = require('../package.json').version;
const startedAt = Date.now();

let store;
try {
  store = new ConfigStore(CONFIG_FILE);
  store.load();
} catch (err) {
  console.error('\n[启动失败] ' + formatError(err));
  if (err.detail) console.error(err.detail);
  console.error('\n请修正项目根目录 config.json 后重新启动。\n');
  process.exit(1);
}

let serverStore;
let templateStore;
let imageRepositoryStore;
let imageCatalogStore;

// 旧版本的数据路径改过名，首次启动时把旧路径整体搬到新路径，避免配置丢失
function migrateDataPath(fromPath, toPath, label) {
  try {
    if (fs.existsSync(toPath)) return false;
    if (!fs.existsSync(fromPath)) return false;
    fs.mkdirSync(path.dirname(toPath), { recursive: true });
    try {
      fs.renameSync(fromPath, toPath);
    } catch (_) {
      // 跨盘或权限受限时退回「复制后删除」
      fs.cpSync(fromPath, toPath, { recursive: true });
      fs.rmSync(fromPath, { recursive: true, force: true });
    }
    console.log(`[data] ${label}已迁移到 ${path.relative(PROJECT_ROOT, toPath).split(path.sep).join('/')}`);
    return true;
  } catch (err) {
    console.error(`[data] ${label}迁移失败，继续使用新路径：${formatError(err)}`);
    return false;
  }
}

try {
  serverStore = new ServerStore(SERVERS_FILE);
  const existed = serverStore.load();
  const legacyHosts = store.legacyHosts();
  if (!existed) {
    serverStore.save(legacyHosts);
    if (legacyHosts.length) console.log(`[data] 已迁移 ${legacyHosts.length} 台服务器到 data/server.json`);
  }
  if (store.hasLegacyHosts()) {
    store.dropLegacyHosts();
    console.log('[data] 已从 config.json 移除服务器信息');
  }
  // 先迁移再 ensureDir，否则新目录会先被建出来，旧目录里的配置就搬不过去了
  migrateDataPath(LEGACY_IMAGE_REPOSITORY_FILE, IMAGE_REPOSITORY_FILE, '镜像仓库配置');
  migrateDataPath(LEGACY_TEMPLATES_DIR, TEMPLATES_DIR, '本地配置目录');
  templateStore = new TemplateStore(TEMPLATES_DIR);
  templateStore.ensureDir();
  imageRepositoryStore = new ImageRepositoryStore(IMAGE_REPOSITORY_FILE);
  imageRepositoryStore.load();
  imageCatalogStore = new ImageCatalogStore(IMAGE_CATALOG_FILE);
  // 启动时确保清单文件存在：没有就建一个空清单，之后新增分类/镜像直接往里写
  try {
    if (imageCatalogStore.ensureFile()) console.log(`[data] 已创建空镜像清单：${IMAGE_CATALOG_FILE}`);
  } catch (err) {
    console.error(`[data] 创建镜像清单失败：${formatError(err)}`);
  }
  // 启动时先校验一次清单，配置写错了能在启动日志里直接看到，但不阻止服务启动
  try {
    imageCatalogStore.read();
  } catch (err) {
    console.error(`[data] 镜像清单有问题：${formatError(err)}`);
  }
} catch (err) {
  console.error('\n[启动失败] ' + formatError(err));
  if (err.detail) console.error(err.detail);
  console.error('\n请修正 data/server.json 后重新启动。\n');
  process.exit(1);
}

const transport = new Transport(store.get());
const jobs = new JobManager(80, { dir: JOBS_DIR });
const terminals = new TerminalManager({ maxSessions: 8 });
const detectCache = new Map();
const detectPending = new Map();
const DETECT_TTL = 60000;

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8'
};

function ctx() {
  const config = store.get();
  // 让 config.json 的外部热更新同时作用于 SSH 超时 / 主机密钥策略等全局参数
  if (transport.config !== config) transport.setConfig(config);
  return { config, servers: serverStore.all(), transport, jobs, imageRepo: imageRepositoryStore };
}

function ok(res, data, status = 200) {
  sendJson(res, status, { ok: true, data });
}

function fail(res, err) {
  const status = err instanceof HttpError ? err.status : 500;
  if (status >= 500) console.error('[error]', err && err.stack ? err.stack : err);
  sendJson(res, status, {
    ok: false,
    error: formatError(err),
    detail: err && err.detail ? String(err.detail) : undefined
  });
}

function decodePathPart(value) {
  try {
    return decodeURIComponent(value);
  } catch (_) {
    throw new HttpError(400, 'URL 编码不合法');
  }
}

/* ------------------------------------------------------------
 * 镜像清单编辑：分类增删改名、镜像增删改，写回 images.json
 * ------------------------------------------------------------ */
function imageEditPayload(body, id) {
  const source = body && typeof body === 'object' ? body : {};
  const rawVersions = Array.isArray(source.versions)
    ? source.versions
    : String(source.versions || '').split(/[,，\s]+/);
  const versions = [];
  rawVersions.forEach((item) => {
    const version = String(item === undefined || item === null ? '' : item).trim();
    if (version && versions.indexOf(version) === -1) versions.push(version);
  });
  return {
    id,
    name: String(source.name || '').trim(),
    image: String(source.image || '').trim(),
    kind: String(source.kind || '').trim(),
    versions,
    ico: String(source.ico || '').trim(),
    tone: String(source.tone || '').trim(),
    page: String(source.page || '').trim(),
    desc: String(source.desc || '').trim()
  };
}

async function saveImageCatalogChange(isCategory, targetId, method, req) {
  if (isCategory) {
    if (!targetId && method === 'POST') {
      const body = await readJson(req);
      const label = String(body.label || '').trim();
      if (!label) throw new HttpError(400, '分类名称不能为空');
      return imageCatalogStore.update((draft) => {
        if (draft.categories.some((item) => item.label === label)) {
          throw new HttpError(409, `分类「${label}」已存在`);
        }
        draft.categories.push({ id: newCategoryId(label, draft.categories), label });
        return draft;
      });
    }
    if (!targetId && method === 'PUT') {
      // 拖动排序：order 是想要的分类 id 顺序，没列到的按原顺序补在后面
      const body = await readJson(req);
      const order = Array.isArray(body.order) ? body.order.map((item) => String(item || '')) : [];
      if (!order.length) throw new HttpError(400, '缺少 order 字段');
      return imageCatalogStore.update((draft) => {
        const remaining = new Map(draft.categories.map((item) => [item.id, item]));
        const sorted = [];
        order.forEach((id) => {
          const item = remaining.get(id);
          if (!item) return;
          sorted.push(item);
          remaining.delete(id);
        });
        remaining.forEach((item) => sorted.push(item));
        draft.categories = sorted;
        return draft;
      });
    }
    if (targetId && method === 'PUT') {
      const body = await readJson(req);
      const label = String(body.label || '').trim();
      if (!label) throw new HttpError(400, '分类名称不能为空');
      return imageCatalogStore.update((draft) => {
        const target = draft.categories.find((item) => item.id === targetId);
        if (!target) throw new HttpError(404, '分类不存在，可能已经被删除');
        if (draft.categories.some((item) => item.id !== target.id && item.label === label)) {
          throw new HttpError(409, `分类「${label}」已存在`);
        }
        // id 保持不变，镜像用 kind 关联 id，所以改名不影响归属
        target.label = label;
        return draft;
      });
    }
    if (targetId && method === 'DELETE') {
      return imageCatalogStore.update((draft) => {
        const target = draft.categories.find((item) => item.id === targetId);
        if (!target) throw new HttpError(404, '分类不存在，可能已经被删除');
        draft.categories = draft.categories.filter((item) => item.id !== targetId);
        // 确认删除分类时一并删掉它下面的镜像配置（兼容 kind 写分类名的老写法）
        draft.images = draft.images.filter(
          (item) => item.kind !== targetId && item.kind !== target.label
        );
        return draft;
      });
    }
    throw new HttpError(405, `不支持的方法：${method}`);
  }

  if (!targetId && method === 'POST') {
    const body = await readJson(req);
    const payload = imageEditPayload(body, '');
    if (!payload.name) throw new HttpError(400, '镜像名称不能为空');
    if (!payload.image) throw new HttpError(400, '镜像地址不能为空');
    return imageCatalogStore.update((draft) => {
      if (draft.images.some((item) => item.name === payload.name)) {
        throw new HttpError(409, `镜像名称「${payload.name}」已存在`);
      }
      draft.images.push({ ...payload, id: newImageId(payload.name, draft.images) });
      return draft;
    });
  }
  if (targetId && method === 'PUT') {
    const body = await readJson(req);
    const payload = imageEditPayload(body, targetId);
    if (!payload.name) throw new HttpError(400, '镜像名称不能为空');
    if (!payload.image) throw new HttpError(400, '镜像地址不能为空');
    return imageCatalogStore.update((draft) => {
      const index = draft.images.findIndex((item) => item.id === targetId);
      if (index < 0) throw new HttpError(404, '镜像不存在，可能已经被删除');
      if (draft.images.some((item) => item.id !== targetId && item.name === payload.name)) {
        throw new HttpError(409, `镜像名称「${payload.name}」已存在`);
      }
      draft.images[index] = { ...payload };
      return draft;
    });
  }
  if (targetId && method === 'DELETE') {
    return imageCatalogStore.update((draft) => {
      const index = draft.images.findIndex((item) => item.id === targetId);
      if (index < 0) throw new HttpError(404, '镜像不存在，可能已经被删除');
      draft.images.splice(index, 1);
      return draft;
    });
  }
  throw new HttpError(405, `不支持的方法：${method}`);
}

/* ------------------------------------------------------------
 * 镜像 tar 导入 / 导出：先建 job（前端据此打开跟踪窗口），
 * 再由第二个请求（上传流 / 下载流）真正执行。
 * ------------------------------------------------------------ */
const IMAGE_UPLOAD_TTL = 5 * 60 * 1000;
const pendingImageImports = new Map(); // jobId -> { timer, hostIds, fileName, remoteName, bytes }

function rememberImageImport(job, hosts, fileName, remoteName) {
  const timer = setTimeout(() => {
    const entry = pendingImageImports.get(job.id);
    if (!entry) return;
    pendingImageImports.delete(job.id);
    jobs.settle(job, 'failed', null, new Error('镜像 tar 上传超时，未收到文件内容'));
  }, IMAGE_UPLOAD_TTL);
  if (timer.unref) timer.unref();
  pendingImageImports.set(job.id, {
    timer,
    hostIds: hosts.map((host) => host.id),
    fileName,
    remoteName,
    bytes: 0
  });
}

function takeImageImport(jobId) {
  const entry = pendingImageImports.get(jobId);
  if (!entry) return null;
  clearTimeout(entry.timer);
  pendingImageImports.delete(jobId);
  return entry;
}

// 接收浏览器上传的 tar（落到控制端 logs/tmp），再逐台 SFTP 分发、导入、清理。
// 只上传一次，多台服务器复用同一个包。
async function runImageImport(req, job, entry) {
  const localPath = path.join(EXPORT_TMP_DIR, entry.remoteName);
  ensureDirFor(localPath);
  const total = Number(req.headers['content-length']) || 0;
  const results = [];
  try {
    await jobs.runJob(job, async (j) => {
      // 放在任务体内取主机：中途有服务器被删掉时，任务会正常记为失败而不是一直停在执行中
      const destinations = entry.hostIds.map((id) => serverStore.host(id));
      const stepReceive = j.startStep('接收镜像 tar 到控制端');
      let received = 0;
      let killReceive = null;
      try {
        await new Promise((resolve, reject) => {
          let settled = false;
          const settle = (err) => {
            if (settled) return;
            settled = true;
            if (err) reject(err); else resolve();
          };
          const ws = fs.createWriteStream(localPath);
          killReceive = () => {
            try { req.destroy(); } catch (_) { /* ignore */ }
            try { ws.destroy(); } catch (_) { /* ignore */ }
          };
          j.registerKill(killReceive);
          const pushProgress = createProgressThrottle(250);
          req.on('data', (chunk) => {
            received += chunk.length;
            const pct = total > 0 ? Math.min(100, Math.floor((received / total) * 100)) : null;
            if (pushProgress.tick(pct)) {
              j.updateStep(stepReceive, total > 0
                ? `已接收 ${formatBytesText(received)} / ${formatBytesText(total)}（${pct}%）`
                : `已接收 ${formatBytesText(received)}`, pct);
            }
          });
          req.on('aborted', () => settle(new Error('上传已中断')));
          req.on('error', settle);
          ws.on('error', settle);
          ws.on('finish', () => settle());
          // 取消时 ws 被 destroy，不会再触发 finish，靠 close 兑现 Promise
          ws.on('close', () => settle(new Error('上传已中断')));
          req.pipe(ws);
        });
      } catch (err) {
        j.finishStep(stepReceive, 'failed', j.cancelled ? '已取消' : formatError(err));
        throw err;
      } finally {
        j.unregisterKill(killReceive);
      }
      if (!received) {
        j.finishStep(stepReceive, 'failed', '没有收到文件内容');
        throw new HttpError(400, '没有收到镜像文件内容');
      }
      j.finishStep(stepReceive, 'success', `${formatBytesText(received)} → ${localPath}`);
      j.log(`接收完成，开始分发到 ${destinations.length} 台服务器`);
      j.checkCancelled();

      for (let index = 0; index < destinations.length; index += 1) {
        const host = destinations[index];
        const label = host.name || host.id;
        j.log(`[${index + 1}/${destinations.length}] ${label}（${host.host || host.id}）`);
        let failure = '';
        let remotePath = '';

        const stepUpload = j.startStep(`分发 tar 到 ${label}`);
        let killUpload = null;
        try {
          let lastMark = -1;
          const upload = await transport.sftpUpload(host, fs.createReadStream(localPath), '/tmp', entry.remoteName, {
            overwrite: false,
            total: received,
            onProgress: ({ received: sent, total: all }) => {
              const bytes = Number(sent) || 0;
              const full = Number(all) || received || 0;
              if (full <= 0) return;
              const pct = Math.min(100, Math.floor((bytes / full) * 100));
              j.updateStep(stepUpload, `已上传 ${formatBytesText(bytes)} / ${formatBytesText(full)}（${pct}%）`);
              if (pct >= lastMark + 20 || pct === 100) {
                lastMark = pct;
                j.log(`  上传进度 ${pct}%（${formatBytesText(bytes)} / ${formatBytesText(full)}）`);
              }
            },
            onStart: (kill) => { killUpload = kill; j.registerKill(kill); }
          });
          remotePath = upload.path;
          j.finishStep(stepUpload, 'success', `${formatBytesText(upload.size)} → ${remotePath}`);
        } catch (err) {
          failure = formatError(err);
          j.finishStep(stepUpload, 'failed', failure);
        } finally {
          if (killUpload) j.unregisterKill(killUpload);
        }

        if (!failure) {
          const stepImport = j.startStep(`导入镜像库 ${label}`);
          try {
            await inspect.importImageTar(host, ctx(), remotePath, { job: j });
            j.finishStep(stepImport, 'success', '镜像已写入节点镜像库');
          } catch (err) {
            failure = formatError(err);
            j.finishStep(stepImport, 'failed', failure);
          }
        }

        if (remotePath) {
          // 清理放在任务体内，成功、失败、取消都会在窗口里留下这一步
          const stepClean = j.startStep(`清理 ${label} 临时文件`);
          try {
            await inspect.removeImageTar(host, ctx(), remotePath);
            j.finishStep(stepClean, 'success', `已删除 ${remotePath}`);
          } catch (err) {
            j.finishStep(stepClean, 'failed', formatError(err));
            j.log(`清理 ${label} 临时文件失败：${formatError(err)}`, 'warn');
          }
        }

        results.push({ hostId: host.id, name: label, ok: !failure, error: failure || null });
        if (failure) j.log(`${label} 导入失败：${failure}`, 'warn');
        j.checkCancelled();
      }

      const failed = results.filter((item) => !item.ok);
      if (failed.length) {
        const detail = failed.map((item) => `${item.name}：${item.error}`).join('；');
        throw new HttpError(500, `${failed.length}/${results.length} 台导入失败（${detail}）`);
      }
      return { hosts: results, size: received };
    });
  } finally {
    try { fs.rmSync(localPath, { force: true }); } catch (_) { /* 控制端临时包用后即删 */ }
  }
  return { jobId: job.id, hosts: results };
}

function ensureDirFor(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

// 控制端导出缓存：只保留「记录里还引用着、且不超过一天」的 tar；
// 没有记录引用的（例如导出中途服务被重启留下的半包）和超过一天的一律清掉
function pruneExportTmp() {
  let names = [];
  try {
    names = fs.readdirSync(EXPORT_TMP_DIR);
  } catch (_) {
    return;
  }
  const referenced = new Set();
  let records = [];
  try {
    records = fs.readdirSync(JOBS_DIR).filter((name) => name.endsWith('.json'));
  } catch (_) { /* 没有记录目录时按无主文件处理 */ }
  for (const name of records) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, name), 'utf8'));
      const file = data && data.result && data.result.file;
      if (file) referenced.add(path.resolve(String(file)));
    } catch (_) { /* 忽略坏记录 */ }
  }
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const name of names) {
    const file = path.join(EXPORT_TMP_DIR, name);
    try {
      const stat = fs.statSync(file);
      if (referenced.has(path.resolve(file)) && stat.mtimeMs >= cutoff) continue;
      fs.rmSync(file, { force: true });
    } catch (_) { /* ignore */ }
  }
}

// 删除记录时一并清掉它导出的 tar 缓存（只删 logs/tmp 下的文件）
function deleteJobTmpFiles(list) {
  const base = path.resolve(EXPORT_TMP_DIR);
  let removed = 0;
  for (const job of list) {
    const result = (job && job.result) || {};
    const local = String(result.file || '');
    if (!local) continue;
    const resolved = path.resolve(local);
    if (!resolved.startsWith(base + path.sep)) continue;
    try {
      fs.rmSync(resolved, { force: true });
      removed += 1;
    } catch (_) { /* ignore */ }
    result.file = null;
  }
  return removed;
}

// 启动清理后，把仍指向已删除 tar 的记录标记为已清理，避免窗口里留一个点了报错的下载按钮
function reconcileExportRecords() {
  let names = [];
  try {
    names = fs.readdirSync(JOBS_DIR).filter((name) => name.endsWith('.json'));
  } catch (_) {
    return;
  }
  const base = path.resolve(EXPORT_TMP_DIR);
  for (const name of names) {
    const file = path.join(JOBS_DIR, name);
    let data = null;
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      continue;
    }
    const result = data && data.result;
    if (!result || !result.file) continue;
    const resolved = path.resolve(String(result.file));
    if (!resolved.startsWith(base + path.sep)) continue;
    if (fs.existsSync(resolved)) continue;
    result.file = null;
    result.fileRemoved = true;
    result.fileMissing = true;
    try { fs.writeFileSync(file, JSON.stringify(data), 'utf8'); } catch (_) { /* ignore */ }
  }
}

// 卸载确认口令：页面需输入 uninstall（不区分大小写、忽略首尾空格），服务端同样校验
const UNINSTALL_CONFIRM_TEXT = 'uninstall';

function uninstallConfirmed(value) {
  return String(value || '').trim().toLowerCase() === UNINSTALL_CONFIRM_TEXT;
}

function tokenValid(req, url) {
  const app = store.get().app || {};
  const expected = String(app.accessToken || '').trim();
  if (!expected) return true;
  const provided = String(req.headers['x-access-token'] || url.searchParams.get('token') || '');
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function getHostDetected(host, force = false) {
  const cached = detectCache.get(host.id);
  if (!force && cached && Date.now() - cached.at < DETECT_TTL) return cached.result;
  const pending = detectPending.get(host.id);
  if (pending) return pending;
  const task = (async () => {
    const result = await inspect.detectHost(host, ctx());
    detectCache.set(host.id, { at: Date.now(), result });
    // 探测出真实角色后同步回服务器记录，避免列表里长期显示添加时声明的角色
    const actual = result && result.k8s && result.k8s.role;
    if ((actual === 'server' || actual === 'agent') && host.role !== actual) {
      try { serverStore.update(host.id, { role: actual }); } catch (_) { /* 同步失败不影响检测结果 */ }
    }
    return result;
  })();
  detectPending.set(host.id, task);
  try {
    return await task;
  } finally {
    if (detectPending.get(host.id) === task) detectPending.delete(host.id);
  }
}

function clearCaches() {
  kube.clearKubeCache();
  detectCache.clear();
  detectPending.clear();
}

// 分组列表 + 每组服务器数量，前端据此渲染下拉和分组管理弹窗
function groupPayload() {
  const counts = serverStore.groupCounts();
  return serverStore.listGroups().map((name) => ({
    name,
    count: counts.get(name) || 0,
    builtin: name === DEFAULT_GROUP
  }));
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const method = req.method || 'GET';

  if (parts[1] === 'health' && method === 'GET') {
    return ok(res, {
      name: store.title,
      version: VERSION,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      hasSsh2: hasSsh2(),
      uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
      hosts: serverStore.count()
    });
  }

  if (parts[1] === 'meta' && method === 'GET') {
    const kinds = Object.entries(kube.RESOURCES).map(([key, def]) => ({
      key,
      label: def.label,
      namespaced: def.namespaced,
      columns: def.columns
    }));
    return ok(res, {
      kinds,
      resources: Object.fromEntries(Object.entries(kube.RESOURCES).map(([key, def]) => [key, {
        label: def.label,
        namespaced: def.namespaced,
        columns: def.columns
      }])),
      version: VERSION,
      hasSsh2: hasSsh2()
    });
  }

  if (parts[1] === 'offline' && parts[2] === 'packages' && method === 'GET') {
    res.setHeader('Cache-Control', 'no-store');
    const packages = await offline.listPackagesAsync();
    return ok(res, {
      root: 'packages',
      packages: packages.map((pkg) => ({
        id: pkg.id,
        version: pkg.version,
        arch: pkg.arch,
        archLabel: pkg.archLabel,
        valid: pkg.valid,
        issues: pkg.issues,
        size: pkg.size,
        files: pkg.files,
        binary: pkg.binary,
        image: pkg.image,
        installer: pkg.installer,
        hasChecksums: pkg.hasChecksums,
        signature: pkg.signature
      }))
    });
  }

  if (parts[1] === 'image-repository' && parts.length === 2) {
    if (method === 'GET') {
      imageRepositoryStore.load();
      return ok(res, { repository: imageRepositoryStore.publicConfig() });
    }
    if (method === 'PUT') {
      const body = await readJson(req);
      return ok(res, { repository: imageRepositoryStore.save(body) });
    }
    throw new HttpError(405, `不支持的方法：${method}`);
  }

  // 镜像清单：分类 + 镜像信息，来源 data/image-management/images.json，每次请求都重新读盘
  if (parts[1] === 'images' && parts[2] === 'catalog' && parts.length === 3) {
    if (method !== 'GET') throw new HttpError(405, `不支持的方法：${method}`);
    const catalog = imageCatalogStore.read();
    return ok(res, {
      categories: catalog.categories,
      images: catalog.images,
      skipped: catalog.skipped,
      missing: Boolean(catalog.missing),
      file: 'data/image-management/images.json'
    });
  }

  // 镜像清单编辑：分类增删改名、镜像增删改，每次都写回 images.json（文件不存在会创建）
  if (parts[1] === 'images' && parts[2] === 'catalog' && (parts[3] === 'categories' || parts[3] === 'images') && parts.length <= 5) {
    const isCategory = parts[3] === 'categories';
    const targetId = parts[4] ? decodePathPart(parts[4]) : '';
    const catalogResult = await saveImageCatalogChange(isCategory, targetId, method, req);
    return ok(res, { catalog: catalogResult });
  }

  if (parts[1] === 'config') {
    if (method === 'GET') return ok(res, { config: store.publicConfig() });
    if (method === 'PUT') {
      const body = await readJson(req);
      if (!body.config) throw new HttpError(400, '缺少 config 字段');
      const restored = restoreSecrets(body.config, store.getRaw());
      store.save(restored);
      transport.setConfig(store.get());
      clearCaches();
      return ok(res, { config: store.publicConfig() });
    }
    if (method === 'POST' && parts[2] === 'reload') {
      store.load();
      transport.setConfig(store.get());
      clearCaches();
      return ok(res, { config: store.publicConfig() });
    }
  }

  if (parts[1] === 'shells') {
    const id = parts[2];
    const action = parts[3];
    if (id && action === 'stream' && method === 'GET') {
      return terminals.attach(id, req, res);
    }
    if (id && action === 'input' && method === 'POST') {
      const body = await readJson(req, 64 * 1024);
      if (typeof body.data !== 'string') throw new HttpError(400, '缺少终端输入 data');
      terminals.write(id, body.data);
      return ok(res, { written: true });
    }
    if (id && action === 'resize' && method === 'POST') {
      const body = await readJson(req, 16 * 1024);
      const cols = Math.max(2, Math.min(500, Math.floor(Number(body.cols) || 0)));
      const rows = Math.max(2, Math.min(300, Math.floor(Number(body.rows) || 0)));
      const resized = terminals.resize(id, cols, rows);
      return ok(res, { resized });
    }
    if (id && action === 'cwd' && method === 'GET') {
      const session = terminals.get(id);
      if (session.kind !== 'host' || !session.cwdFile) {
        throw new HttpError(400, '该终端不支持读取当前目录');
      }
      if (session.status !== 'running') throw new HttpError(409, '终端已结束');
      session.lastAt = Date.now();
      const host = serverStore.host(session.hostId);
      const cwd = await transport.readShellCwd(host, session.cwdFile);
      return ok(res, { cwd });
    }
    if (id && action === 'close' && method === 'POST') {
      terminals.close(id);
      return ok(res, { closed: true });
    }
  }

  if (parts[1] === 'hosts') {
    if (parts.length === 2 && method === 'GET') {
      const hosts = serverStore.publicList().map((host) => {
        const cached = detectCache.get(host.id);
        return { ...host, detected: cached ? cached.result : null };
      });
      return ok(res, { hosts, groups: groupPayload() });
    }
    if (parts.length === 2 && method === 'POST') {
      const body = await readJson(req);
      const host = body.host;
      // kubeconfig / local 两种接入都不需要地址：前者靠本地 kubeconfig，后者直接在控制端执行
      const transportKind = (host && host.transport) || 'ssh';
      const needsHost = transportKind !== 'kubeconfig' && transportKind !== 'local';
      if (!host || (needsHost && !host.host)) throw new HttpError(400, '缺少 host 数据');
      if (transportKind === 'local' && process.platform !== 'linux') {
        throw new HttpError(400, `本地接入仅支持 Linux 控制端（当前控制端是 ${process.platform}），请改用 SSH 或 kubeconfig`);
      }
      host.id = host.id || safeId(host.name || host.host);
      host.group = String(host.group || '').trim() || DEFAULT_GROUP;
      if (!serverStore.hasGroup(host.group)) {
        throw new HttpError(400, `分组不存在：${host.group}。请先在「分组管理」中新增分组`);
      }
      serverStore.add(host);
      transport.setConfig(store.get());
      clearCaches();
      return ok(res, { config: store.publicConfig(), groups: groupPayload() }, 201);
    }
    if (parts.length === 4 && parts[3] === 'group' && method === 'PUT') {
      const id = parts[2];
      const body = await readJson(req);
      const host = serverStore.moveToGroup(id, body.group);
      // 移动分组不重置 SSH 连接与 detect 缓存：服务器本身没变，没必要重新读取
      return ok(res, { host: maskSecrets({ hosts: [host] }).hosts[0], groups: groupPayload() });
    }
    if (parts.length === 3 && (method === 'PUT' || method === 'DELETE')) {
      const id = parts[2];
      if (method === 'DELETE') {
        serverStore.remove(id);
      } else {
        const body = await readJson(req);
        if (!body.host) throw new HttpError(400, '缺少 host 字段');
        if (body.host.transport === 'local' && process.platform !== 'linux') {
          const current = serverStore.host(id);
          if ((current.transport || 'ssh') !== 'local') {
            throw new HttpError(400, `本地接入仅支持 Linux 控制端（当前控制端是 ${process.platform}），请改用 SSH 或 kubeconfig`);
          }
        }
        if (body.host.group !== undefined && !serverStore.hasGroup(body.host.group)) {
          throw new HttpError(400, `分组不存在：${String(body.host.group || '').trim()}。请先在「分组管理」中新增分组`);
        }
        serverStore.update(id, body.host);
      }
      transport.resetHost(id);
      transport.setConfig(store.get());
      detectCache.delete(id);
      clearCaches();
      return ok(res, { config: store.publicConfig(), groups: groupPayload() });
    }
  }

  // 分组：增删改。分组是服务器的归属维度，删除分组会连带删除组内服务器。
  if (parts[1] === 'groups') {
    if (parts.length === 2 && method === 'GET') {
      return ok(res, { groups: groupPayload() });
    }
    if (parts.length === 2 && method === 'POST') {
      const body = await readJson(req);
      const name = serverStore.addGroup(body.name);
      return ok(res, { name, groups: groupPayload() }, 201);
    }
    if (parts.length === 3 && method === 'PUT') {
      const from = decodePathPart(parts[2]);
      const body = await readJson(req);
      const name = serverStore.renameGroup(from, body.name);
      clearCaches();
      return ok(res, { name, groups: groupPayload() });
    }
    if (parts.length === 3 && method === 'DELETE') {
      const name = decodePathPart(parts[2]);
      // 删除前先把组内服务器列出来，前端据此做二次确认文案
      const hosts = serverStore.hostsInGroup(name).map((host) => ({ id: host.id, name: host.name }));
      const result = serverStore.removeGroup(name);
      for (const host of result.removed) {
        transport.resetHost(host.id);
        detectCache.delete(host.id);
      }
      transport.setConfig(store.get());
      clearCaches();
      return ok(res, { name, removed: result.removed, hosts, groups: groupPayload() });
    }
  }

  if (parts[1] === 'templates') {
    if (parts.length === 2 && method === 'GET') {
      return ok(res, { templates: templateStore.list() });
    }
    if (parts.length === 2 && method === 'POST') {
      const body = await readJson(req);
      if (typeof body.yaml !== 'string') throw new HttpError(400, '缺少 YAML 内容');
      return ok(res, {
        template: templateStore.save(body.name, body.yaml, {
          createOnly: body.createOnly === true,
          originalName: body.originalName,
          overwrite: body.overwrite === true
        })
      }, 201);
    }
    if (parts.length === 3 && method === 'DELETE') {
      const id = decodePathPart(parts[2]);
      templateStore.remove(id);
      return ok(res, { deleted: true });
    }
  }

  // /api/hosts/:id/...
  if (parts[1] === 'hosts' && parts[2] && parts[3]) {
    const host = serverStore.host(parts[2]);
    const action = parts[3];
    const sub = parts[4];

    if (action === 'password' && method === 'GET') {
      const auth = host.auth || {};
      if (auth.type !== 'password' || !auth.password) {
        throw new HttpError(404, '该服务器没有保存密码');
      }
      res.setHeader('Cache-Control', 'no-store, max-age=0');
      return ok(res, { password: auth.password });
    }

    if (action === 'sftp') {
      if ((host.transport || 'ssh') !== 'ssh') {
        throw new HttpError(400, '只有 SSH 接入方式支持 SFTP 文件管理');
      }
      if (sub === 'list' && method === 'GET') {
        const data = await transport.sftpList(host, url.searchParams.get('path') || '');
        return ok(res, data);
      }
      if (sub === 'download' && method === 'GET') {
        const filePath = url.searchParams.get('path') || '';
        if (!filePath) throw new HttpError(400, '缺少文件路径');
        await transport.sftpDownload(host, filePath, res);
        return;
      }
      if (sub === 'upload' && method === 'POST') {
        const dir = url.searchParams.get('dir') || '';
        const name = url.searchParams.get('name') || '';
        const overwrite = url.searchParams.get('overwrite') === '1';
        const data = await transport.sftpUpload(host, req, dir, name, { overwrite });
        return ok(res, data, 201);
      }
      throw new HttpError(404, `SFTP 接口不存在：${req.method} ${url.pathname}`);
    }

    if (action === 'test' && method === 'POST') {
      const result = await transport.testConnection(host);
      return ok(res, result);
    }

    if (action === 'detect' && method === 'POST') {
      const result = await getHostDetected(host, true);
      return ok(res, result);
    }

    if (action === 'images' && method === 'DELETE') {
      const image = url.searchParams.get('image') || '';
      const result = await inspect.removeImage(host, ctx(), image);
      return ok(res, result);
    }

    if (action === 'images' && method === 'POST' && sub === 'pull') {
      const body = await readJson(req);
      const repo = imageRepositoryStore;
      const image = repo.resolve(body.image);
      const credentials = body.username || body.password
        ? { username: body.username, password: body.password }
        : (repo.credentials() || {});
      const result = await inspect.pullImage(host, ctx(), image, credentials);
      return ok(res, result, 201);
    }

    // 导入镜像 tar 走批量接口：POST /api/images/import（一次上传，逐台分发），这里不再有单机入口

    if (action === 'images' && method === 'POST' && sub === 'export') {
      if ((host.transport || 'ssh') !== 'ssh') throw new HttpError(400, '只有 SSH 接入方式支持导出镜像 tar');
      const body = await readJson(req);
      const image = String(body.image || '').trim();
      if (!image || image === '<none>') throw new HttpError(400, '请选择有效的镜像');
      const job = jobs.run('image-export', '导出镜像 tar', { hostId: host.id }, async (j) => {
        j.log(`镜像：${image}`);
        j.log(`目标服务器：${host.name || host.id}（${host.host || host.id}）`);
        const stepExport = j.startStep('在节点上导出镜像 tar');
        let file = null;
        let localPath = null;
        try {
          file = await inspect.exportImageTar(host, ctx(), image, { job: j });
          const size = await inspect.remoteFileSize(host, ctx(), file.path);
          j.finishStep(stepExport, 'success', `${file.name}${size ? `（${formatBytesText(size)}）` : ''}`);
          j.checkCancelled();

          const stepDownload = j.startStep('下载 tar 到控制端');
          localPath = path.join(EXPORT_TMP_DIR, file.name);
          ensureDirFor(localPath);
          let lastMark = -1;
          // 每个 SFTP 分块都会回调一次（64KB 一块），这里节流到最多 4 次/秒再推给窗口
          const pushProgress = createProgressThrottle(250);
          await transport.downloadToFile(host, file.path, localPath, {
            onProgress: ({ received, total: all }) => {
              const bytes = Number(received) || 0;
              const full = Number(all) || size || 0;
              const pct = full > 0 ? Math.min(100, Math.floor((bytes / full) * 100)) : null;
              if (pushProgress.tick(pct)) {
                j.updateStep(stepDownload, full > 0
                  ? `已下载 ${formatBytesText(bytes)} / ${formatBytesText(full)}（${pct}%）`
                  : `已下载 ${formatBytesText(bytes)}`, pct);
              }
              if (full > 0 && (pct >= lastMark + 10 || pct === 100)) {
                lastMark = pct;
                j.log(`  下载进度 ${pct}%（${formatBytesText(bytes)} / ${formatBytesText(full)}）`);
              }
            },
            onStart: (kill) => j.registerKill(kill)
          });
          j.finishStep(stepDownload, 'success', 'tar 已保存到控制端，下载一次后自动清理');
          return {
            file: localPath,
            name: file.name,
            size,
            downloadUrl: `/api/jobs/${j.id}/download`
          };
        } catch (err) {
          // 失败或取消时不要留下半个 tar
          if (localPath) {
            try { fs.rmSync(localPath, { force: true }); } catch (_) { /* ignore */ }
          }
          throw err;
        } finally {
          // 清理步骤始终放进任务体，成功、失败、取消都能在窗口里看到
          if (file) {
            const stepClean = j.startStep('清理节点临时文件');
            try {
              await inspect.removeImageTar(host, ctx(), file.path);
              j.finishStep(stepClean, 'success', `已删除 ${file.path}`);
            } catch (err) {
              j.finishStep(stepClean, 'failed', formatError(err));
              j.log(`清理节点临时文件失败：${formatError(err)}`, 'warn');
            }
          }
        }
      });
      return ok(res, { jobId: job.id }, 202);
    }

    if (action === 'images' && method === 'GET') {
      const result = await inspect.listImages(host, ctx());
      return ok(res, result);
    }

    if (action === 'preflight' && method === 'POST') {
      const body = await readJson(req);
      const result = await inspect.preflight(host, ctx(), {
        mode: body.mode || 'k3s-server',
        installMode: body.installMode || (body.options && body.options.installMode)
      });
      return ok(res, result);
    }

    if (action === 'install' && method === 'POST') {
      const body = await readJson(req);
      if ((host.transport || 'ssh') === 'kubeconfig') throw new HttpError(400, 'kubeconfig 模式仅用于纳管已有集群，无法安装');
      const title = '安装 k3s';
      const options = { ...(body.options || {}), role: body.role || (body.options && body.options.role) || (host.role === 'agent' ? 'agent' : 'server') };
      const job = jobs.run('install', title, { hostId: host.id }, (j) => deploy.doSingleInstall(j, ctx(), host, options));
      return ok(res, { jobId: job.id }, 202);
    }

    if (action === 'upgrade' && method === 'POST') {
      const body = await readJson(req);
      if ((host.transport || 'ssh') === 'kubeconfig') throw new HttpError(400, 'kubeconfig 模式仅用于纳管已有集群，无法升级 k3s');
      const options = { ...(body.options || {}), role: body.role || (body.options && body.options.role) || (host.role === 'agent' ? 'agent' : 'server') };
      const version = String(options.version || '').trim();
      if (!/^v\d+\.\d+\.\d+(?:[+\-][0-9A-Za-z.+_-]+)?$/.test(version)) {
        throw new HttpError(400, '请填写合法的 k3s 版本，例如 v1.31.4+k3s1');
      }
      const job = jobs.run('upgrade', '升级 k3s', { hostId: host.id }, (j) =>
        deploy.doUpgrade(j, ctx(), host, options)
      );
      return ok(res, { jobId: job.id }, 202);
    }

    if (action === 'uninstall' && method === 'POST') {
      const body = await readJson(req);
      if (!uninstallConfirmed(body.confirm)) throw new HttpError(400, '请输入“uninstall”以确认卸载');
      if (body.deepClean !== undefined && typeof body.deepClean !== 'boolean') {
        throw new HttpError(400, 'deepClean 必须是布尔值');
      }
      const job = jobs.run('uninstall', '卸载 Kubernetes', { hostId: host.id }, (j) =>
        deploy.doUninstall(j, ctx(), host, body)
      );
      return ok(res, { jobId: job.id }, 202);
    }

    if (action === 'overview' && method === 'GET') {
      const result = await kube.clusterOverview(host, ctx());
      return ok(res, result);
    }

    if (action === 'nodes' && method === 'GET') {
      const nodes = await kube.nodeList(host, ctx());
      return ok(res, { nodes, columns: kube.RESOURCES.nodes.columns });
    }

    if (action === 'kube-access' && method === 'GET') {
      const access = await kube.kubeAccess(host, ctx());
      return ok(res, access);
    }

    if (action === 'namespaces' && method === 'GET') {
      const namespaces = await kube.namespaceList(host, ctx());
      return ok(res, { namespaces });
    }

    if (action === 'resources' && method === 'GET') {
      const kind = url.searchParams.get('kind') || 'pods';
      const namespace = url.searchParams.get('namespace') || '';
      const result = await kube.listResources(host, kind, namespace, ctx());
      return ok(res, result);
    }

    if (action === 'resource' && method === 'GET') {
      const kind = url.searchParams.get('kind');
      const namespace = url.searchParams.get('namespace') || '';
      const name = url.searchParams.get('name');
      const yaml = await kube.getResourceYaml(host, kind, namespace, name, ctx());
      return ok(res, { yaml, kind, namespace, name });
    }

    if (action === 'resource' && method === 'DELETE') {
      const kind = url.searchParams.get('kind');
      const namespace = url.searchParams.get('namespace') || '';
      const name = url.searchParams.get('name');
      const result = await kube.deleteResource(host, kind, namespace, name, ctx());
      return ok(res, result);
    }

    if (action === 'apply' && method === 'POST') {
      const body = await readJson(req, 12 * 1024 * 1024);
      if (!body.yaml) throw new HttpError(400, '缺少 yaml 字段');
      const result = await kube.applyYaml(host, body.yaml, { ...ctx(), namespace: body.namespace, dryRun: body.dryRun });
      return ok(res, result);
    }

    if (action === 'scale' && method === 'POST') {
      const body = await readJson(req);
      const result = await kube.scaleResource(host, body.kind, body.namespace, body.name, body.replicas, ctx());
      return ok(res, result);
    }

    if (action === 'restart' && method === 'POST') {
      const body = await readJson(req);
      const result = await kube.restartResource(host, body.kind, body.namespace, body.name, ctx());
      return ok(res, result);
    }

    if (action === 'node-action' && method === 'POST') {
      const body = await readJson(req);
      const result = await kube.nodeAction(host, body.action, body.node, ctx());
      return ok(res, result);
    }

    if (action === 'logs' && method === 'GET') {
      const logs = await kube.podLogs(host, url.searchParams.get('namespace') || '', url.searchParams.get('pod'), {
        ...ctx(),
        container: url.searchParams.get('container') || '',
        tail: url.searchParams.get('tail') || 500,
        previous: url.searchParams.get('previous') === '1'
      });
      return ok(res, { logs });
    }

    if (action === 'shell' && method === 'POST') {
      const body = await readJson(req);
      const session = await terminals.open(kube, ctx(), host, body.namespace, body.pod, body.container);
      return ok(res, {
        sessionId: session.id,
        tty: session.tty,
        namespace: session.namespace,
        pod: session.pod,
        container: session.container
      }, 201);
    }

    if (action === 'ssh-shell' && method === 'POST') {
      if ((host.transport || 'ssh') !== 'ssh') throw new HttpError(400, '只有 SSH 接入方式支持远程终端');
      const session = await terminals.openHost(transport, host);
      return ok(res, {
        sessionId: session.id,
        sessionKind: session.kind,
        tty: session.tty,
        hostId: host.id,
        hostName: session.hostName
      }, 201);
    }

    if (action === 'describe' && method === 'GET') {
      const text = await kube.describeResource(host, url.searchParams.get('kind'), url.searchParams.get('namespace'), url.searchParams.get('name'), ctx());
      return ok(res, { text });
    }

    if (action === 'events' && method === 'GET') {
      const result = await kube.eventsFor(host, url.searchParams.get('namespace') || '', url.searchParams.get('name') || '', ctx());
      return ok(res, result);
    }

    if (action === 'top' && method === 'GET') {
      const result = await kube.topMetrics(host, ctx());
      return ok(res, result);
    }

    // /api/hosts/:id/nodes/:name/action
    if (action === 'node' && sub && method === 'POST') {
      const body = await readJson(req);
      const result = await kube.nodeAction(host, body.action, sub, ctx());
      return ok(res, result);
    }
  }

  if (parts[1] === 'deploy' && parts[2] === 'cluster' && method === 'POST') {
    const body = await readJson(req);
    const serverIds = (Array.isArray(body.serverIds) ? body.serverIds : (body.masterId ? [body.masterId] : []))
      .map((id) => String(id).trim())
      .filter(Boolean);
    if (![1, 3, 5].includes(serverIds.length)) throw new HttpError(400, '控制平面数量必须是 1 台（单机）、3 台或 5 台（高可用）');
    if (new Set(serverIds).size !== serverIds.length) throw new HttpError(400, '控制平面节点不能重复');

    const agentIds = (Array.isArray(body.agentIds) ? body.agentIds : [])
      .map((id) => String(id).trim())
      .filter((id) => id && !serverIds.includes(id));
    if (new Set(agentIds).size !== agentIds.length) throw new HttpError(400, '工作节点不能重复');

    const servers = serverIds.map((id) => serverStore.host(id));
    const agents = agentIds.map((id) => serverStore.host(id));
    for (const host of [...servers, ...agents]) {
      if ((host.transport || 'ssh') === 'kubeconfig') throw new HttpError(400, 'kubeconfig 模式主机不能作为部署目标');
    }
    const endpoints = [...servers, ...agents].map((h) => `${h.host}:${h.port || 22}`);
    const duplicateEndpoint = endpoints.find((endpoint, index) => endpoints.indexOf(endpoint) !== index);
    if (duplicateEndpoint) throw new HttpError(400, `部署目标重复：${duplicateEndpoint}，同一台机器不能重复选择`);

    const title = serverIds.length === 1 ? '部署 k3s 单机集群' : '部署 k3s 高可用集群';
    const job = jobs.run('deploy', title, { serverIds, agentIds }, (j) =>
      deploy.doClusterDeploy(j, ctx(), { serverIds, agentIds, options: body.options || {} })
    );
    return ok(res, { jobId: job.id }, 202);
  }

  if (parts[1] === 'uninstall' && parts.length === 2 && method === 'POST') {
    const body = await readJson(req);
    if (!uninstallConfirmed(body.confirm)) throw new HttpError(400, '请输入“uninstall”以确认卸载');
    if (body.deepClean !== undefined && typeof body.deepClean !== 'boolean') {
      throw new HttpError(400, 'deepClean 必须是布尔值');
    }
    const hostIds = (Array.isArray(body.hostIds) ? body.hostIds : [])
      .map((id) => String(id).trim())
      .filter(Boolean);
    if (!hostIds.length) throw new HttpError(400, '请至少选择一台要卸载的服务器');
    if (hostIds.length > 10) throw new HttpError(400, '一次最多卸载 10 台服务器');
    if (new Set(hostIds).size !== hostIds.length) throw new HttpError(400, '卸载目标不能重复');
    const hosts = hostIds.map((id) => serverStore.host(id));
    for (const host of hosts) {
      if ((host.transport || 'ssh') === 'kubeconfig') throw new HttpError(400, 'kubeconfig 模式主机不能直接卸载');
    }
    const title = hosts.length === 1 ? '卸载 Kubernetes' : '批量卸载 Kubernetes';
    const job = jobs.run('uninstall', title, { hostIds }, (j) =>
      deploy.doUninstallHosts(j, ctx(), hosts, { ...body, hostIds })
    );
    return ok(res, { jobId: job.id, hostIds }, 202);
  }

  // 镜像 tar 导入：先建任务拿 uploadUrl，再一次性把文件 POST 过来；服务端只存一份，逐台分发。
  if (parts[1] === 'images' && parts[2] === 'import' && parts[3] === 'upload' && method === 'POST') {
    const jobId = url.searchParams.get('job') || '';
    const job = jobs.get(jobId);
    if (job.type !== 'image-import') throw new HttpError(400, '操作类型不匹配，无法上传镜像 tar');
    if (job.status !== 'running') throw new HttpError(409, '该导入任务已结束，请重新发起导入');
    const entry = takeImageImport(jobId);
    if (!entry) throw new HttpError(409, '该导入任务已开始上传，请勿重复提交');
    const result = await runImageImport(req, job, entry);
    return ok(res, result, 201);
  }

  if (parts[1] === 'images' && parts[2] === 'import' && parts.length === 3 && method === 'POST') {
    const body = await readJson(req);
    const hostIds = (Array.isArray(body.hostIds) ? body.hostIds : [])
      .map((id) => String(id).trim())
      .filter(Boolean);
    if (!hostIds.length) throw new HttpError(400, '请至少选择一台要导入的服务器');
    if (hostIds.length > 20) throw new HttpError(400, '一次最多导入到 20 台服务器');
    if (new Set(hostIds).size !== hostIds.length) throw new HttpError(400, '导入目标不能重复');
    const hosts = hostIds.map((id) => serverStore.host(id));
    for (const item of hosts) {
      if ((item.transport || 'ssh') !== 'ssh') {
        throw new HttpError(400, `${item.name || item.id} 不是 SSH 接入方式，无法导入镜像 tar`);
      }
    }
    const fileName = String(body.name || '').trim();
    if (!/\.tar$/i.test(fileName)) throw new HttpError(400, '请选择 .tar 格式的镜像包');
    const remoteName = `k3s-import-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.tar`;
    const total = Number(body.size) || 0;
    const title = hosts.length > 1 ? '批量导入镜像' : '导入镜像';
    const job = jobs.create('image-import', title, { hostIds });
    job.log(`目标服务器（${hosts.length} 台）：${hosts.map((item) => item.name || item.id).join('、')}`);
    job.log(`镜像包：${fileName}${total ? `（${formatBytesText(total)}）` : ''}`);
    rememberImageImport(job, hosts, fileName, remoteName);
    return ok(res, {
      jobId: job.id,
      uploadUrl: `/api/images/import/upload?job=${encodeURIComponent(job.id)}`,
      name: remoteName,
      total,
      hostIds
    }, 202);
  }

  if (parts[1] === 'jobs') {
    if (parts.length === 2 && method === 'GET') return ok(res, { jobs: jobs.list() });
    // 删除全部操作记录（含导出的 tar 缓存）；有任务在执行时不允许删
    if (parts.length === 2 && method === 'DELETE') {
      const running = jobs.list().filter((job) => job.status === 'running' || job.status === 'cancelling');
      if (running.length) {
        throw new HttpError(409, `还有 ${running.length} 个任务正在执行，请先取消或等待完成后再删除`);
      }
      const all = [];
      for (const item of jobs.list()) {
        try { all.push(jobs.get(item.id)); } catch (_) { /* 记录文件已不存在，跳过 */ }
      }
      const removedFiles = deleteJobTmpFiles(all);
      jobs.clearAll();
      return ok(res, { deleted: true, files: removedFiles });
    }
    if (parts.length === 3 && method === 'GET') {
      const job = jobs.get(parts[2]);
      return ok(res, { job: job.toJSON() });
    }
    // 删除单条操作记录（含该记录导出的 tar 缓存）
    if (parts.length === 3 && method === 'DELETE') {
      const job = jobs.get(parts[2]);
      if (job.status === 'running' || job.status === 'cancelling') {
        throw new HttpError(409, '任务正在执行，请先取消或等待完成后再删除');
      }
      deleteJobTmpFiles([job]);
      jobs.remove(job.id);
      return ok(res, { deleted: true });
    }
    if (parts.length === 4 && parts[3] === 'stream' && method === 'GET') {
      const job = jobs.get(parts[2]);
      return streamJob(req, res, job);
    }
    if (parts.length === 4 && parts[3] === 'cancel' && method === 'POST') {
      const job = jobs.get(parts[2]);
      const cancelled = job.abort();
      return ok(res, { cancelled });
    }
    if (parts.length === 4 && parts[3] === 'download' && method === 'GET') {
      const job = jobs.get(parts[2]);
      const result = job.result || {};
      const localPath = String(result.file || '');
      if (result.fileMissing && !result.file) throw new HttpError(410, 'tar 已被清理，如需使用请重新导出');
      if (result.downloadedAt) throw new HttpError(409, '该 tar 已下载过，控制端临时文件已清理；如需再用请重新导出');
      if (job.status !== 'success' || !localPath) throw new HttpError(409, '该操作还没有可下载的文件');
      const base = path.resolve(EXPORT_TMP_DIR);
      const resolved = path.resolve(localPath);
      if (!resolved.startsWith(base + path.sep)) throw new HttpError(400, '文件路径不合法');
      let stats;
      try {
        stats = fs.statSync(resolved);
      } catch (_) {
        throw new HttpError(404, '文件已被清理，请重新导出');
      }
      if (!stats.isFile()) throw new HttpError(404, '文件已被清理，请重新导出');
      const name = String(result.name || path.basename(resolved)).replace(/["\\\r\n]/g, '_');
      res.writeHead(200, {
        'Content-Type': 'application/x-tar',
        'Content-Length': stats.size,
        'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        'Cache-Control': 'no-store'
      });
      await new Promise((resolve) => {
        const stream = fs.createReadStream(resolved);
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          try { stream.destroy(); } catch (_) { /* ignore */ }
          resolve();
        };
        stream.on('error', () => { try { res.end(); } catch (_) { /* ignore */ } done(); });
        stream.on('close', done);
        res.on('close', done);
        stream.pipe(res);
      });
      // tar 只提供一次下载：发完即删除控制端副本，避免 logs/tmp 里越堆越多。
      // 删除失败时保留路径，窗口里仍可重试下载。
      let removed = true;
      try {
        fs.rmSync(resolved, { force: true });
      } catch (_) {
        removed = false;
        setTimeout(() => { try { fs.rmSync(resolved, { force: true }); } catch (_) { /* ignore */ } }, 500);
      }
      try {
        jobs.save(job, {
          file: removed ? null : resolved,
          fileRemoved: removed,
          downloadedAt: new Date().toISOString()
        });
      } catch (_) { /* ignore */ }
      return;
    }
  }

  throw new HttpError(404, `接口不存在：${req.method} ${url.pathname}`);
}

function streamJob(req, res, job) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  let cleaned = false;
  const send = (payload) => {
    if (res.writableEnded || res.destroyed) return false;
    try {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      return true;
    } catch (_) {
      return false;
    }
  };
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearInterval(heartbeat);
    job.off('event', onEvent);
    req.off('close', cleanup);
    req.off('error', cleanup);
    res.off('close', cleanup);
    if (!res.writableEnded) {
      try { res.end(); } catch (_) { /* ignore */ }
    }
  };
  const onEvent = (payload) => {
    if (!send(payload)) {
      cleanup();
      return;
    }
    if (payload && payload.type === 'end') setTimeout(cleanup, 50);
  };
  const heartbeat = setInterval(() => {
    if (res.writableEnded || res.destroyed) return cleanup();
    try { res.write(': keepalive\n\n'); } catch (_) { cleanup(); }
  }, 15000);

  const isActive = () => job.status === 'running' || job.status === 'cancelling';

  if (!send({ type: 'snapshot', job: job.toJSON() })) {
    cleanup();
    return;
  }
  if (!isActive()) {
    send({ type: 'end', job: job.toJSON() });
    cleanup();
    return;
  }

  job.on('event', onEvent);
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('close', cleanup);
  // job 可能在初始快照和监听器绑定之间结束，补发一次最终状态，避免 SSE 悬挂。
  if (!isActive()) {
    send({ type: 'end', job: job.toJSON() });
    cleanup();
  }
}

const WEB_JS_FILES = [
  '01-core.js',
  '02-shell.js',
  '03-demo.js',
  '04-dashboard.js',
  '04a-terminal.js',
  '05-hosts.js',
  '05a-sftp.js',
  '06-install.js',
  '07-cluster.js',
  '08-workloads.js',
  '09-deploy.js',
  '10-records-settings.js',
  '11-main.js'
];

const STATIC_FILES = new Map([
  ['/index.html', { rel: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/web/app.css', { rel: path.join('web', 'app.css'), type: 'text/css; charset=utf-8' }],
  ['/web/vendor/js-yaml.min.js', { rel: path.join('web', 'vendor', 'js-yaml.min.js'), type: 'application/javascript; charset=utf-8' }],
  ['/web/vendor/xterm/xterm.js', { rel: path.join('web', 'vendor', 'xterm', 'xterm.js'), type: 'application/javascript; charset=utf-8' }],
  ['/web/vendor/xterm/addon-fit.js', { rel: path.join('web', 'vendor', 'xterm', 'addon-fit.js'), type: 'application/javascript; charset=utf-8' }],
  ['/web/vendor/xterm/xterm.css', { rel: path.join('web', 'vendor', 'xterm', 'xterm.css'), type: 'text/css; charset=utf-8' }],
  ...WEB_JS_FILES.map((name) => [`/web/js/${name}`, { rel: path.join('web', 'js', name), type: 'application/javascript; charset=utf-8' }])
]);

function serveStatic(req, res, url) {
  let pathname = url.pathname;
  if (pathname === '/' || pathname === '') pathname = '/index.html';
  if (pathname === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  const asset = STATIC_FILES.get(pathname);
  if (!asset) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const file = path.join(ROOT, asset.rel);
  fs.readFile(file, (err, data) => {
    if (res.writableEnded || res.destroyed) return;
    if (err) {
      try {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`${asset.rel} 读取失败：${err.message}`);
      } catch (_) { /* 客户端可能已断开 */ }
      return;
    }
    try {
      res.writeHead(200, {
        'Content-Type': asset.type,
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      });
      res.end(data);
    } catch (_) { /* 客户端可能已断开 */ }
  });
}

const server = http.createServer(async (req, res) => {
  const started = Date.now();
  // 客户端可能在响应写入过程中断开；吞掉响应流错误，避免进程级未捕获异常。
  res.on('error', () => { /* ignore */ });
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  } catch (_) {
    res.writeHead(400);
    res.end('Bad Request');
    return;
  }

  res.on('finish', () => {
    const quiet = url.pathname.endsWith('/stream') || url.pathname.endsWith('/input') || url.pathname.endsWith('/resize');
    if (url.pathname.startsWith('/api/') && url.pathname !== '/api/jobs/' && !quiet) {
      console.log(`[${new Date().toISOString()}] ${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  if (!url.pathname.startsWith('/api/')) {
    serveStatic(req, res, url);
    return;
  }

  try {
    if (!tokenValid(req, url)) {
      throw new HttpError(401, '访问令牌无效或缺失，请在页面右上角输入访问令牌');
    }
    await handleApi(req, res, url);
  } catch (err) {
    if (res.headersSent) {
      try { res.end(); } catch (_) { /* ignore */ }
      return;
    }
    fail(res, err);
  }
});

server.on('clientError', (err, socket) => {
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
});

const appConfig = store.get().app || {};
const host = appConfig.host || '127.0.0.1';
const port = Number(appConfig.port || 8964);

server.listen(port, host, () => {
  const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  console.log('');
  console.log(`  ${store.title}  v${VERSION}`);
  console.log(`  ➜  控制台：http://${shown}:${port}`);
  console.log(`  ➜  配置：  ${CONFIG_FILE}`);
  console.log(`  ➜  数据：  ${DATA_DIR}`);
  console.log(`  ➜  模板：  ${TEMPLATES_DIR}`);
  console.log(`  ➜  日志：  ${LOGS_DIR}`);
  console.log(`  ➜  ssh2：  ${hasSsh2() ? '已就绪' : '未安装（SSH 功能不可用）'}`);
  if (appConfig.accessToken) console.log('  ➜  已启用访问令牌');
  console.log('');
  try { pruneExportTmp(); } catch (_) { /* ignore */ }
  try { reconcileExportRecords(); } catch (_) { /* ignore */ }
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用，请修改根目录 config.json 中的 app.port`);
  } else {
    console.error('服务启动失败：', err.message);
  }
  process.exit(1);
});

function shutdown() {
  console.log('\n正在关闭…');
  transport.dispose();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
