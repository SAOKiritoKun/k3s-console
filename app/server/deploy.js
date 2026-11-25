'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { HttpError, sq, parseSections, sleep, formatError } = require('./util');
const kube = require('./kube');
const inspect = require('./inspect');
const offline = require('./offline');

function asArray(value) {
  if (Array.isArray(value)) return value.map((v) => String(v).trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return [String(value).trim()].filter(Boolean);
}

function hostLabel(host) {
  return `${host.name || host.id} (${host.host || host.id})`;
}

function hostMatches(host, id) {
  return host.id === id;
}

function findHost(ctx, id, label = '主机') {
  const host = (ctx.servers || []).find((item) => hostMatches(item, id));
  if (!host) throw new HttpError(404, `找不到${label}：${id}`);
  return host;
}

function k3sApiPort(ctx) {
  return Number((ctx.config.k3s && ctx.config.k3s.apiPort) || 6443);
}

function resolveMaster(ctx, agent, options) {
  if (options.masterId) return findHost(ctx, options.masterId, '主节点');
  const candidates = (ctx.servers || []).filter((h) => h.id !== agent.id);
  const byUrl = candidates.find((host) => {
    const url = (agent.k3s && agent.k3s.serverUrl) || '';
    if (!url) return false;
    try {
      const u = new URL(url);
      return u.hostname === host.host || u.hostname === (host.ip || '');
    } catch (_) {
      return false;
    }
  });
  if (byUrl) return byUrl;
  const byRole = candidates.find((host) => host.role === 'server');
  if (byRole) return byRole;
  throw new HttpError(400, '需要指定主节点（masterId）');
}

/** 这台控制平面的 kubectl 里能不能看到指定节点（即：它在不在这台节点所在的集群里）。 */
async function masterSeesNode(ctx, master, nodeName) {
  if (!nodeName) return false;
  try {
    const nodes = await kube.nodeList(master, { config: ctx.config, transport: ctx.transport, timeout: 20000 });
    const needle = String(nodeName).trim().toLowerCase();
    return (nodes || []).some((node) => String(node.name || '').trim().toLowerCase() === needle);
  } catch (_) {
    return false;
  }
}

/**
 * 升级工作节点时用来查 kubectl 的控制平面，必须和这台节点属于同一集群。
 * 选错集群时升级脚本照样会执行，但确认阶段会一直读不到这个节点，5 分钟后报超时，
 * 看起来像升级失败，所以这里先按「能否看到该节点」筛一遍。
 */
async function resolveUpgradeMaster(ctx, agent, options, nodeName) {
  if (options.masterId) {
    const picked = findHost(ctx, options.masterId, '主节点');
    if (!(await masterSeesNode(ctx, picked, nodeName))) {
      throw new HttpError(
        400,
        `所选主节点（${hostLabel(picked)}）看不到节点 ${nodeName}，它不在这个集群里；请选择同集群的控制平面`
      );
    }
    return picked;
  }
  const candidates = (ctx.servers || []).filter((host) => host.id !== agent.id);
  const ordered = [];
  const push = (host) => {
    if (host && !ordered.some((item) => item.id === host.id)) ordered.push(host);
  };
  const url = (agent.k3s && agent.k3s.serverUrl) || '';
  if (url) {
    try {
      const parsed = new URL(url);
      push(candidates.find((host) => parsed.hostname === host.host || parsed.hostname === (host.ip || '')));
    } catch (_) { /* serverUrl 不是合法 URL 时跳过 */ }
  }
  candidates.filter((host) => host.role === 'server').forEach(push);
  candidates.forEach(push);
  for (const candidate of ordered) {
    if (await masterSeesNode(ctx, candidate, nodeName)) return candidate;
  }
  throw new HttpError(
    400,
    `无法确定 ${hostLabel(agent)} 所在集群的控制平面：请把该集群的控制平面加入服务器列表，或手动指定用于确认升级结果的主节点`
  );
}

// ---------------------------------------------------------------- offline packages

function offlineBaseDir(ctx) {
  const value = String((ctx.config.k3s && ctx.config.k3s.offlineDir) || '/opt/k3s-offline').trim();
  return value.replace(/\/+$/, '') || '/opt/k3s-offline';
}

function packageRemoteDir(ctx, pkg) {
  return `${offlineBaseDir(ctx)}/${pkg.id}`;
}

function resolveOfflinePackage(ctx, options) {
  if (options.installMode !== 'offline') return null;
  const id = String(options.offlinePackageId || '').trim();
  if (!id) return null;
  const pkg = offline.getPackage(id);
  if (!pkg) throw new HttpError(400, `找不到离线安装包：${id}。请确认 packages/${id} 存在并包含完整文件。`);
  if (!pkg.valid) throw new HttpError(400, `离线安装包 ${id} 不完整：${pkg.issues.join('；')}`);
  if (!pkg.version) throw new HttpError(400, `离线安装包 ${id} 缺少 k3s 版本号`);
  options.offlinePackageId = pkg.id;
  options.offlinePackage = pkg;
  options.version = pkg.version;
  options.offlineDir = packageRemoteDir(ctx, pkg);
  return pkg;
}

function assertOfflinePackageArch(job, pkg, detected, host) {
  if (!pkg) return;
  const targetArch = offline.normalizeArch(detected && detected.os && detected.os.arch);
  if (!targetArch) {
    job.log(`无法识别 ${hostLabel(host)} 的 CPU 架构，跳过离线包架构预检`, 'warn');
    return;
  }
  if (pkg.arch && targetArch !== pkg.arch) {
    throw new HttpError(412, `离线包架构 ${pkg.archLabel} 与 ${hostLabel(host)} 的架构 ${offline.displayArch(targetArch)} 不匹配`);
  }
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${value} B`;
}

async function stageOfflinePackage(job, ctx, host, pkg) {
  if (!pkg) return;
  const base = offlineBaseDir(ctx);
  const remoteDir = packageRemoteDir(ctx, pkg);
  const marker = `${remoteDir}/.k3s-ui-ready`;
  const step = job.startStep(`准备离线安装包 ${hostLabel(host)}`);
  let probe;
  try {
    probe = await ctx.transport.execScript(
      host,
      `set -e
BASE=${sq(base)}
DIR=${sq(remoteDir)}
MARKER=${sq(marker)}
if [ -f "$MARKER" ] && [ "$(cat "$MARKER" 2>/dev/null)" = ${sq(pkg.signature)} ]; then
  echo __PACKAGE_READY__
else
  echo __PACKAGE_MISSING__
fi`,
      { asRoot: true, timeout: 30000 }
    );
  } catch (err) {
    job.finishStep(step, 'failed', err.message);
    throw err;
  }
  if (probe.code !== 0) {
    job.finishStep(step, 'failed', `检查目标机离线包失败（退出码 ${probe.code}）`);
    throw new HttpError(500, `检查目标机离线包失败（退出码 ${probe.code}）`, (probe.stderr || '').slice(-1000));
  }
  if (String(probe.stdout || '').includes('__PACKAGE_READY__')) {
    job.log(`离线包已在目标机就绪：${remoteDir}`);
    job.finishStep(step, 'success', '使用已上传的离线包');
    return;
  }

  job.log(`将离线包 ${pkg.id}（${formatBytes(pkg.size)}）上传到 ${hostLabel(host)}…`);
  const stamp = `${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`;
  const stageDir = `/var/tmp/k3s-ui-offline-${pkg.id}-${stamp}`;
  let localDir = pkg.dir;
  let cleanupLocal = null;
  try {
    if (pkg.archive) {
      job.log(`本地解压归档 ${pkg.id}…`);
      const materialized = await offline.materializePackage(pkg);
      localDir = materialized.dir;
      cleanupLocal = materialized.cleanup;
    }
    const mkdirResult = await ctx.transport.execScript(host, `mkdir -p ${sq(stageDir)}`, { timeout: 30000 });
    if (mkdirResult.code !== 0) {
      throw new HttpError(500, `无法创建临时目录 ${stageDir}：${(mkdirResult.stderr || '').trim() || `退出码 ${mkdirResult.code}`}`);
    }
    for (const name of pkg.files) {
      job.checkCancelled();
      const localPath = path.join(localDir, name);
      const remotePath = `${stageDir}/${name}`;
      const mode = name === pkg.binary || name === pkg.installer || /\.sh$/i.test(name) ? 0o755 : 0o644;
      let lastPct = -1;
      job.log(`上传 ${name}（${formatBytes((await fsStatSafe(localPath)) || 0)}）`);
      await ctx.transport.putFile(host, localPath, remotePath, {
        mode,
        onProgress: (transferred, total) => {
          const pct = total > 0 ? Math.floor((transferred / total) * 100) : 0;
          if (pct >= lastPct + 10 || pct === 100) {
            lastPct = pct;
            job.log(`  ${name}：${pct}%`);
          }
        }
      });
    }
    const chmodNames = Array.from(new Set([pkg.binary, pkg.installer, ...pkg.files.filter((name) => /\.sh$/i.test(name))].filter(Boolean)));
    job.checkCancelled();
    const moveResult = await ctx.transport.execScript(
      host,
      `set -e
BASE=${sq(base)}
DIR=${sq(remoteDir)}
STAGE=${sq(stageDir)}
MARKER=${sq(marker)}
mkdir -p "$BASE"
rm -rf "$DIR.tmp"
mv "$STAGE" "$DIR.tmp"
rm -rf "$DIR"
mv "$DIR.tmp" "$DIR"
${chmodNames.map((name) => `chmod 755 "$DIR"/${sq(name)}`).join('\n')}
if [ -f "$DIR/SHA256SUMS" ] && command -v sha256sum >/dev/null 2>&1; then
  (cd "$DIR" && sha256sum -c SHA256SUMS) >/dev/null || { echo "离线包上传后校验失败" >&2; exit 1; }
fi
printf '%s' ${sq(pkg.signature)} > "$MARKER"
rm -rf "$STAGE"`,
      { asRoot: true, timeout: 120000 }
    );
    if (moveResult.code !== 0) {
      throw new HttpError(500, `安装包落盘失败（退出码 ${moveResult.code}）`, (moveResult.stderr || '').trim());
    }
    job.finishStep(step, 'success', '离线包已上传并校验标记');
  } catch (err) {
    try {
      await ctx.transport.execScript(host, `rm -rf ${sq(stageDir)}`, { timeout: 30000 });
    } catch (_) { /* ignore */ }
    job.finishStep(step, 'failed', err.message);
    throw err;
  } finally {
    if (cleanupLocal) {
      cleanupLocal();
      job.log(`已清理本地临时解压目录 ${pkg.id}`);
    }
  }
}

async function fsStatSafe(file) {
  try {
    return (await fs.promises.stat(file)).size;
  } catch (_) {
    return 0;
  }
}

function k3sOptions(host, ctx, options = {}) {
  const cfg = ctx.config.k3s || {};
  const hostK3s = host.k3s || {};
  const role = options.role === 'agent' ? 'agent' : 'server';
  const opts = {
    role,
    channel: options.channel || cfg.channel || 'stable',
    version: String(options.version || '').trim(),
    token: String(options.token || hostK3s.token || cfg.clusterToken || '').trim(),
    serverUrl: options.clusterInit ? '' : String(options.serverUrl || hostK3s.serverUrl || '').trim(),
    nodeName: String(options.nodeName || hostK3s.nodeName || '').trim(),
    nodeIp: String(options.nodeIp || hostK3s.nodeIp || '').trim(),
    tlsSans: asArray(options.tlsSans || (role === 'server' ? host.host : '')),
    disable: asArray(options.disable),
    flags: asArray(options.flags || hostK3s.flags),
    datastoreEndpoint: String(options.datastoreEndpoint || '').trim(),
    clusterCidr: String(options.clusterCidr || '').trim(),
    serviceCidr: String(options.serviceCidr || '').trim(),
    writeKubeconfigMode: String(options.writeKubeconfigMode || '644'),
    clusterInit: !!options.clusterInit,
    installMode: options.installMode === 'offline' ? 'offline' : 'online',
    offlineDir: String(options.offlineDir || cfg.offlineDir || '/opt/k3s-offline').trim(),
    mirror: options.mirror !== undefined ? String(options.mirror || '').trim() : String(cfg.mirror || '').trim(),
    mirrorUrl: String(options.mirrorUrl || cfg.mirrorUrl || 'https://rancher-mirror.rancher.cn/k3s').trim(),
    installUrl: String(options.installUrl || cfg.installScriptUrl || 'https://get.k3s.io').trim(),
    registries: Array.isArray(options.registries) ? options.registries : (Array.isArray(hostK3s.registries) ? hostK3s.registries : []),
    httpProxy: String(options.httpProxy || '').trim(),
    httpsProxy: String(options.httpsProxy || '').trim(),
    noProxy: String(options.noProxy || '').trim()
  };
  if (opts.serverUrl && !/^https?:\/\//i.test(opts.serverUrl)) throw new HttpError(400, 'serverUrl 必须以 http:// 或 https:// 开头');
  if (opts.role === 'agent' && !opts.serverUrl) throw new HttpError(400, '安装 k3s 工作节点需要 serverUrl（主节点 API 地址）');
  if (opts.clusterInit && opts.serverUrl) throw new HttpError(400, 'cluster-init 与 serverUrl 不能同时使用');
  if (opts.installMode === 'offline' && !/^\/[^\n\r]*$/.test(opts.offlineDir)) {
    throw new HttpError(400, '离线安装包目录必须是绝对路径，例如 /opt/k3s-offline');
  }
  if (opts.role === 'server' && !opts.token) {
    opts.token = crypto.randomBytes(18).toString('hex');
    opts.generatedToken = true;
  }
  return opts;
}

function buildK3sRegistriesYaml(registries) {
  const mirrors = {};
  for (const entry of registries || []) {
    if (!entry) continue;
    const key = entry.host || entry.name;
    const endpoints = asArray(entry.endpoints || entry.endpoint);
    if (!key || !endpoints.length) continue;
    mirrors[key] = { endpoint: endpoints };
  }
  if (!Object.keys(mirrors).length) return '';
  return JSON.stringify({ mirrors }, null, 2) + '\n';
}

function k3sMirrorLines(opts) {
  const mirror = String(opts.mirror || '').trim();
  if (!mirror) return [];
  const root = String(
    /^https?:\/\//i.test(mirror)
      ? mirror
      : (opts.mirrorUrl || 'https://rancher-mirror.rancher.cn/k3s')
  ).trim().replace(/\/+$/, '');
  const lines = [`export INSTALL_K3S_MIRROR=${sq(mirror)}`];
  if (/^https?:\/\//i.test(root)) {
    lines.push(`export INSTALL_K3S_ARTIFACT_URL=${sq(root)}`);
    lines.push(`export INSTALL_K3S_CHANNEL_URL=${sq(root + '/channels')}`);
  }
  return lines;
}

function buildK3sInstallScript(opts) {
  const offline = opts.installMode === 'offline';
  const lines = ['#!/bin/sh', 'set -e', 'echo "@@K3S_INSTALL_START@@"'];
  lines.push(`export INSTALL_K3S_CHANNEL=${sq(opts.channel)}`);
  if (opts.version) lines.push(`export INSTALL_K3S_VERSION=${sq(opts.version)}`);
  if (opts.token) lines.push(`export K3S_TOKEN=${sq(opts.token)}`);
  if (opts.serverUrl && opts.role === 'agent') lines.push(`export K3S_URL=${sq(opts.serverUrl)}`);
  if (opts.mirror) lines.push(...k3sMirrorLines(opts));
  if (opts.httpProxy) lines.push(`export HTTP_PROXY=${sq(opts.httpProxy)}`);
  if (opts.httpsProxy) lines.push(`export HTTPS_PROXY=${sq(opts.httpsProxy)}`);
  if (opts.noProxy) lines.push(`export NO_PROXY=${sq(opts.noProxy)}`);

  const execArgs = [];
  if (opts.role === 'server') {
    if (opts.clusterInit) execArgs.push('--cluster-init');
    if (opts.serverUrl && !opts.clusterInit) execArgs.push(`--server=${opts.serverUrl}`);
    if (opts.writeKubeconfigMode) execArgs.push(`--write-kubeconfig-mode=${opts.writeKubeconfigMode}`);
    for (const san of opts.tlsSans) execArgs.push(`--tls-san=${san}`);
    if (opts.datastoreEndpoint) execArgs.push(`--datastore-endpoint=${opts.datastoreEndpoint}`);
    if (opts.clusterCidr) execArgs.push(`--cluster-cidr=${opts.clusterCidr}`);
    if (opts.serviceCidr) execArgs.push(`--service-cidr=${opts.serviceCidr}`);
    for (const item of opts.disable) execArgs.push(`--disable=${item}`);
  }
  if (opts.nodeName) execArgs.push(`--node-name=${opts.nodeName}`);
  if (opts.nodeIp) execArgs.push(`--node-ip=${opts.nodeIp}`);
  for (const flag of opts.flags) {
    for (const token of String(flag).split(/\s+/).filter(Boolean)) {
      execArgs.push(token);
    }
  }
  const execValue = [opts.role, ...execArgs].join(' ');
  lines.push(`export INSTALL_K3S_EXEC=${sq(execValue)}`);

  if (offline) {
    lines.push(
      `OFFLINE_DIR=${sq(opts.offlineDir)}`,
      'ARCH="$(uname -m)"',
      'case "$ARCH" in',
      '  x86_64|amd64) ARCH=amd64 ;;',
      '  aarch64|arm64) ARCH=arm64 ;;',
      '  armv7l|armv6l|armhf) ARCH=armhf ;;',
      'esac',
      'K3S_SRC="$OFFLINE_DIR/k3s"',
      '[ -f "$K3S_SRC" ] || K3S_SRC="$OFFLINE_DIR/k3s-$ARCH"',
      'if [ "$ARCH" = "armhf" ] && [ ! -f "$K3S_SRC" ]; then K3S_SRC="$OFFLINE_DIR/k3s-arm"; fi',
      'if [ ! -f "$K3S_SRC" ]; then',
      '  echo "离线包缺少 k3s 二进制：$OFFLINE_DIR/k3s 或 $OFFLINE_DIR/k3s-$ARCH" >&2',
      '  exit 1',
      'fi',
      'IMAGES_SRC=""',
      'for candidate in "$OFFLINE_DIR/k3s-airgap-images-$ARCH.tar" "$OFFLINE_DIR/k3s-airgap-images-$ARCH.tar.gz" "$OFFLINE_DIR/k3s-airgap-images-$ARCH.tar.zst" "$OFFLINE_DIR/k3s-airgap-images-arm.tar" "$OFFLINE_DIR/k3s-airgap-images-arm.tar.gz" "$OFFLINE_DIR/k3s-airgap-images-arm.tar.zst" "$OFFLINE_DIR/k3s-airgap-images.tar" "$OFFLINE_DIR/k3s-airgap-images.tar.gz" "$OFFLINE_DIR/k3s-airgap-images.tar.zst"; do',
      '  if [ -f "$candidate" ]; then IMAGES_SRC="$candidate"; break; fi',
      'done',
      'if [ -z "$IMAGES_SRC" ]; then',
      '  echo "离线包缺少镜像包：$OFFLINE_DIR/k3s-airgap-images-$ARCH.tar（也支持 .tar.gz / .tar.zst）" >&2',
      '  exit 1',
      'fi',
      'INSTALLER="$OFFLINE_DIR/install.sh"',
      'if [ ! -f "$INSTALLER" ]; then',
      '  echo "离线包缺少安装脚本：$INSTALLER" >&2',
      '  exit 1',
      'fi',
      'if [ -f "$OFFLINE_DIR/SHA256SUMS" ] && command -v sha256sum >/dev/null 2>&1; then',
      '  echo "校验离线包文件…"',
      '  (cd "$OFFLINE_DIR" && sha256sum -c SHA256SUMS) || { echo "离线包校验失败，请重新复制安装包" >&2; exit 1; }',
      'fi',
      'systemctl stop k3s k3s-agent 2>/dev/null || true',
      'install -m 0755 "$K3S_SRC" /usr/local/bin/k3s',
      'if ! /usr/local/bin/k3s --version >/tmp/k3s-offline-version.txt 2>&1; then',
      '  echo "离线包 k3s 二进制无法执行，请确认架构与目标机一致（$ARCH）" >&2',
      '  cat /tmp/k3s-offline-version.txt >&2 || true',
      '  exit 1',
      'fi',
      'echo "离线包 k3s 版本：$(head -n1 /tmp/k3s-offline-version.txt)"'
    );
    if (opts.version) {
      lines.push(
        `if ! grep -Fq ${sq(opts.version)} /tmp/k3s-offline-version.txt; then`,
        `  echo "离线包版本与请求版本不一致：需要 ${opts.version}" >&2`,
        '  exit 1',
        'fi'
      );
    }
    lines.push(
      'mkdir -p /var/lib/rancher/k3s/agent/images',
      'IMAGE_DEST="/var/lib/rancher/k3s/agent/images/$(basename "$IMAGES_SRC")"',
      'if [ "$IMAGES_SRC" != "$IMAGE_DEST" ]; then cp -f "$IMAGES_SRC" "$IMAGE_DEST"; fi',
      'export INSTALL_K3S_SKIP_DOWNLOAD=true',
      'export INSTALL_K3S_SKIP_SELINUX_RPM=true'
    );
  }

  const registriesYaml = buildK3sRegistriesYaml(opts.registries);
  if (registriesYaml) {
    lines.push('mkdir -p /etc/rancher/k3s');
    lines.push("cat > /etc/rancher/k3s/registries.yaml <<'K3S_REGISTRIES_EOF'");
    lines.push(registriesYaml.replace(/\n$/, ''));
    lines.push('K3S_REGISTRIES_EOF');
  }

  if (opts.httpProxy || opts.httpsProxy || opts.noProxy) {
    lines.push('mkdir -p /etc/systemd/system');
    lines.push("cat > /etc/systemd/system/k3s.service.env <<'K3S_PROXY_EOF'");
    if (opts.httpProxy) lines.push(`HTTP_PROXY=${opts.httpProxy}`);
    if (opts.httpsProxy) lines.push(`HTTPS_PROXY=${opts.httpsProxy}`);
    if (opts.noProxy) lines.push(`NO_PROXY=${opts.noProxy}`);
    lines.push('K3S_PROXY_EOF');
  }

  if (offline) {
    lines.push(
      'echo "开始离线安装 k3s（跳过下载与 SELinux RPM）"',
      'sh "$INSTALLER"'
    );
  } else {
    lines.push(
      'if command -v curl >/dev/null 2>&1; then',
      `  curl -fsSL ${sq(opts.installUrl)} -o /tmp/k3s-install.sh`,
      'elif command -v wget >/dev/null 2>&1; then',
      `  wget -qO /tmp/k3s-install.sh ${sq(opts.installUrl)}`,
      'else',
      '  echo "缺少 curl 或 wget，无法下载 k3s 安装脚本" >&2',
      '  exit 1',
      'fi',
      'if ! sh /tmp/k3s-install.sh; then',
      '  echo "首次安装失败，跳过 k3s-selinux RPM 后重试（适用于 EulerOS 等无法满足 container-selinux 依赖的系统）" >&2',
      '  INSTALL_K3S_SKIP_SELINUX_RPM=true sh /tmp/k3s-install.sh',
      'fi'
    );
  }
  lines.push(
    'if [ "x' + opts.role + '" = "xserver" ]; then',
    '  systemctl is-active k3s >/dev/null 2>&1 || { systemctl status k3s --no-pager -l | tail -n 40; exit 1; }',
    '  /usr/local/bin/k3s kubectl get nodes -o wide || true',
    'else',
    '  systemctl is-active k3s-agent >/dev/null 2>&1 || { systemctl status k3s-agent --no-pager -l | tail -n 40; exit 1; }',
    'fi',
    'echo "@@K3S_INSTALL_DONE@@"'
  );
  return lines.join('\n');
}

function buildK3sUpgradeScript(opts) {
  const lines = ['#!/bin/sh', 'set -e', 'echo "@@K3S_UPGRADE_START@@"'];
  // Keep the existing service arguments (--cluster-init, --server, --data-dir, ...).
  lines.push('SVC="k3s"');
  lines.push('if [ -f /etc/systemd/system/k3s-agent.service ]; then SVC="k3s-agent"; fi');
  lines.push('EXEC=$(systemctl show -p ExecStart --value "$SVC" 2>/dev/null | sed -n "s/.*argv\\[\\]=\\([^;]*\\).*/\\1/p" | head -n1 || true)');
  lines.push('if [ -z "$EXEC" ]; then');
  lines.push('  echo "无法读取现有 k3s 启动参数，已中止升级（避免丢失 --cluster-init / --data-dir 等参数）" >&2');
  lines.push('  exit 1');
  lines.push('fi');
  lines.push('ARGS=$(printf "%s" "$EXEC" | sed -E "s#^[^ ]*/k3s( |$)##")');
  lines.push('if [ -n "$ARGS" ]; then export INSTALL_K3S_EXEC="$ARGS"; fi');
  lines.push(`export INSTALL_K3S_CHANNEL=${sq(opts.channel || 'stable')}`);
  lines.push(`export INSTALL_K3S_VERSION=${sq(opts.version)}`);
  if (opts.mirror) lines.push(...k3sMirrorLines(opts));
  if (opts.httpProxy) lines.push(`export HTTP_PROXY=${sq(opts.httpProxy)}`);
  if (opts.httpsProxy) lines.push(`export HTTPS_PROXY=${sq(opts.httpsProxy)}`);
  if (opts.noProxy) lines.push(`export NO_PROXY=${sq(opts.noProxy)}`);
  lines.push(
    'if command -v curl >/dev/null 2>&1; then',
    `  curl -fsSL ${sq(opts.installUrl)} -o /tmp/k3s-install.sh`,
    'elif command -v wget >/dev/null 2>&1; then',
    `  wget -qO /tmp/k3s-install.sh ${sq(opts.installUrl)}`,
    'else',
    '  echo "缺少 curl 或 wget，无法下载 k3s 安装脚本" >&2',
    '  exit 1',
    'fi',
    'if ! sh /tmp/k3s-install.sh; then',
    '  echo "首次升级安装失败，跳过 k3s-selinux RPM 后重试" >&2',
    '  INSTALL_K3S_SKIP_SELINUX_RPM=true sh /tmp/k3s-install.sh',
    'fi',
    'systemctl restart "$SVC"',
    'systemctl is-active "$SVC" >/dev/null 2>&1 || { systemctl status "$SVC" --no-pager -l | tail -n 40; exit 1; }',
    '/usr/local/bin/k3s --version || true',
    'echo "@@K3S_UPGRADE_DONE@@"'
  );
  return lines.join('\n');
}

function buildK3sUninstallScript(options = {}) {
  const deep = !!(options.deepClean || options.removeData);
  const lines = ['#!/bin/sh', 'echo "@@K3S_UNINSTALL_START@@"', 'FOUND=0'];
  lines.push(
    'if [ -x /usr/local/bin/k3s-uninstall.sh ]; then',
    '  echo "执行 k3s server 卸载脚本…"',
    '  sh /usr/local/bin/k3s-uninstall.sh',
    '  FOUND=1',
    'fi',
    'if [ -x /usr/local/bin/k3s-agent-uninstall.sh ]; then',
    '  echo "执行 k3s agent 卸载脚本…"',
    '  sh /usr/local/bin/k3s-agent-uninstall.sh',
    '  FOUND=1',
    'fi',
    'if [ "$FOUND" -eq 0 ]; then',
    '  echo "未发现 k3s 卸载脚本；该节点可能不是 k3s，已停止卸载以避免误删" >&2',
    '  exit 1',
    'fi'
  );
  if (deep) {
    lines.push(
      'echo "执行 k3s 深度残留清理…"',
      'if command -v systemctl >/dev/null 2>&1; then',
      '  systemctl stop k3s k3s-agent 2>/dev/null || true',
      '  systemctl disable k3s k3s-agent 2>/dev/null || true',
      '  systemctl reset-failed k3s k3s-agent 2>/dev/null || true',
      '  for unit in /etc/systemd/system/k3s*.service; do',
      '    [ -e "$unit" ] || continue',
      '    systemctl stop "$(basename "$unit")" 2>/dev/null || true',
      '    systemctl disable "$(basename "$unit")" 2>/dev/null || true',
      '    rm -f "$unit" 2>/dev/null || true',
      '  done',
      'fi',
      'rm -rf /etc/systemd/system/k3s.service.d /etc/systemd/system/k3s-agent.service.d 2>/dev/null || true',
      'rm -rf /etc/systemd/system/k3s*.service.d 2>/dev/null || true',
      'rm -f /etc/init.d/k3s* 2>/dev/null || true',
      'rm -f /etc/systemd/system/k3s.service /etc/systemd/system/k3s-agent.service /etc/systemd/system/k3s.service.env 2>/dev/null || true',
      'rm -f /etc/systemd/system/k3s.service.bak* /etc/systemd/system/k3s-agent.service.bak* 2>/dev/null || true',
      'rm -f /etc/systemd/system/multi-user.target.wants/k3s.service /etc/systemd/system/multi-user.target.wants/k3s-agent.service 2>/dev/null || true',
      'rm -rf /etc/rancher/node /etc/rancher/k3s 2>/dev/null || true',
      'rm -rf /var/lib/rancher/k3s /var/lib/kubelet /var/lib/cni /run/k3s /run/flannel 2>/dev/null || true',
      'rm -f /usr/local/bin/k3s /usr/local/bin/k3s-uninstall.sh /usr/local/bin/k3s-agent-uninstall.sh /usr/local/bin/k3s-killall.sh 2>/dev/null || true',
      'for cmd in kubectl crictl ctr; do',
      '  if [ -L "/usr/local/bin/$cmd" ]; then rm -f "/usr/local/bin/$cmd" 2>/dev/null || true; fi',
      'done',
      'for logpath in /var/log/pods /var/log/containers; do',
      '  if [ -L "$logpath" ]; then',
      '    target=$(readlink -f "$logpath" 2>/dev/null || true)',
      '    case "$target" in',
      '      /var/log/*|/var/lib/*|/run/*) rm -rf "$target" 2>/dev/null || true ;;',
      '      "") : ;;',
      '      *) echo "保留外部日志目录：$target" ;;',
      '    esac',
      '  fi',
      '  rm -rf "$logpath" 2>/dev/null || true',
      'done',
      'rm -f /etc/cni/net.d/10-flannel.conflist /etc/cni/net.d/10-k3s* 2>/dev/null || true',
      'if command -v ip >/dev/null 2>&1; then',
      '  for iface in cni0 flannel.1 flannel-v6.1 kube-ipvs0 flannel-wg flannel-wg-v6; do',
      '    ip link delete "$iface" 2>/dev/null || true',
      '  done',
      '  ip netns list 2>/dev/null | awk \'{print $1}\' | grep "^cni-" | while read ns; do ip netns delete "$ns" 2>/dev/null || true; done',
      'fi',
      'if command -v ipvsadm >/dev/null 2>&1; then',
      '  ipvsadm -C 2>/dev/null || true',
      'fi',
      'if command -v iptables-save >/dev/null 2>&1 && command -v iptables-restore >/dev/null 2>&1; then',
      '  tmp=$(mktemp 2>/dev/null || echo "/tmp/k3s-iptables.$$")',
      '  if iptables-save > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then',
      '    grep -viE "KUBE-|K3S-|CNI-|FLANNEL" "$tmp" | iptables-restore 2>/dev/null || true',
      '  fi',
      '  rm -f "$tmp" 2>/dev/null || true',
      'fi',
      'if command -v ip6tables-save >/dev/null 2>&1 && command -v ip6tables-restore >/dev/null 2>&1; then',
      '  tmp=$(mktemp 2>/dev/null || echo "/tmp/k3s-ip6tables.$$")',
      '  if ip6tables-save > "$tmp" 2>/dev/null && [ -s "$tmp" ]; then',
      '    grep -viE "KUBE-|K3S-|CNI-|FLANNEL" "$tmp" | ip6tables-restore 2>/dev/null || true',
      '  fi',
      '  rm -f "$tmp" 2>/dev/null || true',
      'fi',
      'if command -v iptables-save >/dev/null 2>&1 && iptables-save 2>/dev/null | grep -qE "^:(KUBE-|K3S-|CNI-|FLANNEL-)"; then',
      '  echo "提示：仍检测到 KUBE/CNI/FLANNEL iptables 链，请重启或人工确认" >&2',
      'fi',
      'if command -v nft >/dev/null 2>&1 && nft list tables 2>/dev/null | grep -qiE "kube|k3s|flannel|cni"; then',
      '  echo "提示：nftables 中仍检测到 Kubernetes/CNI 相关表，请人工确认" >&2',
      'fi',
      'rmdir /etc/rancher 2>/dev/null || true',
      'rmdir /var/lib/rancher 2>/dev/null || true',
      'if command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload 2>/dev/null || true; fi',
      'echo "深度清理完成；外部 Docker/containerd、/etc/kubernetes、/root/.kube 未删除"',
      'LEFTOVER=""',
      'for p in /usr/local/bin/k3s /etc/rancher/k3s /var/lib/rancher/k3s /etc/systemd/system/k3s.service /var/lib/kubelet; do',
      '  [ -e "$p" ] && LEFTOVER="$LEFTOVER $p"',
      'done',
      'if [ -n "$LEFTOVER" ]; then echo "提示：以下路径仍存在，请人工确认：$LEFTOVER" >&2; fi'
    );
  }
  lines.push('echo "@@K3S_UNINSTALL_DONE@@"');
  return lines.join('\n');
}

// ------------------------------------------------------------------ execution

function logChecks(job, result) {
  for (const check of result.checks) {
    const level = check.status === 'fail' ? 'error' : check.status === 'warn' ? 'warn' : 'info';
    job.log(`[${check.status.toUpperCase()}] ${check.label}：${check.detail}`, level);
  }
}

async function runPreflight(job, ctx, host, mode, options = {}) {
  const step = job.startStep(`预检 ${hostLabel(host)}`);
  try {
    const result = await inspect.preflight(host, ctx, { mode, installMode: options.installMode });
    logChecks(job, result);
    job.finishStep(step, result.ok ? 'success' : 'failed', result.ok ? '通过' : '存在阻塞项');
    return result;
  } catch (err) {
    job.finishStep(step, 'failed', err.message);
    throw err;
  }
}

async function execHostScript(job, ctx, host, script, opts = {}) {
  job.checkCancelled();
  let killFn = null;
  const onStart = (kill) => {
    killFn = kill;
    job.registerKill(kill);
  };
  let result;
  try {
    result = await ctx.transport.execScript(host, script, {
      timeout: opts.timeout || 900000,
      asRoot: opts.asRoot !== false,
      onStart
    });
  } finally {
    if (killFn) job.unregisterKill(killFn);
  }
  job.checkCancelled();
  if (result.stdout) job.log(result.stdout);
  if (result.stderr) job.log(result.stderr, 'warn');
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout || '').slice(-3000);
    throw new HttpError(500, `${opts.label || '远程命令'}失败（退出码 ${result.code}）`, detail);
  }
  return result;
}

async function readK3sToken(job, ctx, master) {
  const result = await ctx.transport.execScript(
    master,
    'cat /var/lib/rancher/k3s/server/node-token',
    { asRoot: true, timeout: 30000 }
  );
  const token = (result.stdout || '').trim();
  if (result.code !== 0 || !token) {
    throw new HttpError(500, '读取 k3s node-token 失败，请确认主节点已成功安装 k3s server', (result.stderr || '').slice(-1000));
  }
  job.log('已读取主节点 node-token（不在此处显示）');
  return token;
}

async function waitForCluster(job, ctx, master, options = {}) {
  const timeout = options.timeout || 300000;
  const expectedNames = asArray(options.expectedNames);
  const expectedCount = Number(options.expectedCount || 0);
  const step = job.startStep(options.title || '等待节点就绪');
  const started = Date.now();
  let lastProgress = 0;
  let lastError = null;
  while (Date.now() - started < timeout) {
    job.checkCancelled();
    let nodes = null;
    try {
      nodes = await kube.nodeList(master, { config: ctx.config, transport: ctx.transport, timeout: 20000 });
      lastError = null;
    } catch (err) {
      lastError = err;
    }
    if (nodes) {
      const ready = nodes.filter((n) => n.ready);
      const lower = (value) => String(value || '').toLowerCase();
      const namesOk = expectedNames.length
        ? expectedNames.every((name) => ready.some((n) => lower(n.name) === lower(name)))
        : true;
      const countOk = expectedCount ? ready.length >= expectedCount : true;
      if ((expectedNames.length || expectedCount) && namesOk && countOk) {
        job.log(`节点已就绪：${nodes.map((n) => `${n.name}(${n.status})`).join(', ')}`);
        job.finishStep(step, 'success', `${ready.length}/${nodes.length} 节点就绪`);
        return nodes;
      }
      if (Date.now() - lastProgress > 10000) {
        lastProgress = Date.now();
        job.log(`等待中：${nodes.map((n) => `${n.name}(${n.status})`).join(', ') || '尚未注册节点'}`);
      }
    } else if (Date.now() - lastProgress > 15000) {
      lastProgress = Date.now();
      job.log(`暂时无法读取节点列表：${lastError ? lastError.message : '未知错误'}`, 'warn');
    }
    await sleep(options.interval || 5000);
  }
  const detail = lastError ? lastError.message : '请到集群检查节点状态';
  job.finishStep(step, 'failed', `超时（${Math.round(timeout / 1000)}s）`);
  throw new HttpError(504, `等待节点就绪超时：${detail}`);
}

async function waitForEtcd(job, ctx, host, options = {}) {
  const timeout = Number(options.timeout || 120000);
  const step = job.startStep(options.title || '检查 etcd 仲裁');
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeout) {
    job.checkCancelled();
    try {
      const res = await ctx.transport.execScript(host, '/usr/local/bin/k3s kubectl get --raw /healthz/etcd', {
        asRoot: true,
        timeout: 15000
      });
      last = (res.stdout || res.stderr || '').trim();
      if (res.code === 0 && /^ok$/i.test(last)) {
        job.finishStep(step, 'success', 'etcd 仲裁正常');
        return;
      }
    } catch (err) {
      last = err.message;
    }
    await sleep(3000);
  }
  job.finishStep(step, 'failed', 'etcd 未就绪');
  throw new HttpError(504, `etcd 未达到仲裁状态：${last || '未知错误'}`);
}

/* --------------------------------------------------- 安装后网络自检
 *
 * 安装最典型的“假成功”是：三台节点全是 Ready，但控制节点的 flannel 没能把
 * VXLAN 设备拉起来（flannel.1 停在 DOWN、没有地址），于是跨节点 pod 网段没有路由，
 * 表现为“本机 curl 别的节点 80 超时”“pod 解析不了集群域名”。
 * 节点就绪并不等于网络就绪，所以装完逐台核对设备、路由、VTEP 表项和 DNS 可达性。
 */

function flannelBackendFrom(options) {
  for (const flag of asArray(options && options.flags)) {
    const match = /^--flannel-backend=(.+)$/.exec(String(flag).trim());
    if (match) return match[1].trim();
  }
  // --disable 里带 flannel 表示用自带 CNI，同样跳过
  if (asArray(options && options.disable).includes('flannel')) return 'none';
  return 'vxlan';
}

async function kubectlJsonSafe(ctx, host, args, timeout = 20000) {
  const result = await ctx.transport.execScript(host, `/usr/local/bin/k3s kubectl ${args}`, {
    asRoot: true,
    timeout
  });
  if (result.code !== 0) return null;
  try {
    return JSON.parse(result.stdout || 'null');
  } catch (_) {
    return null;
  }
}

async function collectFlannelNodes(ctx, primary) {
  const json = await kubectlJsonSafe(ctx, primary, 'get nodes -o json', 30000);
  if (!json || !Array.isArray(json.items)) {
    throw new HttpError(500, '读取节点列表失败，无法执行网络自检');
  }
  return json.items
    .map((item) => {
      const meta = item.metadata || {};
      const annotations = meta.annotations || {};
      let vtepMac = '';
      try {
        const backend = JSON.parse(annotations['flannel.alpha.coreos.com/backend-data'] || '{}');
        vtepMac = String(backend.VtepMAC || '');
      } catch (_) {
        vtepMac = '';
      }
      const addresses = (item.status && item.status.addresses) || [];
      const internal = addresses.find((a) => a.type === 'InternalIP');
      return {
        name: String(meta.name || ''),
        podCidr: String((item.spec && item.spec.podCIDR) || ''),
        internalIP: internal ? internal.address : '',
        vtepMac
      };
    })
    .filter((node) => node.name);
}

// 拿 coreDNS 的 ClusterIP：它同时验证 kube-proxy 和跨节点 pod 网络，
// 但前提是后端pod 已经就绪，否则会把“还在启动”误判成网络故障。
async function readDnsProbeIp(ctx, primary) {
  const service = await kubectlJsonSafe(ctx, primary, '-n kube-system get svc kube-dns -o json');
  const clusterIP = service && service.spec && service.spec.clusterIP;
  if (!clusterIP || clusterIP === 'None') return '';
  const endpoints = await kubectlJsonSafe(ctx, primary, '-n kube-system get endpoints kube-dns -o json');
  const subsets = (endpoints && endpoints.subsets) || [];
  const ready = subsets.some((subset) => (subset.addresses || []).length > 0);
  return ready ? String(clusterIP) : '';
}

function buildNetworkSelfCheckScript(nodes, selfName, dnsIp) {
  const peers = nodes.filter((node) => node.name !== selfName && node.podCidr);
  const lines = [
    '#!/bin/sh',
    'echo "@@NET_CHECK_START@@"',
    'FAIL=0',
    'WARN=0',
    `DNSIP=${sq(dnsIp || '')}`,
    'ok() { echo "[PASS] $*"; }',
    'bad() { echo "[FAIL] $*"; FAIL=$((FAIL+1)); }',
    'warn() { echo "[WARN] $*"; WARN=$((WARN+1)); }',
    '',
    'if ! ip -o link show flannel.1 >/dev/null 2>&1; then',
    '  bad "缺少 flannel.1 设备（VXLAN 没创建）"',
    'elif ip -o link show flannel.1 | grep -qE "<[^>]*UP[^>]*>"; then',
    '  ADDR=$(ip -o -4 addr show flannel.1 2>/dev/null | awk \'NR==1{print $4}\')',
    '  if [ -n "$ADDR" ]; then ok "flannel.1 已启用，地址 $ADDR"; else bad "flannel.1 已启用但没有 IPv4 地址"; fi',
    'else',
    '  bad "flannel.1 处于 DOWN 状态（VXLAN 没有拉起）"',
    'fi',
    ''
  ];
  for (const peer of peers) {
    const label = peer.name;
    lines.push(
      `if ip route show | grep -F ${sq(peer.podCidr)} | grep -q "dev flannel.1"; then`,
      `  ok "到 ${label} 的 pod 网段 ${peer.podCidr} 路由正常"`,
      'else',
      `  bad "缺少到 ${label}（${peer.podCidr}）的 VXLAN 路由"`,
      'fi'
    );
    if (peer.vtepMac) {
      lines.push(
        `if bridge fdb show dev flannel.1 2>/dev/null | grep -qi ${sq(peer.vtepMac)}; then`,
        `  ok "已记录 ${label} 的 VTEP 地址"`,
        'else',
        `  warn "未找到 ${label} 的 VTEP 表项（${peer.vtepMac}）"`,
        'fi'
      );
    }
  }
  lines.push(
    '',
    'if [ -n "$DNSIP" ]; then',
    '  REACHED=0',
    '  for _ in 1 2 3; do',
    '    if timeout 3 bash -c "exec 3<>/dev/tcp/$DNSIP/53" 2>/dev/null; then REACHED=1; break; fi',
    '    sleep 2',
    '  done',
    '  if [ "$REACHED" = "1" ]; then ok "集群 DNS 可达（$DNSIP:53）"; else bad "集群 DNS 不可达（$DNSIP:53，pod 网络不通）"; fi',
    'else',
    '  warn "coreDNS 尚未就绪，跳过 DNS 探测"',
    'fi',
    '',
    'echo "@@NET_CHECK_RESULT@@ fail=$FAIL warn=$WARN"',
    'exit 0'
  );
  return lines.join('\n');
}

async function runNetworkSelfCheck(job, ctx, primary, entries, options = {}) {
  const backend = flannelBackendFrom(options);
  if (backend !== 'vxlan') {
    job.log(`flannel 后端为 ${backend}，跳过 VXLAN 自检`, 'warn');
    return;
  }
  if (entries.length < 2) {
    job.log('单节点集群，跳过跨节点网络自检');
    return;
  }

  const step = job.startStep('安装后网络自检');
  const nodes = await collectFlannelNodes(ctx, primary);
  const byName = new Map(nodes.map((node) => [node.name.toLowerCase(), node]));
  const dnsIp = await readDnsProbeIp(ctx, primary);
  if (!dnsIp) job.log('coreDNS 尚未就绪，本次不做 DNS 探测', 'warn');

  const problems = [];
  for (const entry of entries) {
    job.checkCancelled();
    const label = `${entry.nodeName}（${entry.host.host}）`;
    const node = byName.get(String(entry.nodeName).toLowerCase());
    if (!node) {
      problems.push(`${label} 不在集群节点列表中`);
      continue;
    }
    if (!node.podCidr) {
      problems.push(`${label} 未分配 pod 网段`);
      continue;
    }
    job.log(`—— 网络自检 ${label} ——`);
    const script = buildNetworkSelfCheckScript(nodes, node.name, dnsIp);
    // 节点刚 Ready 时 flannel 可能还在下发路由，失败重试一次，避免把启动瞬间的抖动判成故障
    let lines = [];
    let fails = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let stdout = '';
      try {
        const result = await ctx.transport.execScript(entry.host, script, {
          asRoot: true,
          timeout: 90000
        });
        stdout = String(result.stdout || '');
      } catch (err) {
        if (attempt === 0) {
          await sleep(3000);
          continue;
        }
        problems.push(`${label} 自检执行失败：${formatError(err)}`);
        lines = [];
        fails = [];
        break;
      }
      lines = stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => /^\[(PASS|WARN|FAIL)\]/.test(line));
      fails = lines.filter((line) => line.startsWith('[FAIL]'));
      if (!fails.length) break;
      if (attempt === 0) await sleep(3000);
    }
    for (const line of lines) {
      if (line.startsWith('[FAIL]')) job.log(line, 'error');
      else if (line.startsWith('[WARN]')) job.log(line, 'warn');
      else job.log(line);
    }
    if (fails.length) {
      problems.push(`${label}：${fails.map((line) => line.slice('[FAIL] '.length)).join('；')}`);
    }
  }

  if (problems.length) {
    job.finishStep(step, 'failed', `${problems.length}/${entries.length} 台节点未通过`);
    const networkLike = problems.some((item) => /flannel|路由|DNS|flannel\.1/.test(item));
    const hint = networkLike
      ? '。这通常是节点上的 flannel 没把 VXLAN 设备拉起来，可在对应节点执行：ip link del flannel.1 && systemctl restart k3s'
      : '';
    throw new HttpError(500, `安装已完成，但网络自检未通过：${problems.join('；')}${hint}`, problems.join('\n'));
  }
  job.finishStep(step, 'success', `${entries.length} 台节点跨节点网络正常`);
}

async function installK3sServer(job, ctx, host, options) {
  let effectiveOptions = options;
  if (effectiveOptions.force && !effectiveOptions.token) {
    try {
      const existingToken = await readK3sToken(job, ctx, host);
      effectiveOptions = { ...effectiveOptions, token: existingToken };
      job.log('强制重装：沿用已有集群 token，保留现有数据可启动', 'warn');
    } catch (err) {
      job.log(`未读取到已有集群 token，将按新集群处理：${err.message}`, 'info');
    }
  }
  const opts = k3sOptions(host, ctx, { ...effectiveOptions, role: 'server' });
  job.log(`安装目标：${hostLabel(host)}`);
  job.log(`k3s 通道：${opts.channel}${opts.version ? '，版本：' + opts.version : ''}`);
  job.log(`安装方式：${opts.installMode === 'offline' ? '离线（' + opts.offlineDir + '）' : '在线下载'}`);
  job.log(`k3s 参数：server ${buildDisplayArgs(opts)}`);
  const step = job.startStep(opts.installMode === 'offline' ? '从离线包安装 k3s server' : '下载并安装 k3s server');
  await execHostScript(job, ctx, host, buildK3sInstallScript(opts), { label: '安装 k3s server', timeout: 900000 });
  job.finishStep(step, 'success', '安装脚本执行完成');
  kube.clearKubeCache();
  const token = await readK3sToken(job, ctx, host);
  return { token, opts, generatedToken: !!opts.generatedToken };
}

function buildDisplayArgs(opts) {
  const parts = [];
  if (opts.clusterInit) parts.push('--cluster-init');
  if (opts.serverUrl) parts.push(`--server=${opts.serverUrl}`);
  if (opts.writeKubeconfigMode) parts.push(`--write-kubeconfig-mode=${opts.writeKubeconfigMode}`);
  for (const san of opts.tlsSans) parts.push(`--tls-san=${san}`);
  for (const item of opts.disable) parts.push(`--disable=${item}`);
  if (opts.datastoreEndpoint) parts.push(`--datastore-endpoint=***`);
  if (opts.clusterCidr) parts.push(`--cluster-cidr=${opts.clusterCidr}`);
  if (opts.nodeName) parts.push(`--node-name=${opts.nodeName}`);
  if (opts.nodeIp) parts.push(`--node-ip=${opts.nodeIp}`);
  return parts.join(' ');
}

async function installK3sAgent(job, ctx, host, options) {
  const opts = k3sOptions(host, ctx, { ...options, role: 'agent' });
  job.log(`安装目标：${hostLabel(host)}，加入 ${opts.serverUrl}`);
  job.log(`安装方式：${opts.installMode === 'offline' ? '离线（' + opts.offlineDir + '）' : '在线下载'}`);
  const step = job.startStep(opts.installMode === 'offline' ? '从离线包安装 k3s agent' : '下载并安装 k3s agent');
  await execHostScript(job, ctx, host, buildK3sInstallScript(opts), { label: '安装 k3s agent', timeout: 900000 });
  job.finishStep(step, 'success', 'agent 安装完成');
  kube.clearKubeCache();
  return opts;
}

function assertInstallable(host, detected, options) {
  if (options.force) return;
  if (detected && detected.components && detected.components.k3s.installed) {
    throw new HttpError(
      409,
      `${hostLabel(host)} 上已检测到 k3s（${detected.components.k3s.version || '版本未知'}）。如需重装或升级，请勾选“强制重装”后重试。`
    );
  }
  if (detected && detected.k8s && detected.k8s.installed) {
    throw new HttpError(409, `${hostLabel(host)} 已存在 Kubernetes 集群，请先执行卸载或勾选“强制重装”。`);
  }
}

const K3S_CGROUP_V1_MAX_VERSION = 'v1.34.1+k3s1';

function k3sMinorVersion(version) {
  const match = /^v?(\d+)\.(\d+)\./.exec(String(version || '').trim());
  return match ? Number(match[2]) : null;
}

function assertCgroupVersionCompatible(job, detected, options) {
  const cgroup = detected && detected.cgroup;
  if (cgroup === 'cgroup2fs' && detected.cpuset !== 'yes') {
    throw new HttpError(409, '目标内核的 cgroup v2 缺少 cpuset 控制器，k3s 无法启动。请切换 cgroup v1 或升级内核后再安装。');
  }
  if (cgroup !== 'tmpfs') return;
  const requested = String(options.version || '').trim();
  if (!requested) {
    options.version = K3S_CGROUP_V1_MAX_VERSION;
    job.log(`目标为 cgroup v1，k3s v1.35+ 已不支持；本次自动使用兼容版本 ${K3S_CGROUP_V1_MAX_VERSION}`, 'warn');
    return;
  }
  const minor = k3sMinorVersion(requested);
  if (minor !== null && minor > 34) {
    throw new HttpError(409, `目标为 cgroup v1，不支持 k3s ${requested}；请改用 v1.34.x 或更早版本（例如 ${K3S_CGROUP_V1_MAX_VERSION}）`);
  }
}

async function validateOfflineBundle(job, ctx, host, options = {}) {
  if (options.installMode !== 'offline') return;
  const dir = String(options.offlineDir || '/opt/k3s-offline').trim();
  const step = job.startStep(`校验离线安装包 ${hostLabel(host)}`);
  const script = `set -e
OFFLINE_DIR=${sq(dir)}
ARCH="$(uname -m)"
case "$ARCH" in
  x86_64|amd64) ARCH=amd64 ;;
  aarch64|arm64) ARCH=arm64 ;;
  armv7l|armv6l|armhf) ARCH=armhf ;;
