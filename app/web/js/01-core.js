
'use strict';

/* ============================================================
 * 常量与状态
 * ============================================================ */
const DEMO = new URLSearchParams(location.search).has('demo');
const TOKEN_KEY = 'k8s-maintainer-token';
const ACTIVE_KEY = 'k8s-maintainer-active-host';
const THEME_KEY = 'k3s-theme';
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

function applyTheme(theme, options = {}) {
  const next = theme === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  document.documentElement.style.colorScheme = next;
  if (options.persist !== false) {
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch (e) { /* 隐私模式下无法持久化时只切换当前页面 */ }
  }
  const button = $('#themeBtn');
  if (button) {
    const light = next === 'light';
    button.title = light ? '切换为黑夜模式' : '切换为白天模式';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('aria-pressed', light ? 'true' : 'false');
  }
}

function toggleTheme() {
  applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
}

function bindTheme() {
  applyTheme(currentTheme(), { persist: false });
  const button = $('#themeBtn');
  if (button) button.addEventListener('click', toggleTheme);
}

const S = {
  health: null,
  meta: null,
  config: null,
  hosts: [],
  groups: [],
  activeHostId: localStorage.getItem(ACTIVE_KEY) || '',
  selectedHostIds: [],
  // 组件与镜像页：子页签 + 「查看服务器内镜像」当前查看的服务器、镜像缓存与本地筛选
  componentsTab: 'components',
  imageCategory: 'all',
  // 镜像清单（分类 + 镜像）来自工程预置的 data/image-management/images.json
  imageCatalog: { categories: [], images: [], skipped: 0, missing: false, file: '', error: '', loaded: false },
  hostImageTarget: '',
  hostImages: {},
  hostImageFilters: { name: '', id: '' },
  view: 'dashboard',
  detected: {},
  overview: {},
  overviewLoading: {},
  namespaces: {},
  kubeAccess: {},
  ingressClasses: {},
  ingressClassesLoading: {},
  resources: {},
  resourceLoading: {},
  jobs: [],
  jobTimer: null,
  page: {
    hostsQuery: '',
    collapsedGroups: {},
    kind: 'pods',
    namespace: '',
    search: '',
    page: 1,
    settingsTab: 'config'
  },
  detail: null,
  installTarget: null,
  cluster: null,
  clusterModalHostId: null,
  workloadData: null,
  deployForm: null,
  deployTab: 'install',
  k3sPage: 'install',
  k3sUninstallHostIds: [],
  podConfigTypeFilter: 'all',
  navDeployOpen: false,
  offlinePackages: [],
  offlinePackagesLoaded: false,
  offlinePackagesError: '',
  offlinePackagesStamp: '',
  deploymentTemplates: [],
  deploymentTemplatesLoaded: false,
  imageRepository: null,
  baseImageVersions: {},
  settingsDraft: null
};

const VIEW_META = {
  dashboard: { kicker: 'OVERVIEW', title: '概览', sub: '服务器与集群汇总，点击数字查看明细' },
  hosts: { kicker: 'SERVER INVENTORY', title: '服务器', sub: '选择服务器查看系统与集群，集群详情以推窗展示' },
  workloads: { kicker: 'WORKLOADS', title: '工作负载', sub: '浏览、查看与修改集群资源' },
  deploy: { kicker: 'DEPLOY', title: '部署中心', sub: 'k3s 安装/卸载、升级、组件与镜像、Pod 部署' },
  jobs: { kicker: 'ACTIVITY', title: '操作记录', sub: '安装、部署、升级、卸载等操作记录，持久化保存在项目 log 目录' },
  settings: { kicker: 'SETTINGS', title: '设置', sub: 'config.json 配置、访问安全与运行信息' }
};

const DEPLOY_TABS = ['install', 'upgrade', 'components', 'custom'];
const DEPLOY_TAB_META = {
  install: { label: 'k3s 安装/卸载', desc: '安装新集群，或卸载已有 k3s 节点' },
  upgrade: { label: 'k3s 升级', desc: '逐台升级现有 k3s 节点' },
  components: { label: '组件与镜像', desc: 'Helm 插件按用途分类，常用基础镜像可直接复制使用' },
  custom: { label: 'Pod 部署', desc: '下发 YAML 或部署 Pod / 工作负载' }
};

/* ============================================================
 * 基础工具
 * ============================================================ */
function esc(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripAnsi(value) {
  return String(value === undefined || value === null ? '' : value)
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '');
}

function icon(name, cls = '') {
  return `<svg class="${cls}" aria-hidden="true"><use href="#i-${name}"/></svg>`;
}

function badge(text, tone = 'neutral') {
  return `<span class="badge ${tone}">${esc(text)}</span>`;
}

function age(iso) {
  if (!iso) return '-';
  const diff = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diff) || diff < 0) return '-';
  const s = Math.floor(diff / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h';
  const d = Math.floor(h / 24);
  if (d < 30) return d + 'd';
  return Math.floor(d / 30) + 'mo';
}

function fmtTime(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('zh-CN', { hour12: false });
  } catch (_) {
    return iso;
  }
}

function shortTime(iso) {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleTimeString('zh-CN', { hour12: false });
  } catch (_) {
    return iso;
  }
}

function duration(startIso, endIso) {
  if (!startIso) return '-';
  const end = endIso ? new Date(endIso).getTime() : Date.now();
  const sec = Math.max(0, Math.round((end - new Date(startIso).getTime()) / 1000));
  if (sec < 60) return sec + ' 秒';
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return `${min} 分 ${rem} 秒`;
  return `${Math.floor(min / 60)} 时 ${min % 60} 分`;
}

function fmtBytes(mb) {
  if (!mb && mb !== 0) return '-';
  if (mb >= 1024) return (mb / 1024).toFixed(1) + ' GB';
  return Math.round(mb) + ' MB';
}

function fmtUptime(seconds) {
  const sec = Number(seconds) || 0;
  if (sec <= 0) return '-';
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  const mins = Math.floor((sec % 3600) / 60);
  return hours > 0 ? `${hours} 小时 ${mins} 分` : `${mins} 分`;
}

