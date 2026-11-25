'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync, spawn } = require('child_process');
const { Worker } = require('worker_threads');

const REPO_DIR = path.join(__dirname, '..', '..', 'packages');
const PACKAGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function normalizeArch(value) {
  const text = String(value || '').toLowerCase();
  if (text === 'x86_64' || text === 'amd64' || text === 'x64') return 'amd64';
  if (text === 'aarch64' || text === 'arm64') return 'arm64';
  if (text === 'armv7l' || text === 'armv6l' || text === 'armhf' || text === 'arm') return 'armhf';
  return text;
}

function archFileNames(value) {
  const arch = normalizeArch(value);
  if (!arch) return [];
  const names = [arch];
  if (arch === 'amd64') names.push('x86_64');
  if (arch === 'armhf') names.push('arm');
  return names;
}

function displayArch(value) {
  const arch = normalizeArch(value);
  if (arch === 'amd64') return 'x86_64 / amd64';
  if (arch === 'arm64') return 'aarch64 / arm64';
  if (arch === 'armhf') return 'armv7l / armhf';
  return arch || '未知';
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch (_) {
    return null;
  }
}

function runTar(args, timeout = 60000) {
  const result = spawnSync('tar', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout,
    windowsHide: true
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = String(result.stderr || '').trim();
    throw new Error(detail || `tar 退出码 ${result.status}`);
  }
  return String(result.stdout || '');
}

// 解压可能持续很久，用子进程异步执行，避免阻塞 HTTP/SSE。
function runTarAsync(args, timeout = 600000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let stderr = '';
    let child;
    let timer = null;
    try {
      child = spawn('tar', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    const finish = (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (err) reject(err);
      else resolve();
    };
    timer = setTimeout(() => {
      const err = new Error(`tar 执行超时（${timeout}ms）`);
      finish(err);
      try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
    }, timeout);
    child.stdout.on('data', () => { /* 解压不需要标准输出，持续 drain */ });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 1024 * 1024) stderr += chunk.toString();
    });
    child.on('error', finish);
    child.on('close', (code) => {
      if (code !== 0) finish(new Error(stderr.trim() || `tar 退出码 ${code}`));
      else finish(null);
    });
  });
}

function archivePackageId(fileName) {
  const name = String(fileName || '');
  if (!/\.(?:tar\.gz|tgz)$/i.test(name)) return '';
  const id = name.replace(/\.(?:tar\.gz|tgz)$/i, '');
  return PACKAGE_ID_RE.test(id) ? id : '';
}