esac
K3S_SRC="$OFFLINE_DIR/k3s"
[ -f "$K3S_SRC" ] || K3S_SRC="$OFFLINE_DIR/k3s-$ARCH"
if [ "$ARCH" = "armhf" ] && [ ! -f "$K3S_SRC" ]; then K3S_SRC="$OFFLINE_DIR/k3s-arm"; fi
IMAGES_SRC=""
for candidate in "$OFFLINE_DIR/k3s-airgap-images-$ARCH.tar" "$OFFLINE_DIR/k3s-airgap-images-$ARCH.tar.gz" "$OFFLINE_DIR/k3s-airgap-images-$ARCH.tar.zst" "$OFFLINE_DIR/k3s-airgap-images-arm.tar" "$OFFLINE_DIR/k3s-airgap-images-arm.tar.gz" "$OFFLINE_DIR/k3s-airgap-images-arm.tar.zst" "$OFFLINE_DIR/k3s-airgap-images.tar" "$OFFLINE_DIR/k3s-airgap-images.tar.gz" "$OFFLINE_DIR/k3s-airgap-images.tar.zst"; do
  if [ -f "$candidate" ]; then IMAGES_SRC="$candidate"; break; fi
done
INSTALLER="$OFFLINE_DIR/install.sh"
[ -d "$OFFLINE_DIR" ] || { echo "离线包目录不存在：$OFFLINE_DIR" >&2; exit 1; }
[ -f "$K3S_SRC" ] || { echo "缺少 k3s 二进制：$OFFLINE_DIR/k3s 或 k3s-$ARCH" >&2; exit 1; }
[ -n "$IMAGES_SRC" ] && [ -f "$IMAGES_SRC" ] || { echo "缺少镜像包：k3s-airgap-images-$ARCH.tar（也支持 .tar.gz / .tar.zst）" >&2; exit 1; }
[ -f "$INSTALLER" ] || { echo "缺少安装脚本：$INSTALLER" >&2; exit 1; }
if [ -f "$OFFLINE_DIR/SHA256SUMS" ] && command -v sha256sum >/dev/null 2>&1; then
  (cd "$OFFLINE_DIR" && sha256sum -c SHA256SUMS) >/dev/null || { echo "SHA256SUMS 校验失败" >&2; exit 1; }