function truncate(text, max = 80) {
  const str = String(text || '');
  return str.length > max ? str.slice(0, max) + '…' : str;
}

function statusTone(status) {
  const s = String(status || '').toLowerCase();
  if (['running', 'ready', 'active', 'bound', 'complete', 'succeeded', 'available', 'healthy'].includes(s)) return 'ok';
  if (['pending', 'containercreating', 'terminating', 'schedulingdisabled', 'suspended', 'notready', 'warning', 'unknown', 'cancelling'].includes(s)) return 'warn';
  if (['failed', 'error', 'crashloopbackoff', 'imagepullbackoff', 'errimagepull', 'evicted', 'notfound', 'unhealthy'].includes(s)) return 'err';
  return 'neutral';
}

function statusBadge(status) {
  const tone = statusTone(status);
  const dot = tone === 'ok' ? '<i class="dot ok"></i>' : tone === 'warn' ? '<i class="dot warn"></i>' : tone === 'err' ? '<i class="dot err"></i>' : '';
  return `<span class="badge ${tone}">${dot}${esc(status || '-')}</span>`;
}

function toast(message, type = 'info', timeout = 4500) {
  const root = $('#toasts');
  const el = document.createElement('div');
  el.className = 'toast ' + (type === 'error' ? 'err' : type === 'success' ? 'ok' : '');
  const iconName = type === 'error' ? 'alert' : type === 'success' ? 'check' : 'zap';
  el.innerHTML = `${icon(iconName)}<div class="tx">${esc(message)}</div><button class="close" aria-label="关闭">×</button>`;
  root.appendChild(el);
  const remove = () => { el.style.opacity = '0'; setTimeout(() => el.remove(), 180); };
  el.querySelector('.close').addEventListener('click', remove);
  setTimeout(remove, timeout);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板', 'success', 1800);
  } catch (_) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板', 'success', 1800); } catch (err) { toast('复制失败，请手动选择文本', 'error'); }
    ta.remove();
  }
}

function token() {
  return sessionStorage.getItem(TOKEN_KEY) || '';
}

function withToken(path) {
  const t = token();
  return t ? path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(t) : path;
}

async function api(path, options = {}) {
  if (DEMO && path !== '/meta') return demoApi(path, options);
  const headers = { 'Content-Type': 'application/json' };
  if (token()) headers['X-Access-Token'] = token();
  let res;
  try {
    res = await fetch('/api' + path, {
      method: options.method || 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined
    });
  } catch (err) {
    throw new Error('无法连接控制台后端，请确认 Node 服务正在运行');
  }
  let json = null;
  try { json = await res.json(); } catch (_) { /* ignore */ }
  if (res.status === 401) {
    showTokenModal();
    throw new Error('需要访问令牌');
  }
  if (!res.ok || !json || json.ok === false) {
    const err = new Error((json && json.error) || `请求失败（HTTP ${res.status}）`);
    err.detail = json && json.detail;
    err.status = res.status;
    throw err;
  }
  return json.data;
}

async function mapLimit(items, limit, fn) {
  const list = Array.from(items);
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, list.length) }, async () => {
    while (index < list.length) {
      const current = index++;
      await fn(list[current], current);
    }
  });
  await Promise.all(workers);
}

function debounce(fn, wait = 250) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function errorText(err) {
  if (!err) return '未知错误';
  return err.message || String(err);
}

/* ============================================================
 * 状态查询
 * ============================================================ */
function findHost(id) {
  return S.hosts.find((h) => h.id === id) || null;
}

function activeHost() {
  return findHost(S.activeHostId) || null;
}

function hostAddress(host) {
  if (!host) return '-';
  if (host.transport === 'kubeconfig') return host.kubeconfig || 'kubeconfig';
  if (host.transport === 'local') return '本机';
  return `${host.host || ''}${host.port && host.port !== 22 ? ':' + host.port : ''}`;
}

function hostName(host) {
  return (host && (host.name || host.id)) || '未命名主机';
}

// 真实角色：以探测结果（k8s.role）为准，探测不到才退回服务器上声明的 role。
// 声明角色只是添加/部署时的意图，集群实际部署成什么样才算数。
function hostEffectiveRole(host) {
  if (!host) return 'auto';
  const k8s = (S.detected[host.id] || {}).k8s || {};
  const detected = k8s.role;
  if (detected && detected !== 'unknown' && detected !== 'none') return detected;
  return host.role || 'auto';
}

function hostRoleLabel(host) {
  const role = hostEffectiveRole(host);
  if (role === 'server' || role === 'control-plane' || role === 'master') return '控制面';
  if (role === 'agent' || role === 'worker') return '工作节点';
  if (role === 'external') return '外部集群';
  return '';
}

function k8sFlavorLabel(k8s) {
  if (!k8s || !k8s.installed) return '未安装';
  if (k8s.flavor === 'k3s') return 'k3s';
  if (k8s.flavor === 'external') return '外部 Kubernetes';
  if (k8s.flavor === 'k8s') return 'Kubernetes';
  return '未知集群';
}

// SSH 认证失败时不要再笼统显示「离线」：密码错和网络不通是两回事
function hostAuthFailureLabel(host) {
  const type = (host && host.auth && host.auth.type) || 'password';
  return type === 'password' ? '密码错误' : '认证失败';
}

function hostState(host) {
  const info = S.detected[host.id];
  if (!info) return { tone: 'neutral', text: '未读取', dot: '' };
  if (info.loading) return { tone: 'info', text: '读取中', dot: 'info pulse' };
  if (info.authFailed) return { tone: 'err', text: hostAuthFailureLabel(host), dot: 'err' };
  if (info.error || !info.reachable) return { tone: 'err', text: '离线', dot: 'err' };
  if (info.k8s && info.k8s.installed) {
    return { tone: 'ok', text: '已安装', dot: 'ok' };
  }
  return { tone: 'warn', text: '待部署', dot: 'warn' };
}

function hostStatusBadge(host) {
  const state = hostState(host);
  const info = S.detected[host.id];
  const reason = info && !info.loading && info.error ? ` title="${esc(info.error)}"` : '';
  return `<span class="badge ${state.tone}"${reason}><i class="dot ${state.dot}"></i>${esc(state.text)}</span>`;
}