function archiveMemberNames(archive) {
  const raw = runTar(['-tzf', archive], 120000)
    .split(/\r?\n/)
    .map((name) => name.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter(Boolean);
  const files = raw.filter((name) => !name.endsWith('/'));
  const unsafe = files.find((name) => name.startsWith('/') || name.split('/').includes('..'));
  if (unsafe) throw new Error(`归档包含不安全路径：${unsafe}`);
  const first = files[0] || '';
  const top = first.includes('/') ? first.split('/')[0] : '';
  const allUnderTop = !!top && files.every((name) => name === top || name.startsWith(`${top}/`));
  const prefix = allUnderTop ? `${top}/` : '';
  const members = Array.from(new Set(files.map((name) => (prefix && name.startsWith(prefix) ? name.slice(prefix.length) : name))));
  return { top, prefix, members };
}

function readArchiveFile(archive, prefix, name) {
  return runTar(['-xOf', archive, `${prefix}${name}`], 60000);
}

function fileInfo(dir, name) {
  try {
    const stat = fs.statSync(path.join(dir, name));
    if (!stat.isFile()) return null;
    return { name, size: stat.size, mtimeMs: stat.mtimeMs };
  } catch (_) {
    return null;
  }
}

function firstExisting(dir, names) {
  for (const name of names) {
    const info = fileInfo(dir, name);
    if (info) return info;
  }
  return null;
}

function findBinary(dir, arch) {
  const candidates = ['k3s'];
  for (const name of archFileNames(arch)) candidates.push(`k3s-${name}`);
  return firstExisting(dir, candidates);
}

function findImage(dir, arch) {
  const candidates = [];
  for (const name of archFileNames(arch)) {
    candidates.push(
      `k3s-airgap-images-${name}.tar`,
      `k3s-airgap-images-${name}.tar.gz`,
      `k3s-airgap-images-${name}.tar.zst`
    );
  }
  candidates.push(
    'k3s-airgap-images.tar',
    'k3s-airgap-images.tar.gz',
    'k3s-airgap-images.tar.zst'
  );
  return firstExisting(dir, candidates);
}

function inferArch(dirName, manifest, image, binary) {
  if (manifest && manifest.arch) return normalizeArch(manifest.arch);
  const fromName = dirName.match(/[-_](amd64|x86_64|arm64|aarch64|armhf|armv7l|armv6l|arm)(?:$|[-_.])/i);
  if (fromName) return normalizeArch(fromName[1]);
  if (image) {
    const match = image.name.match(/airgap-images-([a-z0-9_]+)\.tar(?:\.(?:gz|zst))?/i);
    if (match) return normalizeArch(match[1]);
  }
  if (binary) {
    const match = binary.name.match(/^k3s-(.+)$/);
    if (match) return normalizeArch(match[1]);
  }
  return '';
}

function inferVersion(dirName, manifest) {
  if (manifest && manifest.k3sVersion) return String(manifest.k3sVersion).trim();
  if (manifest && manifest.version) return String(manifest.version).trim();
  const match = dirName.match(/v(\d+\.\d+\.\d+)(?:[-+]k3s(\d+))?/);
  if (!match) return '';
  return `v${match[1]}${match[2] ? `+k3s${match[2]}` : ''}`;
}

function signatureOf(files, manifest, checksums) {
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file.name);
    hash.update('\0');
    hash.update(String(file.size));
    hash.update('\0');
  }
  if (manifest) hash.update(JSON.stringify(manifest));
  if (checksums) hash.update(checksums);
  return hash.digest('hex').slice(0, 16);
}

function archiveSignature(id, stat, checksumText) {
  return crypto
    .createHash('sha256')
    .update('archive\0')
    .update(id)
    .update('\0')
    .update(String(stat.size))
    .update('\0')
    .update(String(stat.mtimeMs))
    .update('\0')
    .update(checksumText || '')
    .digest('hex')
    .slice(0, 16);
}

