'use strict';

/* ============================================================
 * 数据加载
 * ============================================================ */
async function loadBootstrap() {
  const [health, meta] = await Promise.all([api('/health'), api('/meta')]);
  S.health = health;
  S.meta = meta;
  $('#connVersion').textContent = 'v' + health.version;
  $('#connSsh').outerHTML = health.hasSsh2
    ? '<span id="connSsh" class="badge ok">可用</span>'
    : '<span id="connSsh" class="badge warn">未安装 ssh2</span>';
  $('#brandName').textContent = health.name || 'k3s 集群管家';
  $('#apiStatus').innerHTML = '<i class="dot ok"></i><span>控制台在线</span>';
  updateBrandTitle();
}

function updateBrandTitle() {
  if (!S.health) return;
  document.title = `${VIEW_META[S.view] ? VIEW_META[S.view].title : '概览'} · ${S.health.name}`;
}

async function loadHosts() {
  const data = await api('/hosts');
  S.hosts = data.hosts || [];
  S.groups = Array.isArray(data.groups) ? data.groups : [];
  for (const host of S.hosts) {
    if (host.detected) S.detected[host.id] = host.detected;
  }
  $('#connHosts').textContent = S.hosts.length;
  if (!S.activeHostId || !S.hosts.some((h) => h.id === S.activeHostId)) {
    S.activeHostId = '';
    S.selectedHostIds = [];
    localStorage.removeItem(ACTIVE_KEY);
  }
  updateHostPicker();
}

async function detectAll(force = true, onlyIds = null) {
  // onlyIds 支持单个 id 或 id 数组：只让这些服务器进入「读取中」，其它保持原状态
  const idSet = onlyIds ? new Set(Array.isArray(onlyIds) ? onlyIds : [onlyIds]) : null;
  const targets = idSet ? S.hosts.filter((h) => idSet.has(h.id)) : S.hosts.slice();
  if (!targets.length) return;
  for (const host of targets) S.detected[host.id] = { loading: true };
  refreshHostVisuals();
  if (!idSet) {
    if (S.view === 'dashboard') renderView();
    else if (S.view === 'hosts') refreshHostsTable();
  }
  await mapLimit(targets, 4, async (host) => {
    try {
      const info = await api(`/hosts/${encodeURIComponent(host.id)}/detect`, { method: 'POST' });
      S.detected[host.id] = info;
    } catch (err) {
      S.detected[host.id] = { reachable: false, error: errorText(err) };
    }
    refreshHostVisuals(host.id);
  });
  if (S.view === 'hosts') refreshHostsTable();
  else if (S.view === 'dashboard' || S.view === 'workloads' || S.view === 'deploy') renderView();
}

function refreshHostVisuals() {
  updateHostPicker();
  $$('[data-host-visual]').forEach((el) => {
    const id = el.getAttribute('data-host-visual');
    const host = findHost(id);
    if (host) el.innerHTML = hostVisualHTML(host);
  });
}

function hostVisualHTML(host) {
  const state = hostState(host);
  const info = S.detected[host.id];
  const nodes = info && info.cluster && info.cluster.reachable ? `${info.cluster.readyNodes}/${info.cluster.nodeCount}` : '-';
  const reason = info && !info.loading && info.error ? ` title="${esc(info.error)}"` : '';
  return `<span class="badge ${state.tone}"${reason}><i class="dot ${state.dot}"></i>${esc(state.text)}</span>
    <span class="tiny dim mono">节点 ${esc(nodes)}</span>`;
}

async function loadOverview(hostId, force = false) {
  if (!force && S.overview[hostId]) return S.overview[hostId];
  if (S.overviewLoading[hostId]) return null;
  S.overviewLoading[hostId] = true;
  try {
    const data = await api(`/hosts/${encodeURIComponent(hostId)}/overview`);
    S.overview[hostId] = data;
    return data;
  } catch (err) {
    S.overview[hostId] = { error: errorText(err) };
    return S.overview[hostId];
  } finally {
    S.overviewLoading[hostId] = false;
  }
}

async function loadNamespaces(hostId, force = false) {
  if (!force && S.namespaces[hostId]) return S.namespaces[hostId];
  const data = await api(`/hosts/${encodeURIComponent(hostId)}/namespaces`);
  S.namespaces[hostId] = data.namespaces || [];
  return S.namespaces[hostId];
}

// 这台机器是怎么访问 Kubernetes 的：本机直连，还是 agent 节点借用控制节点
async function loadKubeAccess(hostId, force = false) {
  if (!force && S.kubeAccess[hostId]) return S.kubeAccess[hostId];
  try {
    const data = await api(`/hosts/${encodeURIComponent(hostId)}/kube-access`);
    S.kubeAccess[hostId] = data || {};
  } catch (err) {
    S.kubeAccess[hostId] = { error: errorText(err) };
  }
  return S.kubeAccess[hostId];
}

async function loadResources(kind, namespace, force = false) {
  const host = activeHost();
  if (!host) return null;
  const key = `${host.id}|${kind}|${namespace || ''}`;
  if (!force && S.resources[key]) return S.resources[key];
  S.resourceLoading[key] = true;
  try {
    const query = new URLSearchParams({ kind });
    if (namespace) query.set('namespace', namespace);
    const data = await api(`/hosts/${encodeURIComponent(host.id)}/resources?${query.toString()}`);
    S.resources[key] = data;
    return data;
  } finally {
    S.resourceLoading[key] = false;
  }
}