fi
printf 'arch=%s\\nbinary=%s\\nimages=%s\\ninstaller=%s\\n' "$ARCH" "$K3S_SRC" "$IMAGES_SRC" "$INSTALLER"`;
  try {
    const result = await ctx.transport.execScript(host, script, { asRoot: true, timeout: 30000 });
    if (result.stdout) job.log(String(result.stdout).trim());
    if (result.stderr) job.log(String(result.stderr).trim(), 'warn');
    if (result.code !== 0) {
      throw new HttpError(412, `离线包校验失败（退出码 ${result.code}）`, (result.stderr || result.stdout || '').slice(-2000));
    }
    job.finishStep(step, 'success', '离线包可用');
  } catch (err) {
    job.finishStep(step, 'failed', err.message);
    if (err instanceof HttpError) throw err;
    throw new HttpError(412, `离线安装包校验失败：${err.message}`);
  }
}

async function doSingleInstall(job, ctx, host, options = {}) {
  const role = options.role === 'agent' ? 'agent' : (options.mode === 'k3s-agent' ? 'agent' : 'server');
  const offlinePackage = resolveOfflinePackage(ctx, options);
  const preflight = await runPreflight(job, ctx, host, role === 'agent' ? 'k3s-agent' : 'k3s-server', options);
  if (!preflight.ok) throw new HttpError(412, '预检未通过，已中止安装');
  assertInstallable(host, preflight.detected, options, 'k3s');
  assertCgroupVersionCompatible(job, preflight.detected, options);
  assertOfflinePackageArch(job, offlinePackage, preflight.detected, host);
  if (offlinePackage) await stageOfflinePackage(job, ctx, host, offlinePackage);
  await validateOfflineBundle(job, ctx, host, options);

  if (role === 'server') {
    const installed = await installK3sServer(job, ctx, host, options);
    const hostname = (preflight.detected && preflight.detected.hostname) || options.nodeName || host.host;
    const nodes = await waitForCluster(job, ctx, host, {
      expectedNames: options.nodeName ? [options.nodeName] : [hostname],
      timeout: Number(options.waitTimeoutMs) || 300000,
      title: '等待主节点就绪'
    });
    return {
      role,
      token: installed.token,
      generatedToken: installed.generatedToken,
      nodes,
      serverUrl: `https://${host.host}:${k3sApiPort(ctx)}`
    };
  }

  const master = resolveMaster(ctx, host, options);
  job.log(`主节点：${hostLabel(master)}`);
  const token = options.token || await readK3sToken(job, ctx, master);
  const serverUrl = options.serverUrl || (host.k3s && host.k3s.serverUrl) || `https://${master.host}:${k3sApiPort(ctx)}`;
  await installK3sAgent(job, ctx, host, { ...options, token, serverUrl });
  const hostname = (preflight.detected && preflight.detected.hostname) || options.nodeName || host.host;
  const nodes = await waitForCluster(job, ctx, master, {
    expectedNames: options.nodeName ? [options.nodeName] : [hostname],
    timeout: Number(options.waitTimeoutMs) || 300000,
    title: '等待工作节点就绪'
  });
  return { role, nodes };
}