function invalidArchivePackage(archive, id, err) {
  let size = 0;
  let mtimeMs = 0;
  try {
    const stat = fs.statSync(archive);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch (_) { /* ignore */ }
  const version = inferVersion(id, null);
  const arch = inferArch(id, null, null, null);
  return {
    id,
    version,
    arch,
    archLabel: displayArch(arch),
    valid: false,
    issues: [`无法读取归档：${err.message}`],
    size,
    files: [],
    binary: '',
    image: '',
    installer: '',
    hasChecksums: false,
    signature: archiveSignature(id, { size, mtimeMs }, ''),
    manifest: null,
    dir: null,
    archive,
    strip: 0
  };
}

function inspectArchive(archive, id) {
  let names;
  try {
    names = archiveMemberNames(archive);
  } catch (err) {
    return invalidArchivePackage(archive, id, err);
  }
  const memberSet = new Set(names.members);
  const memberInfo = (name) => (memberSet.has(name) ? { name, size: 0, mtimeMs: 0 } : null);
  const firstMember = (candidates) => candidates.map(memberInfo).find(Boolean) || null;

  let manifest = null;
  if (memberSet.has('manifest.json')) {
    try {
      manifest = JSON.parse(readArchiveFile(archive, names.prefix, 'manifest.json').replace(/^\uFEFF/, ''));
    } catch (_) {
      manifest = null;
    }
  }

  const initialArch = inferArch(id, manifest, null, null);
  let binary = firstMember(['k3s', ...archFileNames(initialArch).map((name) => `k3s-${name}`)]);
  const imageCandidates = [];
  for (const archName of archFileNames(initialArch)) {
    imageCandidates.push(
      `k3s-airgap-images-${archName}.tar`,
      `k3s-airgap-images-${archName}.tar.gz`,
      `k3s-airgap-images-${archName}.tar.zst`
    );
  }
  imageCandidates.push('k3s-airgap-images.tar', 'k3s-airgap-images.tar.gz', 'k3s-airgap-images.tar.zst');
  let image = firstMember(imageCandidates);
  let arch = inferArch(id, manifest, image, binary);
  if (!arch) {
    for (const name of names.members) {
      const imageMatch = name.match(/^k3s-airgap-images-([A-Za-z0-9_]+)\.tar(?:\.(?:gz|zst))?$/);
      if (imageMatch) {
        arch = normalizeArch(imageMatch[1]);
        break;
      }
      const binaryMatch = name.match(/^k3s-([A-Za-z0-9_]+)$/);
      if (binaryMatch) {
        arch = normalizeArch(binaryMatch[1]);
        break;
      }
    }
  }
  if (!binary && arch) {
    binary = firstMember(['k3s', ...archFileNames(arch).map((name) => `k3s-${name}`)]);
  }
  if (!image && arch) {
    image = firstMember(archFileNames(arch).flatMap((name) => [
      `k3s-airgap-images-${name}.tar`,
      `k3s-airgap-images-${name}.tar.gz`,
      `k3s-airgap-images-${name}.tar.zst`
    ]));
  }
  const installer = memberInfo('install.sh');
  const checksums = memberInfo('SHA256SUMS');
  const version = inferVersion(id, manifest);
  const stat = fs.statSync(archive);

  const required = [binary, image, installer].filter(Boolean);
  const issues = [];
  if (!version) issues.push('缺少版本号（manifest.json 的 k3sVersion 或包名中的 vX.Y.Z）');
  if (!arch) issues.push('缺少 CPU 架构（manifest.json 的 arch、包名或镜像名）');
  if (!binary) issues.push('缺少 k3s 二进制');
  if (!image) issues.push('缺少 k3s-airgap-images-<arch>.tar 镜像包（也支持 .tar.gz / .tar.zst）');
  if (!installer) issues.push('缺少 install.sh');

  let checksumText = '';
  let checksumReadError = '';
  if (checksums) {
    try {
      checksumText = readArchiveFile(archive, names.prefix, 'SHA256SUMS');
    } catch (err) {
      checksumReadError = err.message;
    }
  }

  const checksummedFiles = [];
  const malformedChecksums = [];
  for (const line of checksumText.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const match = text.match(/^[0-9a-fA-F]{64}\s+\*?(.+)$/);
    if (!match) continue;
    const name = match[1].trim().replace(/^\.\//, '');
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
      malformedChecksums.push(name || '(空文件名)');
      continue;
    }
    const info = memberInfo(name);
    if (!info) {
      issues.push(`SHA256SUMS 引用的文件缺失：${name}`);
    } else {
      checksummedFiles.push(info);
    }
  }
  if (checksumReadError) issues.push(`无法读取 SHA256SUMS：${checksumReadError}`);
  if (malformedChecksums.length) issues.push(`SHA256SUMS 包含不安全的文件名：${malformedChecksums.slice(0, 3).join('、')}`);

  const files = [...required];
  const manifestInfo = memberInfo('manifest.json');
  if (manifestInfo) files.push(manifestInfo);
  if (checksums) files.push(checksums);
  files.push(...checksummedFiles);
  const fileMap = new Map(files.map((file) => [file.name, file]));

  return {
    id,
    version,
    arch,
    archLabel: displayArch(arch),
    valid: issues.length === 0,
    issues,
    size: stat.size,
    files: Array.from(fileMap.values()).map((file) => file.name),
    binary: binary ? binary.name : '',
    image: image ? image.name : '',
    installer: installer ? installer.name : '',
    hasChecksums: !!checksums,
    signature: archiveSignature(id, stat, checksumText),
    manifest: manifest || null,
    dir: null,
    archive,
    strip: names.prefix ? 1 : 0
  };
}

const archiveCache = new Map();

function inspectArchiveCached(archive, id) {
  let stat;
  try {
    stat = fs.statSync(archive);
  } catch (err) {
    return invalidArchivePackage(archive, id, err);
  }
  const key = `${archive}\0${stat.size}\0${stat.mtimeMs}`;
  const hit = archiveCache.get(archive);
  if (hit && hit.key === key && hit.id === id) return hit.pkg;
  let pkg;
  try {
    pkg = inspectArchive(archive, id);
  } catch (err) {
    pkg = invalidArchivePackage(archive, id, err);
  }
  archiveCache.set(archive, { key, id, pkg });
  return pkg;
}

function inspectPackage(dir, id) {
  const manifest = readJson(path.join(dir, 'manifest.json'));
  const entries = (() => {
    try {
      return fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      return [];
    }
  })();
  const initialArch = inferArch(id, manifest, null, null);
  let binary = findBinary(dir, initialArch);
  let arch = inferArch(id, manifest, findImage(dir, initialArch), binary);
  if (!arch) {
    for (const entry of entries) {
      const imageMatch = entry.name.match(/^k3s-airgap-images-([A-Za-z0-9_]+)\.tar(?:\.(?:gz|zst))?$/);
      if (imageMatch) {
        arch = normalizeArch(imageMatch[1]);
        break;
      }
      const binaryMatch = entry.name.match(/^k3s-([A-Za-z0-9_]+)$/);
      if (binaryMatch) {
        arch = normalizeArch(binaryMatch[1]);
        break;
      }
    }
  }
  if (!binary && arch) binary = findBinary(dir, arch);
  const image = findImage(dir, arch);
  const installer = fileInfo(dir, 'install.sh');
  const checksums = fileInfo(dir, 'SHA256SUMS');
  const version = inferVersion(id, manifest);

  const required = [binary, image, installer].filter(Boolean);
  const issues = [];
  if (!version) issues.push('缺少版本号（manifest.json 的 k3sVersion 或目录名中的 vX.Y.Z）');
  if (!arch) issues.push('缺少 CPU 架构（manifest.json 的 arch 或目录名）');
  if (!binary) issues.push('缺少 k3s 二进制');
  if (!image) issues.push('缺少 k3s-airgap-images-<arch>.tar 镜像包（也支持 .tar.gz / .tar.zst）');
  if (!installer) issues.push('缺少 install.sh');

  let checksumText = '';
  if (checksums) {
    try {
      checksumText = fs.readFileSync(path.join(dir, checksums.name), 'utf8');
    } catch (_) {
      checksumText = '';
    }
  }

  // SHA256SUMS may cover more than the three required files (README, helper scripts).
  // Upload every covered file so the target-side `sha256sum -c` can pass.
  const checksummedFiles = [];
  const malformedChecksums = [];
  for (const line of checksumText.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const match = text.match(/^[0-9a-fA-F]{64}\s+\*?(.+)$/);
    if (!match) continue;
    const name = match[1].trim().replace(/^\.\//, '');
    if (!name || name.includes('/') || name.includes('\\') || name.includes('..')) {
      malformedChecksums.push(name || '(空文件名)');
      continue;
    }
    const info = fileInfo(dir, name);
    if (!info) {
      issues.push(`SHA256SUMS 引用的文件缺失：${name}`);
    } else {
      checksummedFiles.push(info);
    }
  }
  if (malformedChecksums.length) issues.push(`SHA256SUMS 包含不安全的文件名：${malformedChecksums.slice(0, 3).join('、')}`);

  const files = [...required];
  const manifestInfo = fileInfo(dir, 'manifest.json');
  if (manifestInfo) files.push(manifestInfo);
  if (checksums) files.push(checksums);
  files.push(...checksummedFiles);
  const fileMap = new Map(files.map((file) => [file.name, file]));
  const valid = issues.length === 0;

  return {
    id,
    version,
    arch,
    archLabel: displayArch(arch),
    valid,
    issues,
    size: Array.from(fileMap.values()).reduce((sum, file) => sum + file.size, 0),
    files: Array.from(fileMap.values()).map((file) => file.name),
    binary: binary ? binary.name : '',
    image: image ? image.name : '',
    installer: installer ? installer.name : '',
    hasChecksums: !!checksums,
    signature: signatureOf(Array.from(fileMap.values()), manifest, checksumText),
    manifest: manifest || null,
    dir
  };
}

function listPackages(root = REPO_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  const packages = [];
  const packageIds = new Set();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!PACKAGE_ID_RE.test(entry.name)) continue;
    if (entry.name.startsWith('.')) continue;
    const dir = path.join(root, entry.name);
    const pkg = inspectPackage(dir, entry.name);
    // Directories without any k3s artifacts are not packages (e.g. docs or tooling).
    if (!pkg.binary && !pkg.image && !pkg.installer) continue;
    packages.push(pkg);
    packageIds.add(entry.name);
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const id = archivePackageId(entry.name);
    if (!id || packageIds.has(id)) continue;
    packages.push(inspectArchiveCached(path.join(root, entry.name), id));
    packageIds.add(id);
  }
  packages.sort((a, b) => {
    if (a.valid !== b.valid) return a.valid ? -1 : 1;
    const av = a.version || '';
    const bv = b.version || '';
    return bv.localeCompare(av, undefined, { numeric: true });
  });
  return packages;
}