function clusterCapable(host) {
  const info = S.detected[host.id];
  return !!(info && info.reachable && info.k8s && info.k8s.installed);
}

// 本地接入 = 控制端即节点；k3s 只提供 Linux 版本，所以只有 Linux 控制端能用
function isLinuxHost() {
  return !!(S.health && /^linux/i.test(S.health.platform || ''));
}

function localTransportBlockReason() {
  if (isLinuxHost()) return '';
  const platform = (S.health && S.health.platform) || '';
  if (/^darwin/i.test(platform)) return '本地接入要求控制端本身是 Linux 节点；macOS 不能运行 k3s，请改用 SSH 或 kubeconfig';
  if (/^win/i.test(platform)) return '本地接入要求控制端本身是 Linux 节点；Windows 不能运行 k3s，请改用 SSH 或 kubeconfig';
  return '本地接入仅支持 Linux 控制端，请改用 SSH 或 kubeconfig';
}

function canDeployHost(host) {
  const transport = (host && host.transport) || 'ssh';
  if (transport === 'kubeconfig') return false;
  if (transport === 'local' && !isLinuxHost()) return false;
  return true;
}

function selectedClusterHosts() {
  return S.hosts.filter(clusterCapable);
}

function selectedHostList() {
  const ids = Array.isArray(S.selectedHostIds) ? S.selectedHostIds : [];
  const list = ids.map((id) => S.hosts.find((h) => h.id === id)).filter(Boolean);
  if (list.length) return list;
  const active = activeHost();
  return active ? [active] : [];
}

// 用节点名称 + InternalIP 作为集群指纹：同一集群的任意节点检测结果应完全一致。
// 没有节点列表时退化为 host:<id>，此时禁止多选，避免把不同集群误判成同一集群。
function detectedClusterKey(host) {
  const info = host && S.detected[host.id];
  const nodes = info && info.nodes;
  if (Array.isArray(nodes) && nodes.length) {
    return nodes.map((n) => `${n.name || ''}@${n.internalIP || ''}`).sort().join('|');
  }
  return '';
}

function sameCluster(a, b) {
  if (!a || !b || a.id === b.id) return false;
  const ka = detectedClusterKey(a);
  const kb = detectedClusterKey(b);
  return !!ka && ka === kb;
}

function hostGroupLabel(host) {
  const group = String((host && host.group) || '').trim();
  // 服务器一定挂在某个分组下；万一数据里 group 为空，也按默认分组展示，不再出现「未分组」
  return group || defaultGroupName();
}

// 分组列表始终来自后端（含内置的「默认分组」），保证不会出现组名凭空消失
function hostGroupNames() {
  const fromState = (Array.isArray(S.groups) ? S.groups : []).map((g) => String((g && g.name) || g || '').trim()).filter(Boolean);
  if (fromState.length) return fromState;
  const fallback = Array.from(new Set(S.hosts.map((h) => String(h.group || '').trim()).filter(Boolean)));
  return fallback.length ? fallback : ['默认分组'];
}

function hostGroupCount(name) {
  const key = String(name || '').trim();
  return S.hosts.filter((h) => String(h.group || '').trim() === key).length;
}

function defaultGroupName() {
  const names = hostGroupNames();
  return names.includes('默认分组') ? '默认分组' : names[0];
}

function hostClusterLabel(host) {
  if (!host) return '';
  return host.group ? hostGroupLabel(host) : (host.transport === 'kubeconfig' ? 'kubeconfig 集群' : '未分组');
}
function setHostSelection(ids) {
  const unique = [...new Set((ids || []).filter(Boolean))];
  const list = unique.map((id) => S.hosts.find((h) => h.id === id)).filter(Boolean);
  if (!list.length) return;
  setActiveHost(list[0].id);
  S.selectedHostIds = list.map((h) => h.id);
}

function hostSelectionLabel(hosts) {
  const list = hosts && hosts.length ? hosts : selectedHostList();
  if (!list.length) return '暂无服务器';
  if (list.length > 1) return `${list.length} 台 · ${hostClusterLabel(list[0])}`;
  return hostName(list[0]);
}

function hostSelectionBanner() {
  const list = selectedHostList();
  if (list.length < 2) return '';
  const active = activeHost() || list[0];
  return `<div class="alert info" style="margin-bottom:14px;align-items:center;flex-wrap:wrap">
    <div style="flex:1;min-width:220px">
      已选择 <b>${list.length}</b> 台同一集群服务器：${list.map((h) => `<span class="badge neutral" style="margin:2px">${esc(hostName(h))}</span>`).join('')}
      <div class="tiny dim" style="margin-top:5px">当前以 <b>${esc(hostName(active))}</b> 为入口展示该集群；多选服务器必须属于同一集群。</div>
    </div>
    <div class="row" style="gap:6px;flex:none">
      <button class="btn sm" data-action="host-picker-open">调整选择</button>
      <button class="btn sm ghost" data-action="host-picker-single">仅看当前</button>
    </div>
  </div>`;
}

function setActiveHost(id) {
  if (!id) return;
  S.activeHostId = id;
  S.selectedHostIds = [id];
  localStorage.setItem(ACTIVE_KEY, id);
  S.resources = {};
  S.namespaces = {};
  S.page.namespace = '';
  S.page.page = 1;
}

/* ============================================================
 * 模态框 / 抽屉 / 确认框
 * ============================================================ */
let modalEscHandler = null;
let activeModalOnClose = null;