// ------------------------------------------------------------------ upgrade
async function doUpgrade(job, ctx, host, options = {}) {
  if ((host.transport || 'ssh') === 'kubeconfig') {
    throw new HttpError(400, 'kubeconfig 模式仅用于纳管已有集群，无法升级 k3s');
  }
  const version = String(options.version || '').trim();
  if (!/^v\d+\.\d+\.\d+(?:[+\-][0-9A-Za-z.+_-]+)?$/.test(version)) {
    throw new HttpError(400, '请填写合法的 k3s 版本，例如 v1.31.4+k3s1');
  }
  const role = options.role === 'agent' ? 'agent' : 'server';
  const cfg = ctx.config.k3s || {};
  const channel = options.channel || cfg.channel || 'stable';
  job.log(`升级目标：${hostLabel(host)}`);
  job.log(`目标版本：${version}（${channel}）`);

  const pre = await ctx.transport.execScript(
    host,
    'hostname; /usr/local/bin/k3s --version || exit 3; systemctl show -p ExecStart --value k3s 2>/dev/null || true; systemctl show -p ExecStart --value k3s-agent 2>/dev/null || true',
    { asRoot: true, timeout: 15000 }
  );
  if (pre.code !== 0) {
    throw new HttpError(400, '该节点未检测到可用的 k3s，不能执行升级；请先确认节点已安装 k3s');
  }
  const preOut = String(pre.stdout || '');
  const preLines = preOut.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const nodeNameArg = preOut.match(/--node-name(?:=|\s+)([^\s;]+)/);
  const nodeName = String(options.nodeName || (host.k3s && host.k3s.nodeName) || (nodeNameArg && nodeNameArg[1]) || preLines[0] || '').trim();
  const currentVersion = preLines.find((line) => line.includes('k3s version')) || '版本未知';
  job.log(`当前版本：${currentVersion}`);
  if (!nodeName) throw new HttpError(500, '节点主机名为空，无法确认升级后的 Node 名称');

  const cgroupInfo = await ctx.transport.execScript(
    host,
    'stat -fc %T /sys/fs/cgroup 2>/dev/null || true; [ -d /sys/fs/cgroup/cpuset ] && echo yes || echo no',
    { asRoot: true, timeout: 15000 }
  );
  const [cgroup, cpuset] = String(cgroupInfo.stdout || '').split(/\r?\n/).map((s) => s.trim());
  assertCgroupVersionCompatible(job, { cgroup, cpuset }, options);

  let master = host;
  if (role === 'agent') {
    master = await resolveUpgradeMaster(ctx, host, options, nodeName);
    job.log(`确认节点状态用：${hostLabel(master)}`);
  }

  const step = job.startStep('执行 k3s 升级脚本');
  const script = buildK3sUpgradeScript({
    channel,
    version,
    installUrl: String(options.installUrl || cfg.installScriptUrl || 'https://get.k3s.io').trim(),
    mirror: options.mirror !== undefined ? String(options.mirror || '').trim() : String(cfg.mirror || '').trim(),
    mirrorUrl: String(options.mirrorUrl || cfg.mirrorUrl || 'https://rancher-mirror.rancher.cn/k3s').trim(),
    httpProxy: String(options.httpProxy || '').trim(),
    httpsProxy: String(options.httpsProxy || '').trim(),
    noProxy: String(options.noProxy || '').trim()
  });
  await execHostScript(job, ctx, host, script, { label: '升级 k3s', timeout: 900000 });
  job.finishStep(step, 'success', '升级脚本执行完成');
  kube.clearKubeCache();

  const nodes = await waitForCluster(job, ctx, master, {
    expectedNames: nodeName ? [nodeName] : [],
    timeout: Number(options.waitTimeoutMs) || 300000,
    title: '等待节点升级后恢复 Ready'
  });
  return { version, role, nodes };
}