let packagesWorker = null;
let packagesWorkerSeq = 0;
const packagesWorkerPending = new Map();

function failPackagesWorker(worker, err) {
  if (packagesWorker === worker) packagesWorker = null;
  for (const [id, call] of packagesWorkerPending) {
    clearTimeout(call.timer);
    packagesWorkerPending.delete(id);
    call.reject(err);
  }
}

function ensurePackagesWorker() {
  if (packagesWorker) return packagesWorker;
  const worker = new Worker(path.join(__dirname, 'offline-worker.js'));
  worker.unref();
  worker.on('message', (message) => {
    const call = packagesWorkerPending.get(message && message.id);
    if (!call) return;
    packagesWorkerPending.delete(message.id);
    clearTimeout(call.timer);
    if (message.ok) call.resolve(message.packages || []);
    else call.reject(new Error(message.error || '离线包检查失败'));
  });
  worker.on('error', (err) => failPackagesWorker(worker, err));
  worker.on('exit', (code) => {
    if (packagesWorkerPending.size) {
      failPackagesWorker(worker, new Error(`离线包检查进程已退出（${code}）`));
    } else if (packagesWorker === worker) {
      packagesWorker = null;
    }
  });
  packagesWorker = worker;
  return worker;
}

// 归档检查要调用 tar 子进程，放到常驻 worker 中执行，避免阻塞主线程的 HTTP/SSE。
function listPackagesAsync(root = REPO_DIR) {
  if (typeof Worker !== 'function') return Promise.resolve(listPackages(root));
  const worker = ensurePackagesWorker();
  const id = ++packagesWorkerSeq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const call = packagesWorkerPending.get(id);
      if (!call) return;
      packagesWorkerPending.delete(id);
      try { worker.terminate(); } catch (_) { /* ignore */ }
      if (packagesWorker === worker) packagesWorker = null;
      reject(new Error('离线包检查超时'));
    }, 180000);
    packagesWorkerPending.set(id, { resolve, reject, timer });
    try {
      worker.postMessage({ id, root });
    } catch (err) {
      packagesWorkerPending.delete(id);
      clearTimeout(timer);
      reject(err);
    }
  });
}

