'use strict';

const { sq, parseSections, HttpError } = require('./util');
const kube = require('./kube');

// 把远程命令的输出逐行转成操作日志；日志回调本身出错不能影响命令执行。
function jobLineLogger(job) {
  if (!job) return null;
  return (line, stream) => {
    try {
      job.log(line, stream === 'stderr' ? 'warn' : 'info');
    } catch (_) {
      /* 忽略日志异常 */
    }
  };
}

function parseOsRelease(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

const DETECT_SCRIPT = [
  'echo "@@HOSTNAME@@"; hostname 2>/dev/null || true',
  'echo "@@OSRELEASE@@"; if [ -r /etc/os-release ]; then cat /etc/os-release; elif [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then v=$(sw_vers -productVersion 2>/dev/null); printf "NAME=macOS\\nID=macos\\nPRETTY_NAME=macOS%s\\nVERSION_ID=%s\\n" "${v:+ $v}" "$v"; fi || true',
  'echo "@@UNAME@@"; uname -srm 2>/dev/null || true',
  'echo "@@UPTIME@@"; if [ -r /proc/uptime ]; then cut -d" " -f1 /proc/uptime; else b=$(sysctl -n kern.boottime 2>/dev/null | sed -n "s/.*{ sec = \\([0-9][0-9]*\\),.*/\\1/p"); [ -n "$b" ] && expr "$(date +%s)" - "$b"; fi || true',
  'echo "@@UID@@"; id -u 2>/dev/null || echo 1000',
  'echo "@@USER@@"; id -un 2>/dev/null || whoami 2>/dev/null || true',
  'echo "@@SUDOOK@@"; if [ "$(id -u)" = "0" ]; then echo root; elif sudo -n true >/dev/null 2>&1; then echo yes; else echo no; fi',
  'echo "@@INIT@@"; ps -p 1 -o comm= 2>/dev/null || true',
  'echo "@@CGROUP@@"; stat -fc %T /sys/fs/cgroup 2>/dev/null || true',
  'echo "@@CPUSET@@"; [ -d /sys/fs/cgroup/cpuset ] && echo yes || echo no',
  'echo "@@K3S@@"; command -v k3s 2>/dev/null || true',
  'echo "@@K3SVER@@"; k3s --version 2>/dev/null | head -n 1 || true',
  'echo "@@K3SSVC@@"; systemctl is-active k3s 2>/dev/null || true',
  'echo "@@K3SAGENTSVC@@"; systemctl is-active k3s-agent 2>/dev/null || true',
  'echo "@@TOKENFILE@@"; [ -f /var/lib/rancher/k3s/server/node-token ] && echo yes || true',
  'echo "@@KUBECTL@@"; command -v kubectl 2>/dev/null || true',
  'echo "@@KUBELET@@"; command -v kubelet 2>/dev/null || true',
  'echo "@@KUBELETVER@@"; kubelet --version 2>/dev/null | head -n 1 || true',
  'echo "@@KUBELETSVC@@"; systemctl is-active kubelet 2>/dev/null || true',
  'echo "@@KUBECONFIG@@"; ls -1 /etc/rancher/k3s/k3s.yaml /etc/kubernetes/admin.conf "$HOME/.kube/config" 2>/dev/null || true',
  'echo "@@CONTAINERD@@"; containerd --version 2>/dev/null || true',
  'echo "@@DOCKER@@"; docker --version 2>/dev/null || true',
  'echo "@@CPU@@"; nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || true',
  'echo "@@MEM@@"; if [ -r /proc/meminfo ]; then awk "/MemTotal/{printf \\"%.0f\\\\n\\", \\$2/1024}" /proc/meminfo; else sysctl -n hw.memsize 2>/dev/null | awk "{printf \\"%.0f\\\\n\\", \\$1/1048576}"; fi || true',
  'echo "@@SWAP@@"; if [ -r /proc/meminfo ]; then awk "/SwapTotal/{printf \\"%.0f\\\\n\\", \\$2/1024}" /proc/meminfo; else sysctl -n vm.swapusage 2>/dev/null | awk -F"[ =]+" "{n=\\$2; u=substr(\\$2,length(\\$2)); sub(/[A-Za-z]+\\$/,\\"\\",n); if (u==\\"G\\") n*=1024; else if (u==\\"K\\") n/=1024; printf \\"%.0f\\\\n\\", n}"; fi || true',
  'echo "@@DISK@@"; (df -Pm /var/lib 2>/dev/null || df -Pm / 2>/dev/null) | awk "NR==2{print \\$4}" || true',
  'echo "@@IP@@"; if [ "$(uname -s 2>/dev/null)" = "Darwin" ]; then ipconfig getifaddr en0 2>/dev/null; else hostname -I 2>/dev/null | awk "{print \\$1}"; fi || true',
  'echo "@@PORTS@@"; (ss -lntH 2>/dev/null || netstat -lnt 2>/dev/null) | awk "{print \\$4}" | grep -E ":(6443|10250|8472|2379|2380)$" | sort -u || true',
  'echo "@@MODULES@@"; lsmod 2>/dev/null | grep -E "^(overlay|br_netfilter|nf_conntrack) " | awk "{print \\$1}" || true',
  'echo "@@DONE@@"'
].join('\n');

function baseResult(host) {
  return {
    id: host.id,
    name: host.name || host.id,
    group: host.group || '',
    transport: host.transport || 'ssh',
    address: host.transport === 'kubeconfig' ? (host.kubeconfig || 'kubeconfig') : `${host.host || ''}:${host.port || 22}`,
    reachable: false,
    checkedAt: new Date().toISOString()
  };
}

async function detectViaKubeconfig(host, ctx) {
  const result = baseResult(host);
  result.reachable = true;
  result.hostname = '（本地 kubeconfig）';
  result.user = process.env.USER || process.env.USERNAME || '';
  result.os = {
    id: process.platform,
    name: `${process.platform} (控制端)`,
    version: '',
    kernel: require('os').release(),
    arch: process.arch,
    pretty: `${process.platform} ${process.arch}`
  };
  result.isRoot = false;
  result.init = '';
  result.cgroup = '';
  result.resources = {};
  result.components = {
    k3s: { installed: false },
    kubectl: { installed: !!host.kubectlPath, path: host.kubectlPath || 'kubectl' },
    containerd: { installed: false },
    docker: { installed: false }
  };
  result.kubeconfig = { path: host.kubeconfig || '', exists: true };
  result.portsInUse = [];
  result.modules = [];

  try {
    const overview = await kube.clusterOverview(host, ctx);
    result.cluster = {
      reachable: true,
      version: overview.serverVersion,
      nodeCount: overview.nodeStats.total,
      readyNodes: overview.nodeStats.ready,
      error: null
    };
    result.k8s = {
      installed: true,
      flavor: 'external',
      version: overview.serverVersion,
      role: 'external',
      managed: true
    };
    try {
      result.nodes = await kube.nodeList(host, { ...ctx, timeout: 15000 });
    } catch (_) {
      result.nodes = [];
    }
  } catch (err) {
    result.cluster = { reachable: false, version: '-', nodeCount: 0, readyNodes: 0, error: err.message };
    result.k8s = { installed: false, flavor: 'none', version: '-', role: 'unknown', managed: false };
  }
  return result;
}

async function detectHost(host, ctx) {
  const transportKind = host.transport || 'ssh';
  if (transportKind === 'kubeconfig') {
    return detectViaKubeconfig(host, ctx);
  }

  const result = baseResult(host);
  let exec;
  try {
    exec = await ctx.transport.execScript(host, DETECT_SCRIPT, { timeout: 30000 });
  } catch (err) {
    const message = (err && err.message) || 'SSH 连接失败';
    result.error = message;
    // 认证失败与网络不可达是两类问题：前者是凭据不对，界面上要单独标出来
    if (/SSH 认证失败|All configured authentication methods failed/i.test(message)) {
      result.authFailed = true;
    }
    return result;
  }
  if (exec.code !== 0 && !exec.stdout.trim()) {
    result.error = exec.stderr.trim() || `检测脚本退出码 ${exec.code}`;
    return result;
  }

  result.reachable = true;
  const s = parseSections(exec.stdout);
  const osRelease = parseOsRelease(s.OSRELEASE);
  const unameParts = (s.UNAME || '').trim().split(/\s+/);
  result.hostname = (s.HOSTNAME || '').trim() || host.host;
  result.user = (s.USER || '').trim();
  result.isRoot = (s.UID || '').trim() === '0';
  result.sudo = (s.SUDOOK || '').trim();
  result.init = (s.INIT || '').trim();
  result.cgroup = (s.CGROUP || '').trim();
  result.cpuset = (s.CPUSET || '').trim();
  result.os = {
    id: osRelease.ID || '',
    name: osRelease.NAME || '',
    version: osRelease.VERSION_ID || '',
    pretty: osRelease.PRETTY_NAME || unameParts.slice(0, 1).join(' '),
    kernel: unameParts.slice(1).join(' '),
    arch: unameParts[2] || '',
    uname: (s.UNAME || '').trim()
  };
  result.resources = {
    cpu: Number((s.CPU || '0').trim()) || 0,
    memMB: Number((s.MEM || '0').trim()) || 0,
    swapMB: Number((s.SWAP || '0').trim()) || 0,
    diskFreeMB: Number((s.DISK || '0').trim()) || 0,
    uptimeSeconds: Number((s.UPTIME || '0').trim()) || 0
  };
  result.components = {
    k3s: {
      installed: !!(s.K3S || '').trim(),
      path: (s.K3S || '').trim(),
      version: (s.K3SVER || '').trim(),
      service: (s.K3SSVC || '').trim() || 'inactive',
      agentService: (s.K3SAGENTSVC || '').trim() || 'inactive',
      hasToken: (s.TOKENFILE || '').trim() === 'yes'
    },
    kubectl: { installed: !!(s.KUBECTL || '').trim(), path: (s.KUBECTL || '').trim() },
    kubelet: {
      installed: !!(s.KUBELET || '').trim(),
      version: (s.KUBELETVER || '').trim(),
      service: (s.KUBELETSVC || '').trim() || 'inactive'
    },
    containerd: { installed: !!(s.CONTAINERD || '').trim(), version: (s.CONTAINERD || '').trim() },
    docker: { installed: !!(s.DOCKER || '').trim(), version: (s.DOCKER || '').trim() }
  };
  const kubeconfigs = (s.KUBECONFIG || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  result.kubeconfig = {
    path: host.kubeconfig || kubeconfigs[0] || '',
    exists: kubeconfigs.length > 0,
    candidates: kubeconfigs
  };
  result.portsInUse = (s.PORTS || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  result.modules = (s.MODULES || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  result.ip = (s.IP || '').trim();

  const k3sInstalled = result.components.k3s.installed;
  const standardKubeconfig = kubeconfigs.some((p) => p.includes('/etc/kubernetes/'));
  const kubeletActive = result.components.kubelet.service === 'active';
  let flavor = 'none';
  if (k3sInstalled) flavor = 'k3s';
  else if (standardKubeconfig || kubeletActive) flavor = 'k8s';

  let role = 'unknown';
  if (result.components.k3s.service === 'active') role = 'server';
  else if (result.components.k3s.agentService === 'active') role = 'agent';
  else if (standardKubeconfig) role = 'control-plane';
  else if (kubeletActive) role = 'agent';

  const kubeletVersion = (result.components.kubelet.version.match(/v?\d+\.\d+\.\d+[^\s]*/) || [''])[0];
  result.k8s = {
    installed: flavor !== 'none',
    flavor,
    version: result.components.k3s.version || kubeletVersion,
    role,
    managed: false
  };

  if (flavor !== 'none') {
    try {
      const nodes = await kube.nodeList(host, { ...ctx, timeout: 15000 });
      const own = nodes.find((n) => n.name === result.hostname);
      result.cluster = {
        reachable: true,
        version: (nodes[0] && nodes[0].version) || result.k8s.version || '-',
        nodeCount: nodes.length,
        readyNodes: nodes.filter((n) => n.ready).length,
        error: null
      };
      if (own) {
        result.k8s.managed = true;
        if (own.roleList.some((r) => r.includes('master') || r.includes('control-plane'))) role = 'server';
        else if (role === 'unknown' || role === 'external') role = 'agent';
      }
      result.nodes = nodes;
      try {
        const access = await kube.kubeAccess(host, ctx);
        if (access.via) result.kubeAccess = { mode: access.mode, via: access.via };
      } catch (_) { /* 读不到来源不影响检测结果 */ }
    } catch (err) {
      result.cluster = {
        reachable: false,
        version: result.k8s.version || '-',
        nodeCount: 0,
        readyNodes: 0,
        error: err.message
      };
    }
  } else {
    result.cluster = { reachable: false, version: '-', nodeCount: 0, readyNodes: 0, error: '未安装 Kubernetes' };
  }
  result.k8s.role = role;
  return result;
}

const PORT_NAMES = {
  6443: 'Kubernetes API (6443)',
  10250: 'kubelet (10250)',
  8472: 'flannel VXLAN (8472)',
  2379: 'etcd client (2379)',
  2380: 'etcd peer (2380)'
};

async function preflight(host, ctx, options = {}) {
  const mode = options.mode || 'k3s-server';
  const detected = await detectHost(host, ctx);
  const checks = [];
  const add = (id, label, status, detail) => checks.push({ id, label, status, detail });

  if (!detected.reachable) {
    add('reachable', 'SSH 连通性', 'fail', detected.error || '无法连接主机');
    return { ok: false, checks, detected };
  }
  add('reachable', 'SSH 连通性', 'pass', `已连接 ${detected.address}，耗时正常`);
  add('os', '操作系统', 'pass', detected.os.pretty || detected.os.id || '未知');
  add('arch', 'CPU 架构', ['x86_64', 'aarch64', 'arm64', 'armv7l'].includes(detected.os.arch) ? 'pass' : 'warn',
    `${detected.os.arch || '未知'}，k3s 支持 amd64 / arm64 / armhf`);

  if (detected.isRoot) add('root', '执行权限', 'pass', '当前用户为 root');
  else if (detected.sudo === 'yes') add('root', '执行权限', 'pass', '当前用户可免密 sudo');
  else add('root', '执行权限', 'fail', '需要 root 或免密 sudo（NOPASSWD）才能安装 k3s');

  if ((detected.init || '').includes('systemd')) add('systemd', 'systemd', 'pass', '已检测到 systemd');
  else add('systemd', 'systemd', 'warn', detected.init ? `PID 1 为 ${detected.init}，非 systemd 环境 k3s 服务可能无法托管` : '未能确认 systemd');

  if (detected.cgroup === 'cgroup2fs' && detected.cpuset !== 'yes') {
    add('cgroup', 'Cgroup', 'fail', 'cgroup v2 缺少 cpuset 控制器（常见于 4.19 内核）。k3s 无法启动；请将 GRUB 参数改为 systemd.unified_cgroup_hierarchy=0 后重启，或升级到 5.x+ 内核');
  } else if (detected.cgroup === 'cgroup2fs') {
    add('cgroup', 'Cgroup', 'pass', 'cgroup v2（cpuset 可用）');
  } else if (detected.cgroup === 'tmpfs') {
    add('cgroup', 'Cgroup', 'warn', 'cgroup v1：k3s v1.35+ 已不支持，请使用 v1.34.x 或更早版本');
  } else {
    add('cgroup', 'Cgroup', 'warn', `未识别的 cgroup（${detected.cgroup || '未知'}）`);
  }

  if (detected.resources.memMB >= 1700) add('memory', '内存', 'pass', `${detected.resources.memMB} MB`);
  else add('memory', '内存', 'warn', `${detected.resources.memMB || 0} MB，低于建议的 2 GB`);

  if (detected.resources.diskFreeMB >= 5120) add('disk', '磁盘空间', 'pass', `/var/lib 剩余 ${(detected.resources.diskFreeMB / 1024).toFixed(1)} GB`);
  else add('disk', '磁盘空间', 'warn', `/var/lib 剩余 ${(detected.resources.diskFreeMB || 0) / 1024} GB，建议至少 5 GB`);

  const serverMode = mode === 'k3s-server';
  const requiredPorts = serverMode ? [6443, 10250, 8472, 2379, 2380] : [10250];
  const occupied = (detected.portsInUse || []).filter((p) => requiredPorts.some((port) => p.endsWith(':' + port)));
  if (occupied.length) add('ports', '端口占用', 'warn', `以下端口已被占用：${occupied.join(', ')}（若为已有 k8s 组件请确认）`);
  else add('ports', '端口占用', 'pass', requiredPorts.map((p) => PORT_NAMES[p] || p).join('、') + ' 可用');

  if (detected.components.k3s.installed) {
    add('existing', '已有 Kubernetes', 'warn', `已检测到 k3s（${detected.components.k3s.version || '版本未知'}，服务 ${detected.components.k3s.service}），继续安装将覆盖现有配置`);
  } else if (detected.k8s && detected.k8s.installed) {
    add('existing', '已有 Kubernetes', 'warn', '已检测到标准 Kubernetes 组件，继续安装可能冲突');
  }

  if (detected.resources.swapMB > 0) {
    add('swap', 'Swap', 'warn', `Swap 已启用（${detected.resources.swapMB} MB），k3s 建议关闭`);
  } else {
    add('swap', 'Swap', 'pass', '未启用 Swap');
  }

  if (mode === 'k3s-server' || mode === 'k3s-agent') {
    if (options.installMode === 'offline') {
      add('network', '安装源连通性', 'pass', '离线安装：不检查外网安装源');
    } else {
      let netOk = false;
      let netDetail = '';
      try {
        const net = await ctx.transport.execScript(
          host,
          [
            `echo "@@CURL@@"`,
            'if command -v curl >/dev/null 2>&1; then',
            '  if curl -fsSL -m 8 -o /dev/null "${INSTALL_URL}" 2>/dev/null; then echo "curl-ok"; else echo "curl-fail"; fi',
            'elif command -v wget >/dev/null 2>&1; then',
            '  if wget -q -T 8 -O /dev/null "${INSTALL_URL}" 2>/dev/null; then echo "wget-ok"; else echo "wget-fail"; fi',
            'else echo "no-tool"; fi',
            `echo "@@END@@"`
          ].join('\n').replace(/\$\{INSTALL_URL\}/g, (ctx.config.k3s && ctx.config.k3s.installScriptUrl) || 'https://get.k3s.io'),
          { timeout: 20000 }
        );
        const sec = parseSections(net.stdout);
        const status = (sec.CURL || '').trim();
        netOk = status === 'curl-ok' || status === 'wget-ok';
        netDetail = status === 'no-tool' ? '未找到 curl / wget' : netOk ? '可访问安装脚本地址' : '无法访问安装脚本地址（离线环境需自备二进制）';
      } catch (err) {
        netDetail = err.message;
      }
      add('network', '安装源连通性', netOk ? 'pass' : 'warn', netDetail);
    }
  }

  const ok = !checks.some((c) => c.status === 'fail');
  return { ok, checks, detected };
}

const LIST_IMAGES_SCRIPT = [
  'set -e',
  'if command -v k3s >/dev/null 2>&1; then',
  '  k3s crictl images -o json',
  'elif command -v crictl >/dev/null 2>&1; then',
  '  crictl images -o json',
  'else',
  '  echo "没有找到 k3s crictl 或 crictl" >&2',
  '  exit 3',
  'fi'
].join('\n');

async function listImages(host, ctx) {
  if ((host.transport || 'ssh') === 'kubeconfig') {
    throw new HttpError(400, 'kubeconfig 接入方式不能读取节点镜像，请使用 SSH 接入');
  }
  const result = await ctx.transport.execScript(host, LIST_IMAGES_SCRIPT, {
    asRoot: true,
    timeout: 20000
  });
  if (result.code !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().split('\n').slice(-3).join(' ');
    throw new HttpError(400, `读取 k3s 镜像失败：${detail || '命令执行失败'}`);
  }
  const text = String(result.stdout || '').trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) {
    throw new HttpError(502, 'k3s crictl 返回的内容不是有效 JSON');
  }
  let data;
  try {
    data = JSON.parse(text.slice(start, end + 1));
  } catch (_) {
    throw new HttpError(502, '解析 k3s 镜像列表失败');
  }
  const images = (Array.isArray(data.images) ? data.images : []).map((item) => {
    const repoTags = Array.isArray(item.repoTags) ? item.repoTags.filter(Boolean) : [];
    const repoDigests = Array.isArray(item.repoDigests) ? item.repoDigests.filter(Boolean) : [];
    return {
      id: item.id || '',
      repoTags,
      repoDigests,
      size: Number(item.size) || 0,
      createdAt: Number(item.createdAt) || 0
    };
  }).sort((a, b) => {
    const left = (a.repoTags[0] || a.id || '').localeCompare(b.repoTags[0] || b.id || '');
    return left;
  });
  return { images, total: images.length, fetchedAt: new Date().toISOString() };
}

function safeImageFileBase(image) {
  const base = String(image || '')
    .replace(/^[a-z]+:\/\//i, '')
    .replace(/[:/\\]/g, '_')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
  return base || 'image';
}

async function exportImageTar(host, ctx, image, opts = {}) {
  if ((host.transport || 'ssh') !== 'ssh') {
    throw new HttpError(400, '只有 SSH 接入方式支持导出镜像 tar');
  }
  const job = opts.job || null;
  if (job) job.checkCancelled();
  const ref = String(image || '').trim();
  if (!ref || ref === '<none>') throw new HttpError(400, '请选择有效的镜像');
  if (ref.length > 512) throw new HttpError(400, '镜像名过长');
  const fileName = `${safeImageFileBase(ref)}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.tar`;
  const remotePath = `/tmp/${fileName}`;
  const script = [
    'set -e',
    `out=${sq(remotePath)}`,
    `img=${sq(ref)}`,
    'if command -v k3s >/dev/null 2>&1; then',
    '  k3s ctr -n k8s.io images export "$out" "$img"',
    'elif command -v ctr >/dev/null 2>&1; then',
    '  ctr -n k8s.io images export "$out" "$img"',
    'else',
    '  echo "没有找到 k3s ctr 或 ctr" >&2',
    '  exit 3',
    'fi',
    'test -s "$out"'
  ].join('\n');
  let killFn = null;
  const onStart = job
    ? (kill) => {
      killFn = kill;
      job.registerKill(kill);
    }
    : null;
  let result;
  try {
    result = await ctx.transport.execScript(host, script, {
      asRoot: true,
      timeout: 300000,
      onStart,
      onLine: jobLineLogger(job)
    });
    if (job) job.checkCancelled();
    if (result.code !== 0) {
      const detail = String(result.stderr || result.stdout || '').trim().split('\n').slice(-4).join(' ');
      throw new HttpError(400, `导出镜像 tar 失败：${detail || '命令执行失败'}`);
    }
    return { path: remotePath, name: fileName };
  } catch (err) {
    // 取消或失败时节点上可能已经留下半个 tar，统一清理，避免 /tmp 越积越多
    await removeImageTar(host, ctx, remotePath);
    if (job) job.log(`已删除节点临时文件 ${remotePath}`);
    throw err;
  } finally {
    if (killFn && job) job.unregisterKill(killFn);
  }
}

async function importImageTar(host, ctx, remotePath, opts = {}) {
  if ((host.transport || 'ssh') !== 'ssh') {
    throw new HttpError(400, '只有 SSH 接入方式支持导入镜像 tar');
  }
  const job = opts.job || null;
  if (job) job.checkCancelled();
  const script = [
    'set -e',
    `tar=${sq(remotePath)}`,
    'if command -v k3s >/dev/null 2>&1; then',
    '  k3s ctr -n k8s.io images import "$tar"',
    'elif command -v ctr >/dev/null 2>&1; then',
    '  ctr -n k8s.io images import "$tar"',
    'else',
    '  echo "没有找到 k3s ctr 或 ctr" >&2',
    '  exit 3',
    'fi'
  ].join('\n');
  let killFn = null;
  const onStart = job
    ? (kill) => {
      killFn = kill;
      job.registerKill(kill);
    }
    : null;
  let result;
  try {
    result = await ctx.transport.execScript(host, script, {
      asRoot: true,
      timeout: 300000,
      onStart,
      onLine: jobLineLogger(job)
    });
  } finally {
    if (killFn && job) job.unregisterKill(killFn);
  }
  if (job) job.checkCancelled();
  if (result.code !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().split('\n').slice(-4).join(' ');
    throw new HttpError(400, `导入镜像 tar 失败：${detail || '命令执行失败'}`);
  }
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return {
    output: output.split('\n').slice(-20).join('\n'),
    importedAt: new Date().toISOString()
  };
}

// 远程 tar 大小，用于导出后展示体积（失败返回 0，不影响主流程）。
async function remoteFileSize(host, ctx, remotePath) {
  try {
    const result = await ctx.transport.execScript(host, `wc -c < ${sq(remotePath)}`, { asRoot: true, timeout: 20000 });
    if (result.code !== 0) return 0;
    return Number(String(result.stdout || '').trim()) || 0;
  } catch (_) {
    return 0;
  }
}

async function pullImage(host, ctx, image, opts = {}) {
  if ((host.transport || 'ssh') !== 'ssh') {
    throw new HttpError(400, '只有 SSH 接入方式支持拉取节点镜像');
  }
  const ref = String(image || '').trim();
  if (!ref) throw new HttpError(400, '请填写镜像地址');
  if (ref.length > 512) throw new HttpError(400, '镜像地址过长');
  if (/[\r\n\0]/.test(ref)) throw new HttpError(400, '镜像地址包含非法字符');
  const username = String(opts.username || '').trim();
  const password = String(opts.password || '');
  if (username.length > 256 || password.length > 1024) throw new HttpError(400, '仓库凭据过长');
  if (/[\r\n\0]/.test(username) || /[\r\n\0]/.test(password)) throw new HttpError(400, '仓库凭据包含非法字符');
  if (username && !password) throw new HttpError(400, '填写用户名时请同时填写密码或 Token');
  if (!username && password) throw new HttpError(400, '填写密码或 Token 时请同时填写用户名');
  const auth = username ? ` --user ${sq(`${username}:${password}`)}` : '';
  const creds = username ? ` --creds ${sq(`${username}:${password}`)}` : '';
  const script = [
    'set -e',
    `img=${sq(ref)}`,
    'if command -v k3s >/dev/null 2>&1; then',
    `  k3s ctr -n k8s.io images pull${auth} "$img"`,
    'elif command -v ctr >/dev/null 2>&1; then',
    `  ctr -n k8s.io images pull${auth} "$img"`,
    'elif command -v crictl >/dev/null 2>&1; then',
    `  crictl pull${creds} "$img"`,
    'else',
    '  echo "没有找到 k3s ctr、ctr 或 crictl" >&2',
    '  exit 3',
    'fi'
  ].join('\n');
  const result = await ctx.transport.execScript(host, script, {
    asRoot: true,
    timeout: 900000
  });
  if (result.code !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().split('\n').slice(-6).join(' ');
    throw new HttpError(400, `拉取镜像失败：${detail || '命令执行失败'}`);
  }
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return { image: ref, output: output.split('\n').slice(-12).join('\n') };
}

async function removeImage(host, ctx, image) {
  if ((host.transport || 'ssh') !== 'ssh') {
    throw new HttpError(400, '只有 SSH 接入方式支持删除节点镜像');
  }
  const ref = String(image || '').trim();
  if (!ref || ref === '<none>') throw new HttpError(400, '请选择有效的镜像');
  if (ref.length > 512) throw new HttpError(400, '镜像名过长');
  const script = [
    'set -e',
    `img=${sq(ref)}`,
    'if command -v k3s >/dev/null 2>&1; then',
    '  k3s crictl rmi "$img"',
    'elif command -v crictl >/dev/null 2>&1; then',
    '  crictl rmi "$img"',
    'elif command -v ctr >/dev/null 2>&1; then',
    '  ctr -n k8s.io images rm "$img"',
    'else',
    '  echo "没有找到 k3s crictl、crictl 或 ctr" >&2',
    '  exit 3',
    'fi'
  ].join('\n');
  const result = await ctx.transport.execScript(host, script, {
    asRoot: true,
    timeout: 60000
  });
  if (result.code !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().split('\n').slice(-4).join(' ');
    throw new HttpError(400, `删除镜像失败：${detail || '命令执行失败'}`);
  }
  const output = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
  return { output: output.split('\n').slice(-10).join('\n'), removedAt: new Date().toISOString() };
}

async function removeImageTar(host, ctx, remotePath) {
  try {
    await ctx.transport.execScript(host, `rm -f ${sq(remotePath)}`, { asRoot: true, timeout: 10000 });
  } catch (_) {
    /* 临时文件清理失败不影响下载结果 */
  }
}

module.exports = { detectHost, preflight, listImages, exportImageTar, importImageTar, pullImage, removeImage, removeImageTar, remoteFileSize, DETECT_SCRIPT, parseOsRelease };