// ------------------------------------------------------------------ cluster jobs

function nodeNameFor(host, detected) {
  return (host.k3s && host.k3s.nodeName) || (detected && detected.hostname) || host.host;
}

function pushUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

async function doK3sCluster(job, ctx, servers, agents, options) {
  const all = [...servers, ...agents];
  const offlinePackage = resolveOfflinePackage(ctx, options);
  const preflightByHost = new Map();
  for (const host of servers) {
    const result = await runPreflight(job, ctx, host, 'k3s-server', options);
    preflightByHost.set(host.id, result);
  }
  for (const host of agents) {
    const result = await runPreflight(job, ctx, host, 'k3s-agent', options);
    preflightByHost.set(host.id, result);
  }
  for (const host of all) {
    const result = preflightByHost.get(host.id);
    if (!result || !result.ok) throw new HttpError(412, '存在未通过预检的节点，已中止部署');
    assertInstallable(host, result.detected, options);
    assertCgroupVersionCompatible(job, result.detected, options);
    assertOfflinePackageArch(job, offlinePackage, result.detected, host);
  }
  if (options.installMode === 'offline') {
    for (const host of all) {
      if (offlinePackage) await stageOfflinePackage(job, ctx, host, offlinePackage);
      await validateOfflineBundle(job, ctx, host, options);
    }
  }

  const serverNames = servers.map((host) => nodeNameFor(host, preflightByHost.get(host.id).detected));
  const agentNames = agents.map((host) => nodeNameFor(host, preflightByHost.get(host.id).detected));
  const allNames = [...serverNames, ...agentNames];
  const duplicateName = allNames.find((name, index) => allNames.indexOf(name) !== index);
  if (duplicateName) throw new HttpError(400, `节点名称重复：${duplicateName}，请先修正主机名`);
  const tlsSans = [];
  for (const host of servers) {
    pushUnique(tlsSans, host.host);
    if (host.k3s && host.k3s.nodeIp) pushUnique(tlsSans, host.k3s.nodeIp);
  }

  const primary = servers[0];
  if (servers.length === 1) {
    job.log(`单机控制平面模式：1 台控制平面${agents.length ? `；工作节点 ${agents.length} 台` : ''}`);
  } else {
    job.log(`高可用模式：${servers.length} 台控制平面（etcd 容错 ${Math.floor((servers.length - 1) / 2)} 台）`);
  }
  const primaryResult = await installK3sServer(job, ctx, primary, {
    ...options,
    tlsSans,
    clusterInit: servers.length > 1,
    nodeName: serverNames[0]
  });
  let nodes = await waitForCluster(job, ctx, primary, {
    expectedNames: [serverNames[0]],
    timeout: Number(options.waitTimeoutMs) || 300000,
    title: '等待第 1 台控制平面就绪'
  });

  const token = primaryResult.token;
  const serverUrl = `https://${primary.host}:${k3sApiPort(ctx)}`;
  const installedServers = [primary.id];
  if (servers.length > 1) await waitForEtcd(job, ctx, primary);

  for (let i = 1; i < servers.length; i += 1) {
    const server = servers[i];
    job.log(`—— 加入控制平面 ${i + 1}/${servers.length}：${hostLabel(server)} ——`);
    await installK3sServer(job, ctx, server, {
      ...options,
      token,
      serverUrl,
      tlsSans,
      clusterInit: false,
      nodeName: serverNames[i]
    });
    await waitForEtcd(job, ctx, primary);
    nodes = await waitForCluster(job, ctx, primary, {
      expectedNames: [serverNames[i]],
      expectedCount: i + 1,
      timeout: Number(options.waitTimeoutMs) || 300000,
      title: `等待第 ${i + 1} 台控制平面就绪`
    });
    installedServers.push(server.id);
  }

  const installedAgents = [];
  for (const agent of agents) {
    job.log(`—— 开始安装工作节点 ${hostLabel(agent)} ——`);
    const hostname = nodeNameFor(agent, preflightByHost.get(agent.id).detected);
    await installK3sAgent(job, ctx, agent, { ...options, token, serverUrl, nodeName: hostname });
    nodes = await waitForCluster(job, ctx, primary, {
      expectedNames: [hostname],
      timeout: Number(options.waitTimeoutMs) || 300000,
      title: `等待 ${agent.name || agent.id} 就绪`
    });
    installedAgents.push(agent.id);
  }

  nodes = await kube.nodeList(primary, { config: ctx.config, transport: ctx.transport });
  const selfCheckTargets = [...servers, ...agents].map((host) => ({
    host,
    nodeName: nodeNameFor(host, preflightByHost.get(host.id).detected)
  }));
  await runNetworkSelfCheck(job, ctx, primary, selfCheckTargets, options);
  return {
    engine: 'k3s',
    mode: servers.length > 1 ? 'ha' : 'single',
    serverUrl,
    token,
    generatedToken: primaryResult.generatedToken,
    servers: installedServers,
    agents: installedAgents,
    nodes
  };
}