function openModal({ title, body, foot = '', size = '', onMount = null, closable = true, onClose = null }) {
  closeModal(true);
  activeModalOnClose = typeof onClose === 'function' ? onClose : null;
  const root = $('#modalRoot');
  root.innerHTML = `
    <div class="modal ${size}" role="dialog" aria-modal="true">
      <div class="modal-head">
        <h3>${esc(title)}</h3>
        ${closable ? `<button class="icon-btn" data-close="1" title="关闭">${icon('x')}</button>` : ''}
      </div>
      <div class="modal-body">${body}</div>
      ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
    </div>`;
  const box = root.firstElementChild;
  root.dataset.closable = closable ? '1' : '0';
  document.body.classList.add('modal-open');
  $('#overlay').classList.add('show');
  requestAnimationFrame(() => box.classList.add('show'));

  // 用事件委托处理关闭按钮：部分弹窗会在 onMount 里替换 modal-foot，
  // 如果只在创建时逐个绑定，新插入的“关闭”按钮就会失效。
  root.onclick = (e) => {
    const target = e.target && e.target.closest ? e.target.closest('[data-close]') : null;
    if (target && root.contains(target)) closeModal();
  };
  modalEscHandler = (e) => {
    if (e.key === 'Escape' && closable) closeModal();
  };
  document.addEventListener('keydown', modalEscHandler);

  const apiObj = {
    el: box,
    close: () => closeModal(),
    setBody: (html) => { $('.modal-body', box).innerHTML = html; },
    onClose
  };
  if (onMount) onMount(apiObj);
  return apiObj;
}

function closeModal(immediate = false) {
  closeCselect();
  const root = $('#modalRoot');
  const box = root.querySelector('.modal');
  const cb = activeModalOnClose;
  activeModalOnClose = null;
  if (modalEscHandler) { document.removeEventListener('keydown', modalEscHandler); modalEscHandler = null; }
  if (cb) { try { cb(); } catch (_) { /* ignore */ } }
  if (!box) { document.body.classList.remove('modal-open'); $('#overlay').classList.remove('show'); return; }
  const finish = () => {
    if (root.contains(box)) root.innerHTML = '';
    if (!root.querySelector('.modal')) document.body.classList.remove('modal-open');
    if (!root.querySelector('.modal') && !$('#resourceDrawer')) $('#overlay').classList.remove('show');
  };
  if (immediate) return finish();
  box.classList.remove('show');
  setTimeout(finish, 150);
}

function confirmDialog({ title, message, confirmText = '确认', cancelText = '取消', danger = true, requireText = '' }) {  return new Promise((resolve) => {
    const inputId = 'confirm-input-' + Date.now();
    openModal({
      title,
      size: 'narrow',
      body: `
        <div class="alert ${danger ? 'err' : 'info'}" style="margin-bottom:14px">${icon('alert')}<div>${message}</div></div>
        ${requireText ? `<label class="field">输入 <span class="code-inline">${esc(requireText)}</span> 以继续
          <input class="input" id="${inputId}" autocomplete="off" spellcheck="false" placeholder="${esc(requireText)}" />
        </label>` : ''}`,
      foot: `<button class="btn ghost" data-close="1">${esc(cancelText)}</button>
             <button class="btn ${danger ? 'danger' : 'primary'}" id="confirm-btn" ${requireText ? 'disabled' : ''}>${esc(confirmText)}</button>`,
      onMount(modal) {
        const btn = $('#confirm-btn', modal.el);
        const input = requireText ? $('#' + inputId, modal.el) : null;
        if (input) {
          input.addEventListener('input', () => {
            btn.disabled = input.value.trim() !== requireText;
          });
          setTimeout(() => input.focus(), 50);
        } else {
          setTimeout(() => btn.focus(), 50);
        }
        btn.addEventListener('click', () => {
          if (btn.disabled) return;
          resolve(true);
          closeModal();
        });
        modal.el.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => { resolve(false); closeModal(); }));
      },
      onClose: () => resolve(false)
    });
  });
}

// 单输入框弹窗（新增 / 重命名分组等），返回去除首尾空白后的值，取消返回空串
function promptDialog({ title, label, value = '', placeholder = '', hint = '', maxlength = 0, confirmText = '确定', cancelText = '取消' }) {
  return new Promise((resolve) => {
    const inputId = 'prompt-input-' + Date.now();
    openModal({
      title,
      size: 'narrow',
      body: `
        <label class="field">${esc(label)}
          <input class="input" id="${inputId}" value="${esc(value)}" placeholder="${esc(placeholder)}" autocomplete="off" spellcheck="false"${maxlength ? ` maxlength="${maxlength}"` : ''} />
        </label>
        ${hint ? `<div class="help" style="margin-top:8px">${esc(hint)}</div>` : ''}`,
      foot: `<button class="btn ghost" data-close="1">${esc(cancelText)}</button>
             <button class="btn primary" id="prompt-ok">${esc(confirmText)}</button>`,
      onMount(modal) {
        const input = $('#' + inputId, modal.el);
        const ok = $('#prompt-ok', modal.el);
        const submit = () => {
          const text = input.value.trim();
          if (!text) { input.focus(); return; }
          resolve(text);
          closeModal();
        };
        ok.addEventListener('click', submit);
        input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
        modal.el.querySelectorAll('[data-close]').forEach((el) => el.addEventListener('click', () => { resolve(''); closeModal(); }));
        setTimeout(() => { input.focus(); input.select(); }, 60);
      },
      onClose: () => resolve('')
    });
  });
}

function showTokenModal() {
  if ($('#token-modal')) return;
  openModal({
    title: '需要访问令牌',
    size: 'narrow',
    body: `
      <p class="muted" style="margin-top:0;font-size:12px;line-height:1.7">config.json 中配置了 <span class="code-inline">app.accessToken</span>，请输入访问令牌后继续。</p>
      <label class="field">访问令牌
        <input class="input" id="token-input" type="password" autocomplete="off" placeholder="app.accessToken" />
      </label>
      <div class="auth-token-hint">令牌只保存在本次浏览器会话中。</div>`,
    foot: `<button class="btn primary" id="token-save">保存并继续</button>`,
    onMount(modal) {
      modal.el.id = 'token-modal';
      const input = $('#token-input', modal.el);
      setTimeout(() => input.focus(), 60);
      const save = () => {
        const value = input.value.trim();
        if (!value) { input.focus(); return; }
        sessionStorage.setItem(TOKEN_KEY, value);
        closeModal();
        location.reload();
      };
      $('#token-save', modal.el).addEventListener('click', save);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') save(); });
    }
  });
}

/* ============================================================
 * 页面外壳
 * ============================================================ */
