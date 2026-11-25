'use strict';

/* ============================================================
 * 集群
 * ============================================================ */
async function loadClusterData(host, force = false) {
  if (!host) return;
  const current = S.cluster;
  if (!force && current && current.hostId === host.id && !current.loading) return;
  S.cluster = { hostId: host.id, loading: true, overview: current && current.hostId === host.id ? current.overview : null, nodes: [], namespaces: [], events: [], top: null, errors: {} };
  if (S.clusterModalHostId === host.id) renderClusterModal();
  const base = `/hosts/${encodeURIComponent(host.id)}`;
  const [ov, ns, top, ev] = await Promise.allSettled([
    api(base + '/overview'),
    api(base + '/namespaces'),
    api(base + '/top'),
    api(base + '/events')
  ]);
  const data = { hostId: host.id, loading: false, fetchedAt: new Date().toISOString(), errors: {} };
  if (ov.status === 'fulfilled') {
    data.overview = ov.value;
    data.nodes = ov.value.nodes || [];
  } else data.errors.overview = errorText(ov.reason);
  if (ns.status === 'fulfilled') data.namespaces = ns.value.namespaces || [];
  else data.errors.namespaces = errorText(ns.reason);
  if (top.status === 'fulfilled') data.top = top.value;
  else data.errors.top = errorText(top.reason);
  if (ev.status === 'fulfilled') data.events = ev.value.items || [];
  else data.errors.events = errorText(ev.reason);
  S.cluster = data;
  if (S.clusterModalHostId === host.id) renderClusterModal();
}