async function doClusterDeploy(job, ctx, payload) {
  const serverIds = asArray(payload.serverIds);
  if (!serverIds.length && payload.masterId) serverIds.push(String(payload.masterId));
  if (new Set(serverIds).size !== serverIds.length) throw new HttpError(400, '控制平面节点不能重复');
  if (![1, 3, 5].includes(serverIds.length)) {
    throw new HttpError(400, '控制平面数量必须是 1 台（单机）、3 台或 5 台（高可用）');
  }

  const servers = serverIds.map((id) => findHost(ctx, id, '控制平面'));
  const agentIds = asArray(payload.agentIds).filter((id) => !serverIds.includes(id));
  const agents = Array.from(new Set(agentIds)).map((id) => findHost(ctx, id, '工作节点'));
  const endpoints = [...servers, ...agents].map((h) => `${h.host}:${h.port || 22}`);
  const duplicateEndpoint = endpoints.find((endpoint, index) => endpoints.indexOf(endpoint) !== index);
  if (duplicateEndpoint) throw new HttpError(400, `部署目标重复：${duplicateEndpoint}，同一台机器不能重复选择`);
  for (const host of [...servers, ...agents]) {
    if ((host.transport || 'ssh') === 'kubeconfig') {
      throw new HttpError(400, `${hostLabel(host)} 是 kubeconfig 模式，不能作为部署目标`);
    }
  }
  const options = payload.options || {};
  if (options.force) job.log('已启用强制模式：将覆盖节点上已有的安装', 'warn');

  job.log(`部署 k3s：控制平面 ${servers.length} 台；工作节点 ${agents.length} 台`);
  return doK3sCluster(job, ctx, servers, agents, options);
}