function setHeader(view) {
  const meta = VIEW_META[view] || VIEW_META.dashboard;
  $('#pageKicker').textContent = meta.kicker;
  $('#pageTitle').textContent = meta.title;
  $('#pageSub').textContent = meta.sub;
  $$('#mainNav .nav-item').forEach((el) => el.classList.toggle('active', el.dataset.view === view));
  $$('#mainNav [data-deploy-tab]').forEach((el) => {
    el.classList.toggle('active', view === 'deploy' && el.dataset.deployTab === S.deployTab);
  });
  syncDeployNav();
  document.title = `${meta.title} · ${S.health ? S.health.name : 'k3s 集群管家'}`;
  // 服务器选择器只在工作负载页用；页面上默认隐藏，避免加载期间在别的页面闪出来
  const picker = $('#hostPicker');
  if (picker) picker.classList.toggle('hidden', view !== 'workloads');
}

function syncDeployNav() {
  const group = $('#deployNavGroup');
  if (!group) return;
  group.classList.toggle('open', !!S.navDeployOpen);
  const button = group.querySelector('.nav-parent');
  if (button) button.setAttribute('aria-expanded', S.navDeployOpen ? 'true' : 'false');
}

function updateHostPicker() {
  const btn = $('#hostPickerBtn');
  if (!btn) return;
  if (!S.hosts.length) {
    btn.disabled = true;
    btn.innerHTML = `<span class="hpb-name">暂无服务器</span>${icon('chevron-down')}`;
    return;
  }
  const known = new Set(S.hosts.map((h) => h.id));
  if (S.activeHostId && !known.has(S.activeHostId)) {
    S.activeHostId = '';
    S.selectedHostIds = [];
    localStorage.removeItem(ACTIVE_KEY);
  }
  const active = activeHost();
  if (!active) {
    S.selectedHostIds = [];
    btn.disabled = false;
    btn.innerHTML = `<span class="hpb-name">选择服务器</span><span class="hpb-meta">未选择</span>${icon('chevron-down')}`;
    btn.title = '选择服务器';
    return;
  }
  const valid = (Array.isArray(S.selectedHostIds) ? S.selectedHostIds : []).filter((id) => known.has(id));
  S.selectedHostIds = valid.includes(active.id) ? valid : [active.id];
  const selected = selectedHostList();
  const state = hostState(active);
  const multiple = selected.length > 1;
  const label = multiple ? `${selected.length} 台服务器` : hostName(active);
  const meta = multiple ? `${hostClusterLabel(active)} · 同集群` : hostClusterLabel(active);
  btn.disabled = false;
  btn.innerHTML = `<i class="dot ${state.dot}"></i><span class="hpb-name">${esc(label)}</span><span class="hpb-meta">${esc(meta)}</span>${icon('chevron-down')}`;
  btn.title = `选择服务器（当前：${selected.map(hostName).join('、')}）`;
}

function hostPickerCardHTML(host, state) {
  const info = S.detected[host.id] || {};
  const k8s = info.k8s || {};
  const cluster = info.cluster || {};
  const nodes = Array.isArray(info.nodes) ? info.nodes : [];
  const selected = state.selected.has(host.id);
  const firstId = state.selected.size ? [...state.selected][0] : null;
  const first = firstId ? state.hosts.find((h) => h.id === firstId) : null;
  // 默认是「选中 2 台以上才限制同集群」；strictCluster 表示选中 1 台后就锁定集群
  const conflictFrom = state.strictCluster ? 1 : 2;
  const clusterConflict = !state.allowMixed && state.selected.size >= conflictFrom && first && first.id !== host.id && !sameCluster(first, host);
  const disabled = clusterConflict;
  const roleText = hostRoleLabel(host);
  const transport = hostTransportLabel(host);
  const address = hostAddress(host);
  const osName = info.os && typeof info.os === 'object' ? (info.os.pretty || info.os.name || '') : String(info.os || '');
  const osArch = info.os && typeof info.os === 'object' ? (info.os.arch || info.arch || '') : (info.arch || '');
  const os = osName ? `${osName} ${osArch}`.trim() : '未读取';
  const k8sVersion = String(k8s.version || '').replace(/^k3s version\s*/i, '').replace(/\s*\(.*\)$/, '');
  const k8sText = k8s.installed ? `${k8sFlavorLabel(k8s)} ${k8sVersion}`.trim() : '未安装';
  const nodeText = nodes.length ? `${cluster.readyNodes || 0}/${nodes.length} 节点 Ready` : (cluster.reachable ? `${cluster.nodeCount || 0} 节点` : '未检测到集群');
  const res = info.resources || {};
  const cpuText = res.cpu ? `${res.cpu} 核` : '-';
  const memText = res.memMB ? fmtBytes(res.memMB) : '-';
  const search = [hostName(host), host.host, host.group, host.role, osName, k8s.version, ...nodes.map((n) => n.name)].filter(Boolean).join(' ').toLowerCase();
  return `<div class="picker-card ${selected ? 'selected' : ''} ${disabled ? 'disabled' : ''}" data-picker-host="${esc(host.id)}" data-search="${esc(search)}" role="button" tabindex="${disabled ? '-1' : '0'}" title="${disabled ? '只能选择同一集群的服务器' : '选择 ' + esc(hostName(host))}">
    <span class="picker-check ${state.selected.size > 1 ? 'multi' : ''}">${selected ? '✓' : ''}</span>
    <div class="picker-card-main">
      <div class="picker-card-title">
        <span>${esc(hostName(host))}</span>
        ${hostStatusBadge(host)}
        ${roleText ? badge(roleText, hostEffectiveRole(host) === 'agent' ? 'cyan' : 'neutral') : ''}
      </div>
      <div class="picker-card-host">${esc(transport)} · ${esc(address)}</div>
      <div class="picker-card-grid">
        <div><span class="k">分组：</span><span class="v">${esc(hostGroupLabel(host))}</span></div>
        <div><span class="k">操作系统：</span><span class="v">${esc(os)}</span></div>
        <div><span class="k">Kubernetes：</span><span class="v">${esc(k8sText)}</span></div>
        <div><span class="k">集群：</span><span class="v">${esc(nodeText)}</span></div>
        <div><span class="k">CPU / 内存：</span><span class="v">${esc(cpuText)} / ${esc(memText)}</span></div>
      </div>
      <div class="picker-card-tags">
        ${clusterConflict ? '<span class="badge warn">与其他所选服务器不是同一集群</span>' : ''}
        ${nodes.length ? `<span class="badge neutral">${esc(nodes.slice(0, 3).map((n) => n.name).join(', '))}${nodes.length > 3 ? '…' : ''}</span>` : ''}
      </div>
    </div>
  </div>`;
}