function clusterDetailHTML(host = activeHost()) {
  if (!host) {
    return `<div class="card" style="padding:10px">${emptyHTML('cluster', '未选择集群', '先在“服务器”页面添加一台服务器，读取成功后即可在此查看集群。', '<button class="btn primary" data-action="host-add">' + icon('plus') + ' 添加服务器</button>')}</div>`;
  }
  const detected = S.detected[host.id];
  if (!detected || !detected.k8s || !detected.k8s.installed) {
    return `<div class="card" style="padding:10px">${emptyHTML('cluster', `${hostName(host)} 尚未安装集群`, '可以一键部署 k3s 单机或集群，也可以纳管已有 Kubernetes 集群。', `
      <div class="row" style="justify-content:center">
        <button class="btn primary" data-action="host-install" data-host="${esc(host.id)}">${icon('rocket')} 安装 / 加入</button>
        <button class="btn" data-action="host-detect" data-host="${esc(host.id)}">${icon('refresh')} 重新读取服务器信息</button>
      </div>`)}</div>`;
  }
  if (!S.cluster || S.cluster.hostId !== host.id) {
    loadClusterData(host);
    return '<div class="empty"><span class="spinner"></span><p style="margin-top:12px">正在读取集群信息…</p></div>';
  }
  if (S.cluster.loading && !S.cluster.overview) {
    return '<div class="empty"><span class="spinner"></span><p style="margin-top:12px">正在读取集群信息…</p></div>';
  }
  const d = S.cluster;
  const ov = d.overview;
  if (!ov) {
    return `<div class="alert err">${icon('alert')}<div>无法读取集群信息：${esc(d.errors.overview || '未知错误')}</div></div>
      <div class="row" style="margin-top:12px"><button class="btn" data-action="cluster-refresh">${icon('refresh')} 重试</button>
      <button class="btn" data-action="host-detect" data-host="${esc(host.id)}">${icon('server')} 重新读取服务器信息</button></div>`;
  }
  const nodes = d.nodes || [];
  const ready = ov.nodeStats.ready;
  const total = ov.nodeStats.total;
  const warnings = (d.events || []).filter((e) => e.type === 'Warning').slice(0, 7);
  const topNodes = d.top && d.top.available ? d.top.nodes || [] : [];
  const pods = ov.podStats || {};

  return `
    ${DEMO ? demoBanner() : ''}
    <div class="view-head">
      <div>
        <h2>${esc(hostName(host))} <span class="badge info">${esc(ov.serverVersion)}</span></h2>
        <p>${esc(hostAddress(host))} · 该服务器上的完整集群 · 更新于 ${esc(shortTime(d.fetchedAt))}${d.errors.top ? ' · 指标不可用' : ''}</p>
      </div>
      <div class="toolbar">
        <button class="btn sm" data-action="cluster-refresh">${icon('refresh')} 刷新</button>
        <button class="btn sm" data-action="goto-yaml">${icon('terminal')} 应用 YAML</button>
      </div>
    </div>
    <div class="stats">
      ${statCard('cluster', '节点', `${ready}/${total}`, '', ready === total ? '全部就绪' : '存在未就绪节点', ready === total ? 'ok' : 'warn')}
      ${statCard('box', 'Pod', `${pods.running || 0}/${pods.total || 0}`, '', `${pods.unhealthy || 0} 个异常 · ${pods.restarts || 0} 次重启`, pods.unhealthy ? 'err' : 'ok')}
      ${statCard('layers', 'Deployment', `${ov.deploymentStats.ready}/${ov.deploymentStats.total}`, '', '已就绪 / 总数', ov.deploymentStats.ready === ov.deploymentStats.total ? 'ok' : 'warn')}
      ${statCard('link', 'Service', `${ov.serviceCount}`, '', `${ov.namespaceCount} 个命名空间`, '')}
    </div>
    <div class="cluster-layout">
      <div class="stack">
        <div class="card">
          <div class="card-head"><h3>节点</h3><span class="hint">${nodes.length} 个节点</span></div>
          <div class="table-wrap" style="border:none;border-radius:0 0 14px 14px">
            <table class="data" style="min-width:860px">
              <thead><tr>
                <th>节点</th><th>状态</th><th>角色</th><th>版本</th><th>IP</th><th>CPU / 内存</th><th class="right">操作</th>
              </tr></thead>
              <tbody>
                ${nodes.map((n) => `
                  <tr data-action="node-info" data-node="${esc(n.name)}">
                    <td class="primary">${esc(n.name)}<div class="tiny dim">${esc(n.os || '')}</div></td>
                    <td>${statusBadge(n.status)}${n.schedulable === false ? ' ' + badge('已隔离', 'warn') : ''}</td>
                    <td>${(n.roleList || []).map((r) => badge(r, r.includes('control') || r.includes('master') ? 'purple' : 'neutral')).join(' ') || '<span class="dim">worker</span>'}</td>
                    <td class="mono">${esc(n.version || '-')}</td>
                    <td class="mono">${esc(n.internalIP || '-')}</td>
                    <td class="mono">${esc(n.cpu || '-')} / ${esc(n.memory || '-')}</td>
                    <td>
                      <div class="row-actions">
                        ${n.schedulable === false
                          ? `<button class="btn sm" data-action="node-uncordon" data-node="${esc(n.name)}">${icon('play')} 恢复调度</button>`
                          : `<button class="btn sm" data-action="node-cordon" data-node="${esc(n.name)}">${icon('stop')} 隔离</button>`}
                        <button class="btn sm danger" data-action="node-drain" data-node="${esc(n.name)}">${icon('power')} 驱逐</button>
                      </div>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>节点资源使用</h3><span class="hint">kubectl top</span></div>
          <div class="card-body" style="padding-top:10px">
            ${!d.top ? '<div class="tiny dim">正在读取 metrics-server…</div>'
              : !d.top.available ? `<div class="alert warn">${icon('alert')}<div>metrics-server 不可用：${esc(truncate(d.top.error || '未安装', 200))}<br>安装 metrics-server 后可在此查看 CPU / 内存使用率。</div></div>`
                : `<div class="table-wrap" style="border:none">
                    <table class="data" style="min-width:0">
                      <thead><tr><th>节点</th><th class="right">CPU</th><th class="right">内存</th></tr></thead>
                      <tbody>${topNodes.map((t) => `<tr style="cursor:default"><td class="primary">${esc(t.name)}</td><td class="right mono">${esc(t.cpu)} ${t.cpuPercent ? `<span class="tiny dim">(${esc(t.cpuPercent)})</span>` : ''}</td><td class="right mono">${esc(t.memory)} ${t.memoryPercent ? `<span class="tiny dim">(${esc(t.memoryPercent)})</span>` : ''}</td></tr>`).join('') || '<tr><td colspan="3" class="dim center">暂无数据</td></tr>'}</tbody>
                    </table>
                  </div>`}
          </div>
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><h3>命名空间</h3><span class="hint">${d.namespaces.length} 个</span></div>
          <div class="card-body" style="display:flex;flex-wrap:wrap;gap:6px;padding-top:12px">
            ${d.namespaces.map((n) => `<button class="chip" style="height:26px;font-size:11px" data-action="open-namespace" data-ns="${esc(n.name)}">${esc(n.name)} <span class="count">${esc(n.status)}</span></button>`).join('') || '<span class="dim small">暂无命名空间</span>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>告警事件</h3><span class="badge ${warnings.length ? 'warn' : 'ok'}">${warnings.length}</span></div>
          <div class="card-body" style="padding-top:8px">
            ${warnings.length ? warnings.map((e) => `
              <div class="event-row" title="${esc(e.message)}">
                <span class="badge warn">${esc(e.reason)}</span>
                <div style="min-width:0;flex:1">
                  <div class="mono" style="font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.object || e.name)}</div>
                  <div class="tiny dim" style="margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.message)}</div>
                </div>
                <span class="tiny dim nowrap">${esc(age(e.lastSeen))}前</span>
              </div>`).join('')
              : '<div class="empty" style="padding:18px 6px"><span class="badge ok">没有告警事件</span></div>'}
            <button class="btn-link" style="margin-top:8px" data-action="open-events">查看全部事件 →</button>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><h3>集群信息</h3></div>
          <div class="card-body" style="padding-top:10px">
            <div class="kv"><span class="k">Server 版本</span><span class="v">${esc(ov.serverVersion)}</span></div>
            <div class="kv"><span class="k">客户端版本</span><span class="v">${esc(ov.clientVersion || '-')}</span></div>
            <div class="kv"><span class="k">控制平面节点</span><span class="v">${esc(ov.nodeStats.controlPlane)}</span></div>
            <div class="kv"><span class="k">Pod 总数</span><span class="v">${esc(pods.total)}</span></div>
            <div class="kv"><span class="k">容器重启</span><span class="v">${esc(pods.restarts)}</span></div>
            <div class="kv"><span class="k">调度状态</span><span class="v">${nodes.filter((n) => n.schedulable === false).length ? '存在隔离节点' : '正常'}</span></div>
          </div>
        </div>
      </div>
    </div>`;
}


function renderClusterModal() {
  if (!S.clusterModalHostId) return;
  const host = findHost(S.clusterModalHostId);
  const body = $('#modalRoot .modal-body');
  if (!host || !body) return;
  body.innerHTML = clusterDetailHTML(host);
}

function openClusterModal(host) {
  if (!host) return;
  setActiveHost(host.id);
  openModal({
    title: '集群详情 · ' + hostName(host),
    size: 'cluster-modal',
    body: '<div class="empty"><span class="spinner"></span><p style="margin-top:12px">正在读取集群信息…</p></div>',
    onClose: () => {
      if (S.clusterModalHostId === host.id) S.clusterModalHostId = null;
    }
  });
  S.clusterModalHostId = host.id;
  renderClusterModal();
}

async function doNodeAction(nodeName, action) {
  const host = activeHost();
  if (!host) return;
  if (action === 'drain') {
    const ok = await confirmDialog({
      title: '驱逐节点',
      message: `即将驱逐 <b>${esc(nodeName)}</b> 上的所有工作负载（忽略 DaemonSet 与 emptyDir 数据）。请确认节点可安全维护。`,
      confirmText: '执行驱逐',
      danger: true
    });
    if (!ok) return;
  }
  try {
    const data = await api(`/hosts/${encodeURIComponent(host.id)}/node-action`, { method: 'POST', body: { action, node: nodeName } });
    toast(truncate(data.output || '操作完成', 300), 'success');
    setTimeout(() => loadClusterData(host, true), 900);
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

function openNodeInfo(name) {
  const node = S.cluster && (S.cluster.nodes || []).find((n) => n.name === name);
  if (!node) return;
  openModal({
    title: '节点详情',
    size: 'narrow',
    body: `
      <div class="kv"><span class="k">名称</span><span class="v">${esc(node.name)}</span></div>
      <div class="kv"><span class="k">状态</span><span class="v">${esc(node.status)}${node.schedulable === false ? '（已隔离）' : ''}</span></div>
      <div class="kv"><span class="k">角色</span><span class="v">${esc((node.roleList || []).join(', ') || 'worker')}</span></div>
      <div class="kv"><span class="k">版本</span><span class="v">${esc(node.version || '-')}</span></div>
      <div class="kv"><span class="k">内部 IP</span><span class="v">${esc(node.internalIP || '-')}</span></div>
      <div class="kv"><span class="k">操作系统</span><span class="v">${esc(node.os || '-')}</span></div>
      <div class="kv"><span class="k">内核</span><span class="v">${esc(node.kernel || '-')}</span></div>
      <div class="kv"><span class="k">容器运行时</span><span class="v">${esc(node.runtime || '-')}</span></div>
      <div class="kv"><span class="k">CPU</span><span class="v">${esc(node.cpu || '-')}</span></div>
      <div class="kv"><span class="k">内存</span><span class="v">${esc(node.memory || '-')}</span></div>
      <div class="kv"><span class="k">最大 Pod</span><span class="v">${esc(node.pods || '-')}</span></div>`,
    foot: `<button class="btn ghost" data-close="1">关闭</button>`
  });
}

function openEventsModal() {
  const events = (S.cluster && S.cluster.events) || [];
  openModal({
    title: '集群事件',
    size: 'wide',
    body: events.length ? `<div class="table-wrap" style="border:none"><table class="data">
      <thead><tr><th>类型</th><th>原因</th><th>对象</th><th>消息</th><th class="right">次数</th><th>时间</th></tr></thead>
      <tbody>${events.slice(0, 120).map((e) => `<tr style="cursor:default">
        <td>${statusBadge(e.type)}</td>
        <td>${esc(e.reason)}</td>
        <td class="mono">${esc(e.object || e.name)}</td>
        <td style="max-width:340px"><div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.message)}">${esc(e.message)}</div></td>
        <td class="right mono">${esc(e.count)}</td>
        <td class="mono">${esc(age(e.lastSeen))}前</td>
      </tr>`).join('')}</tbody></table></div>` : '<div class="empty"><p>暂无事件</p></div>',
    foot: '<button class="btn ghost" data-close="1">关闭</button>'
  });
}
/* ============================================================
 * 工作负载
 * ============================================================ */
const KIND_GROUPS = [
  { label: '工作负载', kinds: ['pods', 'deployments', 'statefulsets', 'daemonsets', 'replicasets', 'jobs', 'cronjobs', 'horizontalpodautoscalers'] },
  { label: '网络', kinds: ['services', 'ingresses', 'networkpolicies', 'ingressclasses'] },
  { label: '配置', kinds: ['configmaps', 'secrets', 'serviceaccounts'] },
  { label: '存储', kinds: ['persistentvolumeclaims', 'persistentvolumes', 'storageclasses'] },
  { label: '集群', kinds: ['namespaces', 'nodes', 'events'] }
];

const KIND_ICONS = {
  pods: 'box', deployments: 'layers', statefulsets: 'layers', daemonsets: 'layers', replicasets: 'copy',
  jobs: 'play', cronjobs: 'clock', horizontalpodautoscalers: 'activity', services: 'link',
  ingresses: 'external', networkpolicies: 'shield', ingressclasses: 'filter', configmaps: 'settings', secrets: 'lock',
  serviceaccounts: 'shield', persistentvolumeclaims: 'download', persistentvolumes: 'download',
  storageclasses: 'download', namespaces: 'grid', nodes: 'server', events: 'zap'
};

function kindMeta(kind) {
  const fromMeta = S.meta && S.meta.resources && S.meta.resources[kind];
  return fromMeta || { label: kind, namespaced: !['nodes', 'namespaces', 'persistentvolumes', 'storageclasses', 'ingressclasses'].includes(kind), columns: [] };
}

// agent 节点没有控制面，数据是借用它连接的控制节点读的，这里说明来源。
// 已经把控制节点一起选中时不再提示：整组都在选中范围里，再让人“切换”只会把选择缩成单台。
function kubeSourceBanner(host) {
  const access = S.kubeAccess && S.kubeAccess[host.id];
  if (!access || !access.via) return '';
  const via = access.via;
  const selected = selectedHostList();
  const multi = selected.length > 1;
  if (multi && selected.some((item) => item.id === via.id)) return '';
  const label = via.host && via.host !== via.name ? `${via.name}（${via.host}）` : (via.name || via.host);
  if (multi) {
    return `<div class="alert info" style="margin-bottom:12px">${icon('server')}<div>
      已选择 ${selected.length} 台同一集群的服务器，集群数据通过控制节点 <b>${esc(label)}</b> 读取。
    </div></div>`;
  }
  return `<div class="alert info" style="margin-bottom:12px">${icon('server')}<div>
    本机是 k3s agent（控制面不在本机，没有 admin kubeconfig），以下数据通过控制节点 <b>${esc(label)}</b> 读取，与在该节点上看到的一致。
    <button class="btn-link" data-action="host-select" data-host="${esc(via.id)}">切换到该节点</button>
  </div></div>`;
}

function isNamespaced(kind) {
  return kindMeta(kind).namespaced;
}

let workloadReq = 0;

function renderWorkloads() {
  const view = $('#view');
  const host = activeHost();
  if (!host) {
    const hasHosts = S.hosts.length > 0;
    const action = hasHosts
      ? `<button class="btn primary" data-action="host-picker-open">${icon('server')} 选择服务器</button>`
      : `<button class="btn primary" data-action="host-add">${icon('plus')} 添加服务器</button>`;
    view.innerHTML = `<div class="card" style="padding:10px">${emptyHTML('server', '未选择服务器', hasHosts ? '请先选择一台已安装 Kubernetes 的服务器，再查看工作负载。' : '还没有服务器，请先添加一台并完成 Kubernetes 部署。', action)}</div>`;
    return;
  }
  if (!clusterCapable(host)) {
    view.innerHTML = `<div class="card" style="padding:10px">${emptyHTML('layers', `${hostName(host)} 尚未安装 Kubernetes`, '完成部署后即可在这里浏览与管理资源。', '<button class="btn primary" data-action="host-install" data-host="' + esc(host.id) + '">' + icon('rocket') + ' 安装 / 加入</button>')}</div>`;
    return;
  }
  const kind = S.page.kind || 'pods';
  const namespaced = isNamespaced(kind);
  if (namespaced && !S.namespaces[host.id]) {
    loadNamespaces(host.id).then(() => { if (S.view === 'workloads') renderView(); }).catch(() => {});
  }
  const data = S.workloadData;
  const desiredNs = namespaced ? (S.page.namespace || '') : '';
  const same = data && data.hostId === host.id && data.kind === kind && (data.namespace || '') === desiredNs;
  if (!same) {
    view.innerHTML = '<div class="empty"><span class="spinner"></span><p style="margin-top:12px">正在读取 ' + esc(kindMeta(kind).label) + ' 列表…</p></div>';
    loadWorkloads();
    return;
  }

  const nsList = S.namespaces[host.id] || [];
  const columns = (data.columns && data.columns.length ? data.columns : kindMeta(kind).columns) || [];
  const total = (data.items || []).length;
  // 多选同一集群时，标题里标一下共几台，避免看着像只读了入口这一台
  const selectedCount = selectedHostList().length;
  const clusterLabel = `${esc(hostName(host))}${selectedCount > 1 ? ` 等 ${selectedCount} 台` : ''}`;

  view.innerHTML = `
    ${DEMO ? demoBanner() : ''}
    <div class="view-head">
      <div><h2>${esc(kindMeta(kind).label)}</h2><p>集群 ${clusterLabel} · ${total} 个资源</p></div>
      <div class="toolbar">
        <div style="position:relative">
          <input class="input" id="wlSearch" style="width:200px;padding-left:30px" placeholder="按名称过滤" value="${esc(S.page.search)}" />
          <span style="position:absolute;left:10px;top:9px;color:var(--dim)">${icon('search')}</span>
        </div>
        <select class="select" id="wlNamespace" style="width:170px" ${namespaced ? '' : 'disabled'}>
          <option value="">全部命名空间</option>
          ${nsList.map((n) => `<option value="${esc(n.name)}" ${S.page.namespace === n.name ? 'selected' : ''}>${esc(n.name)}</option>`).join('')}
        </select>
        <button class="btn" data-action="wl-refresh" title="刷新">${icon('refresh')}</button>
        <button class="btn" data-action="wl-add" title="按当前选中的资源类型新增模板">${icon('plus')} 新增</button>
        <button class="btn primary" data-action="goto-yaml">${icon('terminal')} 应用 YAML</button>
      </div>
    </div>
    ${kubeSourceBanner(host)}
    <div class="workbench">
      <div class="kind-rail">
        ${KIND_GROUPS.map((group) => `
          <div class="kind-group">
            <div class="kg-title">${esc(group.label)}</div>
            ${group.kinds.map((k) => `<button class="kind-item ${k === kind ? 'active' : ''}" data-action="wl-kind" data-kind="${k}" title="${esc(kindMeta(k).label)}">
              ${icon(KIND_ICONS[k] || 'box')}<span>${esc(kindMeta(k).label)}</span>
            </button>`).join('')}
          </div>`).join('')}
      </div>
      <div class="card" style="min-width:0">
        <div id="workloadTableWrap">${workloadTableHTML()}</div>
      </div>
    </div>`;
}

async function loadWorkloads(force = false) {
  const host = activeHost();
  if (!host) return;
  const kind = S.page.kind || 'pods';
  const ns = isNamespaced(kind) ? S.page.namespace : '';
  const myReq = ++workloadReq;
  try {
    const tasks = [loadResources(kind, ns, force)];
    // 刷新时一并刷新命名空间，保证筛选下拉能拿到新建/删除后的最新列表
    if (isNamespaced(kind)) tasks.push(loadNamespaces(host.id, force).catch(() => []));
    tasks.push(loadKubeAccess(host.id, force));
    const [data] = await Promise.all(tasks);
    if (myReq !== workloadReq) return;
    S.workloadData = { hostId: host.id, kind, namespace: ns, data, items: data.items || [], columns: data.columns || [], fetchedAt: data.fetchedAt };
  } catch (err) {
    if (myReq !== workloadReq) return;
    S.workloadData = { hostId: host.id, kind, namespace: ns, error: errorText(err), items: [], columns: [] };
  }
  if (S.view === 'workloads') renderView();
}

function workloadItemsFiltered() {
  const data = S.workloadData;
  if (!data || !data.items) return [];
  const q = S.page.search.trim().toLowerCase();
  if (!q) return data.items;
  return data.items.filter((item) => [item.name, item.namespace, item.status, item.node, item.type, item.reason, item.message, item.object]
    .some((v) => String(v || '').toLowerCase().includes(q)));
}

function formatCell(item, col) {
  const value = item[col.key];
  if (col.type === 'status') return value ? statusBadge(value) : '<span class="dim">-</span>';
  if (col.type === 'age') return `<span class="mono">${value ? esc(age(value)) + '前' : '-'}</span>`;
  if (col.type === 'bool') return value ? badge('是', 'ok') : badge('否', 'neutral');
  if (col.key === 'message') return `<div style="max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(value)}">${esc(value || '-')}</div>`;
  if (Array.isArray(value)) return esc(value.join(', '));
  if (value === undefined || value === null || value === '') return '<span class="dim">-</span>';
  return esc(value);
}

function workloadTableHTML() {
  const data = S.workloadData;
  if (!data) return '<div class="empty"><span class="spinner"></span><p style="margin-top:10px">加载中…</p></div>';
  if (data.error) {
    return `<div style="padding:18px"><div class="alert err">${icon('alert')}<div>读取资源失败：${esc(data.error)}</div></div>
      <div class="row" style="margin-top:12px"><button class="btn" data-action="wl-refresh">${icon('refresh')} 重试</button>
      <button class="btn" data-action="host-detect" data-host="${esc(activeHost() ? activeHost().id : '')}">${icon('server')} 重新读取服务器信息</button></div></div>`;
  }
  const items = workloadItemsFiltered();
  const pageSize = 40;
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  if (S.page.page > pages) S.page.page = pages;
  const current = S.page.page || 1;
  const slice = items.slice((current - 1) * pageSize, current * pageSize);
  const kind = data.kind;
  const columns = data.columns || [];
  const namespaced = isNamespaced(kind);

  const head = columns.map((c) => `<th class="${c.align === 'right' ? 'right' : ''}">${esc(c.label)}</th>`).join('');

  const rows = slice.map((item) => {
    const cells = columns.map((col) => {
      if (col.primary) {
        return `<td class="primary"><div style="display:flex;align-items:center;gap:7px;min-width:0">
          <span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(item.name)}</span>
          ${namespaced && item.namespace ? `<span class="ns">${esc(item.namespace)}</span>` : ''}
          ${item.healthy === false ? '<span class="dot err"></span>' : ''}
        </div></td>`;
      }
      if (col.key === 'namespace') return `<td>${esc(item.namespace || '-')}</td>`;
      return `<td class="${col.align === 'right' ? 'right' : ''}">${formatCell(item, col)}</td>`;
    }).join('');
    return `<tr data-action="open-resource" data-kind="${esc(kind)}" data-ns="${esc(item.namespace || '')}" data-name="${esc(item.name)}">${cells}
      <td class="right" style="width:34px;color:var(--dim)">${icon('chevron-right')}</td></tr>`;
  }).join('');

  return `
    <div class="table-wrap" style="border:none;border-radius:14px 14px 0 0">
      <table class="data">
        <thead><tr>${head}<th></th></tr></thead>
        <tbody>${rows || `<tr><td colspan="${columns.length + 1}"><div class="empty">${icon('search', 'eico')}<h4>没有匹配的资源</h4><p>${S.page.search ? '尝试清空搜索条件。' : '该命名空间下暂无 ' + esc(kindMeta(kind).label) + '。'}</p></div></td></tr>`}</tbody>
      </table>
    </div>
    <div class="pager" style="padding:10px 14px">
      <span>共 ${items.length} 条${S.page.search ? '（已过滤）' : ''} · 第 ${current}/${pages} 页</span>
      <div class="row" style="gap:6px">
        <button class="btn sm" data-action="wl-prev" ${current <= 1 ? 'disabled' : ''}>上一页</button>
        <button class="btn sm" data-action="wl-next" ${current >= pages ? 'disabled' : ''}>下一页</button>
        <button class="btn sm" data-action="wl-refresh" title="刷新">${icon('refresh')}</button>
      </div>
    </div>`;
}

function refreshWorkloadTable() {
  const wrap = $('#workloadTableWrap');
  if (wrap) wrap.innerHTML = workloadTableHTML();
}

function changeKind(kind) {
  if (S.page.kind === kind) return;
  S.page.kind = kind;
  S.page.page = 1;
  S.page.search = '';
  if (!isNamespaced(kind)) S.page.namespace = '';
  S.workloadData = null;
  renderView();
}