async function doUninstall(job, ctx, host, options = {}) {
  const deepClean = !!(options.deepClean || options.removeData);
  const step = job.startStep('执行 k3s 卸载');
  job.log(deepClean
    ? '卸载模式：官方卸载 + 深度清理（会删除 k3s 数据目录、节点密码、残留服务单元、日志、CNI/IPVS/网络接口等）'
    : '卸载模式：仅执行 k3s 官方卸载脚本', deepClean ? 'warn' : 'info');
  await execHostScript(job, ctx, host, buildK3sUninstallScript({ deepClean }), {
    label: '卸载 k3s',
    timeout: 300000
  });
  job.finishStep(step, 'success', '卸载完成');
  kube.clearKubeCache();
  return { host: host.id, flavor: 'k3s' };
}

// 批量卸载：一台一个步骤，单台失败不会中断其余服务器（取消会中断全部）
async function doUninstallHosts(job, ctx, hosts, options = {}) {
  const list = Array.isArray(hosts) ? hosts : [];
  if (!list.length) throw new HttpError(400, '没有要卸载的服务器');
  const deepClean = !!(options.deepClean || options.removeData);
  job.log(`本次卸载 ${list.length} 台服务器，按顺序逐个执行`, 'info');
  job.log(deepClean
    ? '卸载模式：官方卸载 + 深度清理'
    : '卸载模式：仅执行 k3s 官方卸载脚本', deepClean ? 'warn' : 'info');

  const results = [];
  for (let index = 0; index < list.length; index += 1) {
    const host = list[index];
    const label = hostLabel(host);
    job.log(`[${index + 1}/${list.length}] 开始卸载 ${label}`);
    const step = job.startStep(`卸载 ${host.name || host.id}`);
    try {
      await execHostScript(job, ctx, host, buildK3sUninstallScript({ deepClean }), {
        label: `卸载 ${host.name || host.id}`,
        timeout: 300000
      });
      job.finishStep(step, 'success', '卸载完成');
      results.push({ host: host.id, name: label, ok: true });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      const cancelled = !!(job.cancelled || (err && (err.status === 499 || err.code === 499)));
      job.finishStep(step, 'failed', cancelled ? '已取消' : message);
      results.push({ host: host.id, name: label, ok: false, error: cancelled ? '已取消' : message });
      if (cancelled) {
        job.log('已取消，剩余服务器不再卸载', 'warn');
        kube.clearKubeCache();
        throw err;
      }
      job.log(`[${index + 1}/${list.length}] ${label} 卸载失败：${message}`, 'warn');
      job.log('继续卸载下一台服务器', 'warn');
    }
  }
  kube.clearKubeCache();
  const failed = results.filter((item) => !item.ok).length;
  if (failed) job.log(`${results.length} 台中有 ${failed} 台卸载失败，请查看上面的日志`, 'warn');
  return { hosts: results };
}

module.exports = {
  k3sOptions,
  resolveUpgradeMaster,
  buildK3sInstallScript,
  buildK3sUpgradeScript,
  buildK3sUninstallScript,
  doSingleInstall,
  doUpgrade,
  doClusterDeploy,
  doUninstall,
  doUninstallHosts,
  waitForCluster,
  readK3sToken,
  runPreflight,
  runNetworkSelfCheck,
  buildNetworkSelfCheckScript
};