function hostPickerBodyHTML(state) {
  const firstId = state.selected.size ? [...state.selected][0] : null;
  const first = firstId ? state.hosts.find((h) => h.id === firstId) : null;
  const selectedCount = state.selected.size;
  const hint = state.hint || (state.allowMixed
    ? '部署模式：可选择任意多台服务器，不受“同一集群”限制；控制平面可选 1 台单机，或 3 / 5 台高可用。'
    : selectedCount > 1
      ? (first && !detectedClusterKey(first)
        ? '当前第一台服务器尚未读取到节点列表，无法判断是否属于同一集群；请先重新读取服务器信息后再选多台。'
        : '已选择多台服务器，继续添加时只能选择同一集群；点击已选卡片可取消。')
      : '点击服务器卡片选择：选一台就是单选，继续选同一集群的其他服务器会自动变成多选。');
  const hosts = state.hosts.slice().sort((a, b) => String(a.group || '').localeCompare(String(b.group || ''), 'zh-CN') || hostName(a).localeCompare(hostName(b), 'zh-CN'));
  return `<div class="picker-toolbar">
    <input class="input" id="pickerSearch" style="flex:1;min-width:160px" placeholder="搜索名称 / 地址 / 分组 / 节点" value="${esc(state.search)}" autocomplete="off" />
    <span class="tiny dim" id="pickerCount">${selectedCount} 台已选</span>
  </div>
  <div class="picker-hint">${esc(hint)}</div>
  <div class="picker-list" id="pickerList">
    ${hosts.length ? hosts.map((h) => hostPickerCardHTML(h, state)).join('') : '<div class="picker-empty">没有服务器</div>'}
    <div class="picker-empty" id="pickerEmpty" style="display:none">没有匹配的服务器</div>
  </div>`;
}

// 通用服务器选择器。默认按“同一集群”限制多选；
// allowMixed + onConfirm 供「新建集群」部署页做跨集群批量选择。
function openHostPicker(options = {}) {
  const pool = (Array.isArray(options.hosts) ? options.hosts : S.hosts)
    .filter((h) => !options.filter || options.filter(h));
  const allowMixed = !!options.allowMixed;
  const confirmText = options.confirmText || '应用选择';
  const rawInitial = options.initial || (Array.isArray(S.selectedHostIds) && S.selectedHostIds.length ? S.selectedHostIds : [S.activeHostId]);
  const initial = (Array.isArray(rawInitial) ? rawInitial : [rawInitial]).filter(Boolean);
  const validInitial = initial.filter((id) => pool.some((h) => h.id === id));
  const state = {
    hosts: pool,
    allowMixed,
    hint: typeof options.hint === 'string' ? options.hint : '',
    selected: new Set(validInitial.length ? validInitial : (!allowMixed && S.activeHostId && pool.some((h) => h.id === S.activeHostId) ? [S.activeHostId] : [])),
    search: '',
    onConfirm: typeof options.onConfirm === 'function' ? options.onConfirm : null
  };
  if (!state.allowMixed && state.selected.size > 1) {
    const first = state.hosts.find((h) => h.id === [...state.selected][0]);
    for (const id of [...state.selected]) {
      if (!first || id === first.id) continue;
      const host = state.hosts.find((h) => h.id === id);
      if (!host || !sameCluster(first, host)) state.selected.delete(id);
    }
  }

  const footHTML = `<button class="btn ghost" data-picker-cancel="1">取消</button>
    <button class="btn primary" id="pickerConfirm" data-picker-confirm="1">${esc(confirmText)}</button>`;
  // 只结束一次：确认走 onConfirm，取消或直接关窗走 onCancel
  let settled = false;
  const finish = (callback, value) => {
    if (settled) return;
    settled = true;
    closeModal();
    if (typeof callback === 'function') callback(value);
  };
  const modal = openModal({
    title: options.title || (allowMixed ? '选择部署服务器' : '选择服务器'),
    size: 'wide',
    body: hostPickerBodyHTML(state),
    foot: footHTML,
    onClose: () => finish(options.onCancel, []),
    onMount(box) {
      const refresh = () => {
        box.setBody(hostPickerBodyHTML(state));
        const foot = $('.modal-foot', box.el);
        if (foot) foot.innerHTML = footHTML;
        const count = $('#pickerCount', box.el);
        if (count) count.textContent = `${state.selected.size} 台已选`;
        filterPicker();
      };
      const filterPicker = () => {
        const q = state.search.trim().toLowerCase();
        let visible = 0;
        $$('[data-picker-host]', box.el).forEach((card) => {
          const show = !q || String(card.dataset.search || '').includes(q);
          card.style.display = show ? '' : 'none';
          if (show) visible++;
        });
        const empty = $('#pickerEmpty', box.el);
        if (empty) empty.style.display = visible ? 'none' : '';
      };
      box.el.addEventListener('click', (event) => {
        if (event.target.closest('[data-picker-cancel]')) { finish(options.onCancel, []); return; }
        if (event.target.closest('[data-picker-confirm]')) {
          const hosts = [...state.selected].map((id) => state.hosts.find((h) => h.id === id)).filter(Boolean);
          if (!hosts.length) { toast('请至少选择一台服务器', 'error'); return; }
          if (!state.allowMixed && hosts.length > 1) {
            const first = hosts[0];
            if (!hosts.every((h) => h.id === first.id || sameCluster(first, h))) {
              toast('多选只能选择同一集群的服务器', 'error');
              return;
            }
          }
          if (state.onConfirm) {
            finish(state.onConfirm, hosts);
            return;
          }
          finish(null, null);
          setHostSelection(hosts.map((h) => h.id));
          S.cluster = null;
          S.workloadData = null;
          renderView();
          return;
        }
        const card = event.target.closest('[data-picker-host]');
        if (!card || card.classList.contains('disabled')) return;
        const host = state.hosts.find((h) => h.id === card.dataset.pickerHost);
        if (!host) return;
        if (state.selected.has(host.id)) {
          if (state.selected.size > 1) {
            state.selected.delete(host.id);
            refresh();
          }
          return;
        }
        const firstId = state.selected.size ? [...state.selected][0] : null;
        const first = firstId ? state.hosts.find((h) => h.id === firstId) : null;
        if (!state.allowMixed && first && !sameCluster(first, host)) {
          if (state.selected.size === 1) {
            state.selected = new Set([host.id]);
            refresh();
            return;
          }
          toast(first && !detectedClusterKey(first) ? '第一台服务器未读取到集群节点，无法判断是否为同一集群' : '多选只能选择同一集群的服务器', 'error');
          return;
        }
        state.selected.add(host.id);
        refresh();
      });
      box.el.addEventListener('input', (event) => {
        if (event.target.id !== 'pickerSearch') return;
        state.search = event.target.value;
        filterPicker();
      });
      box.el.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        const card = event.target.closest('[data-picker-host]');
        if (!card) return;
        event.preventDefault();
        card.click();
      });
      if (!state.selected.size && !state.allowMixed) {
        const first = state.hosts[0];
        if (first) state.selected.add(first.id);
      }
      refresh();
      const input = $('#pickerSearch', box.el);
      if (input) setTimeout(() => input.focus(), 60);
    }
  });
  return modal;
}