function getPackage(id, root = REPO_DIR) {
  const safe = String(id || '').trim();
  if (!PACKAGE_ID_RE.test(safe)) return null;
  const dir = path.join(root, safe);
  try {
    if (fs.statSync(dir).isDirectory()) {
      const pkg = inspectPackage(dir, safe);
      if (pkg.binary || pkg.image || pkg.installer) return pkg;
    }
  } catch (_) { /* try archives */ }
  for (const name of [`${safe}.tar.gz`, `${safe}.tgz`]) {
    const archive = path.join(root, name);
    try {
      if (fs.statSync(archive).isFile()) return inspectArchiveCached(archive, safe);
    } catch (_) { /* next */ }
  }
  return null;
}

async function materializePackage(pkg) {
  if (!pkg || !pkg.archive) throw new Error('该离线包不是归档格式，无需解压');
  const archive = pkg.archive;
  let stat;
  try {
    stat = fs.statSync(archive);
  } catch (_) {
    throw new Error(`离线归档不存在：${archive}`);
  }
  if (!stat.isFile()) throw new Error(`离线归档不是文件：${archive}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'k3s-ui-offline-'));
  const args = ['-xzf', archive, '-C', tmp];
  if (pkg.strip) args.push('--strip-components=1');
  try {
    await runTarAsync(args, 600000);
  } catch (err) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    throw new Error(`本地解压离线归档失败：${err.message}`);
  }
  return {
    dir: tmp,
    cleanup() {
      try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  };
}

module.exports = {
  REPO_DIR,
  normalizeArch,
  displayArch,
  listPackages,
  listPackagesAsync,
  getPackage,
  materializePackage
};