// 以 Promise 形式使用服务器选择器：确认返回选中的 host 数组，取消/关窗返回空数组
function pickHosts(options = {}) {
  return new Promise((resolve) => {
    openHostPicker({
      ...options,
      onConfirm: (hosts) => resolve(hosts || []),
      onCancel: () => resolve([])
    });
  });
}

function deployTabOf(value) {
  return DEPLOY_TABS.includes(value) ? value : '';
}

function parseRoute(raw) {
  const path = String(raw || '').replace(/^#\/?/, '').split('?')[0];
  const parts = path.split('/').filter(Boolean);
  let view = parts[0] || 'dashboard';
  let tab = '';
  if (view === 'install') {
    view = 'deploy';
    tab = 'install';
  } else if (view === 'cluster') {
    view = 'hosts';
  }
  if (view === 'deploy') {
    tab = tab || deployTabOf(parts[1]) || deployTabOf(S.deployTab) || 'install';
  }
  return { view, tab };
}

function normalizeView(view) {
  if (view === 'cluster') return 'hosts';
  if (view === 'install') {
    S.deployTab = 'install';
    return 'deploy';
  }
  if (String(view).startsWith('deploy/')) {
    const tab = deployTabOf(String(view).slice('deploy/'.length).split('/')[0]);
    if (tab) S.deployTab = tab;
    return 'deploy';
  }
  return view;
}

function routeHash(view, tab) {
  if (view === 'deploy') return '#/deploy/' + (deployTabOf(tab) || 'install');
  return '#/' + view;
}

function navigate(view, { replace = false, tab = null, k3sPage = '' } = {}) {
  view = normalizeView(view);
  if (!VIEW_META[view]) view = 'dashboard';
  S.view = view;
  S.page.page = 1;
  if (view !== 'workloads') S.detail = null;
  if (view !== 'deploy') S.navDeployOpen = false;
  if (view === 'deploy') {
    S.deployTab = deployTabOf(tab) || deployTabOf(S.deployTab) || 'install';
    // 从菜单/地址进入安装页时默认展示安装；卸载页只在页面内切换时保留，
    // 但外部入口（服务器页快捷卸载）可以显式指定落在卸载页。
    if (S.deployTab === 'install') S.k3sPage = k3sPage === 'uninstall' ? 'uninstall' : 'install';
  }
  const hash = routeHash(view, S.deployTab);
  if (location.hash !== hash) {
    if (replace) history.replaceState(null, '', hash);
    else history.pushState(null, '', hash);
  }
  renderView();
}

function goDeployTab(tab, options = {}) {
  const next = deployTabOf(tab) || 'install';
  S.deployTab = next;
  S.navDeployOpen = true;
  syncDeployNav();
  navigate('deploy', { ...options, tab: next });
}

function renderView() {
  closeCselect();
  // 卡片重绘后原来的锚点就没了，浮动菜单要一起收掉
  if (typeof closeHostActionMenu === 'function') closeHostActionMenu();
  if (typeof closeImageActionMenu === 'function') closeImageActionMenu();
  setHeader(S.view);
  updateHostPicker();
  const view = $('#view');
  view.innerHTML = '<div class="empty"><span class="spinner"></span><p style="margin-top:12px">加载中…</p></div>';
  const renderer = RENDERERS[S.view];
  if (!renderer) return;
  try {
    renderer();
  } catch (err) {
    console.error(err);
    view.innerHTML = `<div class="alert err">${icon('alert')}<div>页面渲染失败：${esc(errorText(err))}</div></div>`;
  }
  // 重绘后把还没保存的就地输入（比如新增分类的草稿）接着显示
  if (typeof restoreImageCategoryDraft === 'function') {
    try {
      restoreImageCategoryDraft();
    } catch (err) {
      console.error(err);
    }
  }
}

function emptyHTML(iconName, title, desc, action = '') {
  return `<div class="empty">
    <div class="eico">${icon(iconName)}</div>
    <h4>${esc(title)}</h4>
    <p>${desc}</p>
    ${action ? `<div style="margin-top:14px">${action}</div>` : ''}
  </div>`;
}

function loginBanner() {
  return `<div class="alert warn" style="margin-bottom:16px">${icon('lock')}<div>
    当前控制台启用了访问令牌。请点击右上角状态区域或刷新页面输入令牌。
  </div></div>`;
}

/* ============================================================
 * 操作状态
 * ============================================================ */
function jobTone(status) {
  if (status === 'success') return 'ok';
  if (status === 'failed') return 'err';
  if (status === 'cancelled') return 'neutral';
  if (status === 'running' || status === 'cancelling') return 'info';
  return 'neutral';
}

function jobStatusText(status) {
  return ({ running: '执行中', success: '成功', failed: '失败', cancelled: '已取消', cancelling: '取消中' })[status] || status || '-';
}

function updateJobBadge() {
  const running = S.jobs.filter((j) => j.status === 'running' || j.status === 'cancelling').length;
  const el = $('#jobBadge');
  if (!el) return;
  el.textContent = running;
  el.classList.toggle('hidden', running === 0);
}

async function refreshJobs(silent = true) {
  try {
    const data = await api('/jobs');
    S.jobs = data.jobs || [];
    updateJobBadge();
    if (S.view === 'jobs') renderJobsList();
    if (S.view === 'dashboard') renderRecentJobs();
  } catch (err) {
    if (!silent) toast(errorText(err), 'error');
  }
}

/* ============================================================
 * 下拉框：保留原生 select 的值与事件，只替换展开后的视觉层
 * ============================================================ */
let cselectMenu = null;
let cselectSelect = null;
let cselectBound = false;

function ensureCselectMenu() {
  if (cselectMenu && cselectMenu.isConnected) return cselectMenu;
  cselectMenu = document.createElement('div');
  cselectMenu.id = 'cselectMenu';
  cselectMenu.className = 'cselect-menu';
  cselectMenu.setAttribute('role', 'listbox');
  cselectMenu.hidden = true;
  cselectMenu.addEventListener('click', (event) => {
    const item = event.target && event.target.closest ? event.target.closest('.cselect-item') : null;
    if (!item || item.disabled) return;
    const select = cselectSelect;
    const index = Number(item.dataset.cselectIndex);
    if (!select || select.disabled || !Number.isInteger(index)) return;
    closeCselect();
    if (index !== select.selectedIndex) {
      select.selectedIndex = index;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (select.isConnected) select.focus({ preventScroll: true });
  });
  document.body.appendChild(cselectMenu);
  return cselectMenu;
}

function cselectOptionsHTML(select) {
  const selectedIndex = select.selectedIndex;
  let lastGroup = '';
  const html = [];
  for (let index = 0; index < select.options.length; index++) {
    const option = select.options[index];
    const group = option.parentElement && option.parentElement.tagName === 'OPTGROUP'
      ? option.parentElement.label
      : '';
    if (group && group !== lastGroup) html.push(`<div class="cselect-group">${esc(group)}</div>`);
    lastGroup = group;
    const selected = index === selectedIndex;
    const label = option.label || option.textContent || '';
    html.push(`<button type="button" class="cselect-item${selected ? ' selected' : ''}" role="option" aria-selected="${selected ? 'true' : 'false'}" data-cselect-index="${index}" ${option.disabled ? 'disabled' : ''} title="${esc(label)}"><span class="cselect-label">${esc(label)}</span><span class="cselect-check">${selected ? icon('check') : ''}</span></button>`);
  }
  return html.length ? html.join('') : '<div class="cselect-empty">暂无选项</div>';
}

function positionCselect() {
  if (!cselectSelect || !cselectMenu || cselectMenu.hidden) return;
  const rect = cselectSelect.getBoundingClientRect();
  cselectMenu.style.left = '0px';
  cselectMenu.style.top = '0px';
  cselectMenu.style.minWidth = `${Math.max(160, Math.ceil(rect.width))}px`;
  const menuRect = cselectMenu.getBoundingClientRect();
  let left = rect.left;
  if (left + menuRect.width > window.innerWidth - 10) {
    left = Math.max(10, window.innerWidth - menuRect.width - 10);
  }
  let top = rect.bottom + 7;
  if (top + menuRect.height > window.innerHeight - 10 && rect.top > menuRect.height + 14) {
    top = rect.top - menuRect.height - 7;
  }
  top = Math.max(8, Math.min(top, window.innerHeight - menuRect.height - 8));
  cselectMenu.style.left = `${Math.round(left)}px`;
  cselectMenu.style.top = `${Math.round(top)}px`;
}

function openCselect(select) {
  if (!select || select.disabled || select.multiple) return;
  const menu = ensureCselectMenu();
  if (cselectSelect === select && !menu.hidden) return;
  closeCselect();
  cselectSelect = select;
  select.classList.add('cselect-open');
  select.setAttribute('aria-expanded', 'true');
  menu.innerHTML = cselectOptionsHTML(select);
  menu.hidden = false;
  menu.classList.remove('show');
  positionCselect();
  requestAnimationFrame(() => {
    if (cselectMenu && cselectMenu === menu && !menu.hidden) menu.classList.add('show');
  });
  const selected = menu.querySelector('.cselect-item.selected');
  if (selected) selected.scrollIntoView({ block: 'nearest' });
}

function closeCselect() {
  if (cselectSelect) {
    cselectSelect.classList.remove('cselect-open');
    cselectSelect.setAttribute('aria-expanded', 'false');
    cselectSelect = null;
  }
  if (!cselectMenu) return;
  cselectMenu.classList.remove('show');
  cselectMenu.hidden = true;
  cselectMenu.innerHTML = '';
}

function bindCselect() {
  if (cselectBound) return;
  cselectBound = true;
  document.addEventListener('mousedown', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    if (cselectMenu && cselectMenu.contains(target)) return;
    const select = target.closest('select.select');
    if (select && !select.disabled && !select.multiple) {
      event.preventDefault();
      if (cselectSelect === select && cselectMenu && !cselectMenu.hidden) closeCselect();
      else openCselect(select);
      select.focus({ preventScroll: true });
      return;
    }
    if (cselectMenu && !cselectMenu.hidden) closeCselect();
  }, true);
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target && target.closest && target.closest('select.select')) event.preventDefault();
  }, true);
  window.addEventListener('resize', closeCselect);
  window.addEventListener('scroll', (event) => {
    const target = event.target;
    if (cselectMenu && !cselectMenu.hidden && !(target && cselectMenu.contains(target))) closeCselect();
  }, true);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && cselectMenu && !cselectMenu.hidden) closeCselect();
  });
}

