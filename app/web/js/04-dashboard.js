'use strict';

/* ============================================================
 * 概览
 * ============================================================ */
let autoDetectPromise = null;

function maybeAutoDetect() {
  if (!S.hosts.length) return;
  if (S.config && S.config.app && S.config.app.autoDetect === false) return;
  const pending = S.hosts.filter((h) => !S.detected[h.id]);
  if (!pending.length || autoDetectPromise) return;
  // 只读没有缓存的服务器，已有结果的不要重新进入「读取中」
  autoDetectPromise = detectAll(false, pending.map((h) => h.id)).finally(() => { autoDetectPromise = null; });
}

function ensureOverview(hostId) {
  if (!hostId) return;
  const host = findHost(hostId);
  if (!host || !clusterCapable(host)) return;
  if (S.overview[hostId] || S.overviewLoading[hostId]) return;
  loadOverview(hostId).then(() => {
    if (S.view === 'dashboard') renderView();
  });
}

function renderDashboard() {
  const view = $('#view');
  if (!S.hosts.length) {
    view.innerHTML = `
      ${DEMO ? demoBanner() : ''}
      <div class="card" style="padding:10px">
        ${emptyHTML('server', '还没有配置服务器', '在 data/server.json 中添加连接信息，或直接在界面中添加一台服务器。', '<button class="btn primary" data-action="host-add">' + icon('plus') + ' 添加服务器</button>')}
      </div>
      <div class="grid grid-3" style="margin-top:16px">
        ${featureCard('zap', '一键部署', '为裸机 / 单机服务器自动安装 k3s 集群，无需手工敲命令。')}
        ${featureCard('layers', '资源管理', '查看并修改 Pod、Deployment、Service、ConfigMap 等 20+ 类资源。')}
        ${featureCard('terminal', '操作日志', '安装、卸载、预检全过程实时日志，失败可追踪。')}
      </div>`;
    return;
  }

  maybeAutoDetect();
  const detected = S.hosts.map((h) => S.detected[h.id]).filter((d) => d && !d.loading);
  const online = detected.filter((d) => d.reachable).length;
  const k8sHosts = S.hosts.filter((h) => {
    const d = S.detected[h.id];
    return d && d.k8s && d.k8s.installed;
  });
  const nodes = collectOverviewNodes();
  const readyNodes = nodes.filter((n) => n.ready === true || n.status === 'Ready').length;
  const attention = attentionHosts().length;

  const stats = `
    <div class="stats">
      ${statCard('server', '在线服务器', `${online}`, `/ ${S.hosts.length}`, `${attention} 台需要关注 · 点击查看清单`, online === S.hosts.length ? 'ok' : online ? 'warn' : 'err', 'overview-detail', 'servers')}
      ${statCard('box', '集群服务器', `${k8sHosts.length}`, `/ ${S.hosts.length}`, '已安装 k3s 或 Kubernetes 的服务器 · 点击查看', k8sHosts.length ? 'ok' : 'warn', 'overview-detail', 'k8s')}
      ${statCard('cluster', '集群节点', `${readyNodes}`, `/ ${nodes.length}`, '按服务器读取并去重 · 点击查看节点', nodes.length && readyNodes === nodes.length ? 'ok' : nodes.length ? 'warn' : '', 'overview-detail', 'nodes')}
      ${statCard('alert', '需要关注', `${attention}`, '', attention ? '离线或读取失败 · 点击查看' : '当前没有异常服务器', attention ? 'err' : 'ok', 'overview-detail', 'attention')}
    </div>`;

  const left = `
    <div class="view-head" style="margin-bottom:0">
      <div><h2>运行概览</h2><p>服务器与集群的汇总；点击上方数字展开明细，不在概览里绑定某台机器</p></div>
      <div class="toolbar">
        <button class="btn sm" data-action="detect-all">${icon('refresh')} 刷新状态</button>
        <button class="btn sm primary" data-action="host-add">${icon('plus')} 添加服务器</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>最近操作</h3><button class="btn-link" data-action="goto-jobs">全部</button></div>
      <div class="card-body" id="recentJobs" style="padding-top:6px">${recentJobsHTML()}</div>
    </div>`;

  const right = `
    <div class="card">
      <div class="card-head"><h3>快捷操作</h3></div>
      <div class="card-body" style="display:flex;flex-direction:column;gap:8px">
        <button class="btn" data-action="host-add" style="justify-content:flex-start">${icon('plus')} 添加服务器连接</button>
        <button class="btn" data-action="goto-install" style="justify-content:flex-start">${icon('rocket')} 安装 k3s 集群</button>
        <button class="btn" data-action="goto-yaml" style="justify-content:flex-start">${icon('terminal')} 应用 YAML 清单</button>
        <button class="btn" data-action="detect-all" style="justify-content:flex-start">${icon('refresh')} 刷新全部状态</button>
      </div>
    </div>
    <div class="card">
      <div class="card-head"><h3>概览说明</h3></div>
      <div class="card-body small muted" style="line-height:1.9">
        这里是环境和资源的汇总，不默认展开某台机器。点击上方任意数字，可以查看服务器清单、集群服务器、去重后的节点或需要关注的异常。
      </div>
    </div>`;

  view.innerHTML = `${DEMO ? demoBanner() : ''}${stats}<div class="dash-layout"><div class="stack">${left}</div><div class="stack">${right}</div></div>`;
}

function collectOverviewNodes() {
  const map = new Map();
  for (const host of S.hosts) {
    const info = S.detected[host.id];
    if (!info || !Array.isArray(info.nodes)) continue;
    for (const node of info.nodes) {
      const key = `${node.name || ''}|${node.internalIP || ''}`;
      let item = map.get(key);
      if (!item) {
        item = { ...node, sources: [] };
        map.set(key, item);
      }
      const source = hostName(host);
      if (!item.sources.includes(source)) item.sources.push(source);
    }
  }
  return Array.from(map.values()).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
}

function attentionHosts() {
  return S.hosts.filter((host) => {
    const d = S.detected[host.id];
    return d && !d.loading && (!d.reachable || d.error || d.authFailed);
  });
}

function overviewServerRow(host) {
  const d = S.detected[host.id] || {};
  const k8s = d.k8s || {};
  const cluster = d.cluster || {};
  const version = (k8s.version || '').replace('k3s version ', '').replace(/\s*\(.*\)$/, '');
  const flavor = k8s.installed ? k8sFlavorLabel(k8s) : '';
  return `<tr data-action="overview-host" data-host="${esc(host.id)}">
    <td class="primary">${esc(hostName(host))}<div class="tiny dim">${esc(hostGroupLabel(host))}</div></td>
    <td class="mono">${esc(hostAddress(host))}</td>
    <td>${hostStatusBadge(host)}${d.error ? `<div class="tiny dim">${esc(truncate(d.error, 36))}</div>` : ''}</td>
    <td>${k8s.installed ? badge(flavor, 'info') + (version ? ` <span class="tiny dim mono">${esc(version)}</span>` : '') : '<span class="dim">未安装</span>'}</td>
    <td class="mono">${cluster.reachable ? `${cluster.readyNodes}/${cluster.nodeCount}` : '—'}</td>
    <td class="right"><button class="btn sm" data-action="overview-host" data-host="${esc(host.id)}">查看</button></td>
  </tr>`;
}

function openOverviewDetail(kind) {
  if (kind === 'nodes') {
    openOverviewNodes();
    return;
  }
  let list = S.hosts;
  let title = '服务器清单';
  if (kind === 'k8s') {
    list = S.hosts.filter((h) => S.detected[h.id] && S.detected[h.id].k8s && S.detected[h.id].k8s.installed);
    title = '已安装 Kubernetes 的服务器';
  } else if (kind === 'attention') {
    list = attentionHosts();
    title = '需要关注的服务器';
  }
  const body = list.length
    ? `<p class="small muted" style="margin:0 0 12px">共 ${list.length} 台 · 点击行或“查看”进入服务器详情</p>
       <div class="table-wrap" style="border:none;background:transparent">
         <table class="data" style="min-width:760px">
           <thead><tr><th>服务器</th><th>地址</th><th>状态</th><th>Kubernetes</th><th>节点</th><th class="right">操作</th></tr></thead>
           <tbody>${list.map(overviewServerRow).join('')}</tbody>
         </table>
       </div>`
    : `<div class="empty">${icon('server', 'eico')}<h4>没有匹配的服务器</h4><p>${kind === 'attention' ? '当前没有离线或读取失败的服务器。' : '还没有安装 Kubernetes 的服务器。'}</p></div>`;
  openModal({ title, size: 'wide', body });
}

function openOverviewNodes() {
  const nodes = collectOverviewNodes();
  const body = nodes.length
    ? `<p class="small muted" style="margin:0 0 12px">按节点名称和内部 IP 去重，共 ${nodes.length} 个节点</p>
       <div class="table-wrap" style="border:none;background:transparent">
         <table class="data" style="min-width:820px">
           <thead><tr><th>节点</th><th>状态</th><th>角色</th><th>版本</th><th>内部 IP</th><th>来源服务器</th></tr></thead>
           <tbody>${nodes.map((n) => `<tr style="cursor:default">
             <td class="primary">${esc(n.name || '-')}<div class="tiny dim">${esc(n.os || '')}</div></td>
             <td>${statusBadge(n.status)}${n.schedulable === false ? ' ' + badge('已隔离', 'warn') : ''}</td>
             <td>${(n.roleList || []).map((r) => badge(r, r.includes('control') || r.includes('master') ? 'purple' : 'neutral')).join(' ') || '<span class="dim">worker</span>'}</td>
             <td class="mono">${esc(n.version || '-')}</td>
             <td class="mono">${esc(n.internalIP || '-')}</td>
             <td class="tiny dim">${esc((n.sources || []).join('、'))}</td>
           </tr>`).join('')}</tbody>
         </table>
       </div>`
    : `<div class="empty">${icon('cluster', 'eico')}<h4>还没有读取到节点</h4><p>先重新读取已安装 Kubernetes 的服务器信息，且该入口能读取集群 API。</p></div>`;
  openModal({ title: '集群节点清单', size: 'wide', body });
}

function featureCard(ico, title, desc) {
  return `<div class="card card-pad"><div class="stat-ico" style="margin-bottom:12px">${icon(ico)}</div><div style="font-size:13px;font-weight:650;margin-bottom:5px">${esc(title)}</div><div class="small muted" style="line-height:1.7">${esc(desc)}</div></div>`;
}

function statCard(ico, label, value, suffix, foot, tone = '', action = '', kind = '') {
  const attrs = action
    ? ` data-action="${esc(action)}" data-kind="${esc(kind)}" role="button" tabindex="0" title="点击查看明细"`
    : '';
  return `<div class="stat ${tone}${action ? ' clickable' : ''}"${attrs}>
    <div class="stat-top"><span>${esc(label)}</span><span class="stat-ico">${icon(ico)}</span></div>
    <div class="stat-val">${esc(value)}${suffix ? `<small>${esc(suffix)}</small>` : ''}</div>
    <div class="stat-foot">${esc(foot)}</div>
  </div>`;
}

function hostCardHTML(host) {
  const info = S.detected[host.id];
  const state = hostState(host);
  const k8s = (info && info.k8s) || {};
  const components = (info && info.components) || {};
  const cluster = (info && info.cluster) || {};
  const resources = (info && info.resources) || {};
  const role = hostRoleLabel(host) === '工作节点' ? '工作节点' : hostRoleLabel(host) === '控制面' ? '主节点' : '自动';
  const version = (k8s.version || (components.k3s && components.k3s.version) || '').replace('k3s version ', '').replace(/\s*\(.*\)$/, '');
  const ready = Number(cluster.readyNodes) || 0;
  const total = Number(cluster.nodeCount) || 0;
  const pct = total ? Math.round((ready / total) * 100) : 0;
  const tone = total && ready === total ? 'ok' : total ? 'warn' : '';
  const flavor = k8s.installed ? k8sFlavorLabel(k8s) : '';
  const canEnter = !!(k8s.installed && cluster.reachable !== false);
  const offline = info && !info.loading && !info.reachable;

  return `<div class="host-card ${offline ? 'offline' : ''}" id="host-card-${esc(host.id)}">
    <div class="host-top">
      <div class="host-ico">${icon(info && info.reachable ? 'server' : 'server')}</div>
      <div style="min-width:0;flex:1">
        <div class="host-name"><span class="dot ${state.dot}"></span><span class="nowrap" style="overflow:hidden;text-overflow:ellipsis">${esc(hostName(host))}</span></div>
        <div class="host-addr">${esc(hostAddress(host))}</div>
      </div>
      ${hostStatusBadge(host)}
    </div>
    <div class="host-meta">
      <span class="badge neutral">${esc(hostGroupLabel(host))}</span>
      <span class="badge ${hostEffectiveRole(host) === 'agent' ? 'cyan' : 'purple'}">${esc(role)}</span>
      ${flavor ? `<span class="badge info">${esc(flavor)} ${esc(version || '')}</span>` : ''}
      ${host.transport === 'kubeconfig' ? '<span class="badge neutral">kubeconfig</span>' : ''}
      ${host.auth && host.auth.type === 'key' ? '<span class="badge neutral">密钥</span>' : ''}
    </div>
    <div class="host-metrics">
      <div class="hm"><div class="k">节点</div><div class="v">${total ? `${ready}/${total}` : '—'}</div></div>
      <div class="hm"><div class="k">CPU</div><div class="v">${resources.cpu ? resources.cpu + ' 核' : '—'}</div></div>
      <div class="hm"><div class="k">内存</div><div class="v">${resources.memMB ? (resources.memMB >= 1024 ? (resources.memMB / 1024).toFixed(0) + 'G' : resources.memMB + 'M') : '—'}</div></div>
    </div>
    <div class="host-foot">
      <div class="progress ${tone}"><i style="width:${pct}%"></i></div>
      <div class="row" style="gap:6px;flex:none">
        ${info && info.loading ? '<span class="spinner"></span>' : ''}
        ${canEnter ? `<button class="btn sm" data-action="enter-cluster" data-host="${esc(host.id)}">${icon('cluster')} 集群详情</button>`
          : (k8s.installed ? `<button class="btn sm" data-action="enter-cluster" data-host="${esc(host.id)}">${icon('link')} 纳管</button>`
            : canDeployHost(host) ? `<button class="btn sm primary" data-action="host-install" data-host="${esc(host.id)}">${icon('rocket')} 安装 / 加入</button>`
              : '<span class="tiny dim">仅纳管</span>')}
        <button class="icon-btn" style="width:28px;height:28px" data-action="host-detect" data-host="${esc(host.id)}" title="重新读取服务器信息">${icon('refresh')}</button>
      </div>
    </div>
  </div>`;
}

function clusterPanelHTML(host, ov) {
  if (!host) {
    return `<div class="card"><div class="card-head"><h3>当前服务器的集群</h3></div><div class="card-body"><div class="empty" style="padding:18px 6px">${icon('cluster', 'eico')}<p style="margin-top:8px">尚未选择服务器</p></div></div></div>`;
  }
  const info = S.detected[host.id];
  if (!info || !info.k8s || !info.k8s.installed) {
    return `<div class="card">
      <div class="card-head"><h3>当前服务器的集群</h3><span class="hint">${esc(hostName(host))}</span></div>
      <div class="card-body">
        <div class="alert warn">${icon('alert')}<div>该服务器尚未安装 Kubernetes。点击服务器卡片上的「安装 / 加入」：单台可选择单机安装，多台可选择安装多台集群，已有集群则可作为工作节点加入。</div></div>
        <button class="btn primary" style="margin-top:12px" data-action="goto-install">${icon('rocket')} 前往安装</button>
      </div>
    </div>`;
  }
  if (!ov || S.overviewLoading[host.id]) {
    return `<div class="card"><div class="card-head"><h3>当前服务器的集群</h3><span class="hint">${esc(hostName(host))}</span></div><div class="card-body"><div class="skeleton" style="height:12px;width:70%;margin-bottom:10px"></div><div class="skeleton" style="height:64px"></div></div></div>`;
  }
  if (ov.error) {
    return `<div class="card"><div class="card-head"><h3>当前服务器的集群</h3><span class="hint">${esc(hostName(host))}</span></div><div class="card-body"><div class="alert err">${icon('alert')}<div>${esc(ov.error)}</div></div></div></div>`;
  }
  const pods = ov.podStats || {};
  const total = pods.total || 0;
  const healthy = Math.max(0, total - (pods.unhealthy || 0));
  const pct = total ? Math.round((healthy / total) * 100) : 0;
  const issues = (ov.pods || []).slice(0, 4);
  return `<div class="card">
    <div class="card-head"><h3>当前服务器的集群</h3><span class="badge info">${esc(ov.serverVersion || '')}</span></div>
    <div class="card-body">
      <div class="row" style="gap:16px;align-items:center;flex-wrap:nowrap">
        <div class="mini-donut" style="background:conic-gradient(var(--ok) ${pct}%, rgba(148,163,184,.16) 0)"><span>${pct}%</span></div>
        <div style="min-width:0">
          <div style="font-size:13px;font-weight:650">${esc(hostName(host))}</div>
          <div class="small muted" style="margin-top:3px">${esc(ov.nodeStats.ready)}/${esc(ov.nodeStats.total)} 节点 · ${esc(pods.running || 0)} 个 Pod 运行中</div>
          <div class="small dim" style="margin-top:2px">${esc(ov.namespaceCount || 0)} 个命名空间 · ${esc(ov.serviceCount || 0)} 个服务</div>
        </div>
      </div>
      ${issues.length ? `<div class="divider" style="margin:14px 0 8px"></div>
        <div class="tiny dim" style="margin-bottom:6px;letter-spacing:.6px">需要关注</div>
        ${issues.map((p) => `<div class="issue-row" data-action="open-resource" data-kind="pods" data-ns="${esc(p.namespace)}" data-name="${esc(p.name)}">
          <span class="dot ${p.healthy ? 'ok' : 'err'}"></span>
          <span class="mono" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>
          ${statusBadge(p.status)}
        </div>`).join('')}` : '<div class="alert ok" style="margin-top:14px">' + icon('check') + '<div>所有 Pod 运行正常</div></div>'}
    </div>
  </div>`;
}

function recentJobsHTML() {
  if (!S.jobs.length) return '<div class="empty" style="padding:16px 8px"><p>暂无操作记录</p></div>';
  return S.jobs.slice(0, 4).map((job) => `
    <div class="job-item" data-action="job-open" data-job="${esc(job.id)}">
      <span class="dot ${job.status === 'success' ? 'ok' : job.status === 'failed' ? 'err' : job.status === 'running' ? 'info pulse' : ''}"></span>
      <div style="flex:1;min-width:0">
        <div class="job-title">${esc(job.title)}</div>
        <div class="job-meta">${esc(jobStatusText(job.status))} · ${esc(age(job.createdAt))}前</div>
      </div>
      ${icon('chevron-right', 'dim')}
    </div>`).join('');
}

function renderRecentJobs() {
  const el = $('#recentJobs');
  if (el) el.innerHTML = recentJobsHTML();
}

function demoBanner() {
  return `<div class="alert info" style="margin-bottom:16px">${icon('zap')}<div><b>演示模式</b>：当前展示的是模拟数据，所有写操作不会真正执行。去掉地址栏中的 <span class="code-inline">?demo=1</span> 即可连接真实环境。</div></div>`;
}

/* ============================================================
 * 服务器
 * ============================================================ */
function renderHosts() {
  closeHostActionMenu();
  const view = $('#view');
  if (!S.hosts.length) {
    view.innerHTML = `${DEMO ? demoBanner() : ''}<div class="card" style="padding:10px">${emptyHTML('server', '还没有服务器', '在 data/server.json 中添加连接信息，或直接通过界面添加。支持 SSH、本地与 kubeconfig 三种接入方式。', '<button class="btn primary" data-action="host-add">' + icon('plus') + ' 添加服务器</button> <button class="btn" data-action="group-add">' + icon('plus') + ' 新增分组</button>')}</div>`;
    return;
  }
  maybeAutoDetect();
  view.innerHTML = `
    ${DEMO ? demoBanner() : ''}
    <div class="view-head">
      <div><h2>服务器</h2><p>按分组管理服务器：分组下是服务器，把服务器拖到别的分组即可移动；选择一个服务器查看它的系统与 Kubernetes 集群</p></div>
      <div class="toolbar">
        <button class="btn" data-action="detect-all">${icon('refresh')} 全部重新读取</button>
        <button class="btn primary" data-action="host-add">${icon('plus')} 添加服务器</button>
      </div>
    </div>
    ${hostSelectionBanner()}
    <div class="server-layout">
      <aside class="card server-rail">
        <div class="server-rail-head">
          <div style="position:relative">
            <input class="input" id="hostsSearch" style="width:100%;padding-left:30px" placeholder="搜索名称 / 地址" value="${esc(S.page.hostsQuery)}" />
            <span style="position:absolute;left:10px;top:9px;color:var(--dim)">${icon('search')}</span>
          </div>
          <div class="row" style="gap:6px;align-items:center;justify-content:space-between">
            <div class="tiny dim" id="serverCount">${hostGroupNames().length} 个分组 · ${S.hosts.length} 台服务器</div>
            <button class="btn sm" data-action="group-add">${icon('plus')} 新增分组</button>
          </div>
        </div>
        <div class="server-list" id="serverList">${serverTreeHTML()}</div>
      </aside>
      <section class="server-detail" id="serverDetail">${serverDetailHTML(activeHost())}</section>
    </div>`;
}

function hostTransportLabel(host) {
  if (host.transport === 'kubeconfig') return 'kubeconfig';
  if (host.transport === 'local') return '本机';
  return 'SSH';
}

// 左栏二级树：一级是分组（目录），二级是组内服务器
function hostTreeGroups() {  const q = S.page.hostsQuery.trim().toLowerCase();
  const names = hostGroupNames();
  return names.map((name) => {
    const all = S.hosts.filter((h) => String(h.group || '').trim() === name);
    const list = q
      ? all.filter((h) => [h.name, h.id, h.host, h.notes].some((v) => String(v || '').toLowerCase().includes(q)))
      : all;
    return { name, total: all.length, hosts: list, collapsed: !!S.page.collapsedGroups[name] };
  });
}

function serverTreeHTML() {
  const groups = hostTreeGroups();
  const q = S.page.hostsQuery.trim();
  const visible = groups.filter((g) => !q || g.hosts.length > 0);
  if (!visible.length) {
    return `<div class="empty" style="padding:28px 12px">${icon('search', 'eico')}<h4>没有匹配的服务器</h4><p>调整搜索条件。</p></div>`;
  }
  return visible.map((group) => {
    const builtin = group.name === defaultGroupName();
    return `<div class="group-node ${group.collapsed ? 'collapsed' : ''}" data-group-node="${esc(group.name)}" data-drop-group="${esc(group.name)}">
      <div class="group-node-head" data-action="group-toggle" data-group="${esc(group.name)}" role="button" tabindex="0" aria-expanded="${group.collapsed ? 'false' : 'true'}">
        <span class="group-caret">${icon('chevron-down')}</span>
        <span class="group-node-name">${esc(group.name)}</span>
        <span class="group-node-count">${group.hosts.length}${q && group.hosts.length !== group.total ? '/' + group.total : ''}</span>
        <span class="group-node-tools">
          <button type="button" class="icon-btn xs" data-action="group-rename" data-group="${esc(group.name)}" title="重命名分组" aria-label="重命名分组 ${esc(group.name)}" ${builtin ? 'disabled' : ''}>${icon('edit')}</button>
          <button type="button" class="icon-btn xs danger" data-action="group-delete" data-group="${esc(group.name)}" title="删除分组" aria-label="删除分组 ${esc(group.name)}" ${builtin ? 'disabled' : ''}>${icon('trash')}</button>
        </span>
      </div>
      <div class="group-node-body">
        ${group.hosts.length ? group.hosts.map((host) => serverNodeHTML(host)).join('') : `<div class="group-node-empty">${q ? '没有匹配的服务器' : '空分组，可把服务器拖到这里'}</div>`}
      </div>
    </div>`;
  }).join('');
}

function serverNodeHTML(host) {
  const info = S.detected[host.id];
  const k8s = (info && info.k8s) || {};
  const cluster = (info && info.cluster) || {};
  const state = hostState(host);
  const flavor = k8s.installed ? k8sFlavorLabel(k8s) : '';
  const role = k8s.role === 'server' || k8s.role === 'control-plane' || k8s.role === 'master'
    ? 'Master'
    : k8s.role === 'agent' || k8s.role === 'worker' ? 'Worker'
    : k8s.role === 'external' ? '外部' : '';
  const multiSelected = Array.isArray(S.selectedHostIds) && S.selectedHostIds.length > 1 && S.selectedHostIds.includes(host.id);
  return `<div class="server-item-wrap" draggable="true" data-drag-host="${esc(host.id)}" data-group="${esc(host.group || '')}">
    <button type="button" class="server-item ${host.id === S.activeHostId ? 'active' : ''} ${multiSelected && host.id !== S.activeHostId ? 'multi-selected' : ''}" data-action="host-select" data-host="${esc(host.id)}">
      <div class="server-item-top">
        <span class="dot ${state.dot}"></span>
        <span class="server-item-name">${esc(hostName(host))}</span>
        ${hostStatusBadge(host)}
      </div>
      <div class="server-item-sub">${esc(hostAddress(host))}</div>
      <div class="server-item-meta">
        ${info && info.loading ? badge('读取中', 'info') : flavor ? badge(flavor, 'info') : badge('未安装', 'warn')}
        ${role ? badge(role, role === 'Master' ? 'purple' : role === 'Worker' ? 'cyan' : 'neutral') : ''}
        ${cluster.reachable ? badge(`${cluster.readyNodes}/${cluster.nodeCount} 节点`, cluster.readyNodes === cluster.nodeCount ? 'ok' : 'warn') : ''}
      </div>
    </button>
    <button type="button" class="icon-btn server-item-more" data-action="host-menu" data-host="${esc(host.id)}" title="更多操作" aria-label="${esc(hostName(host))} 更多操作" aria-haspopup="menu" aria-expanded="false">${icon('more')}</button>
  </div>`;
}

function serverDetailHTML(host) {
  if (!host) {
    return `<div class="card">${emptyHTML('server', '选择一台服务器', '从左侧选择服务器，这里会显示系统状态和它所在的 Kubernetes 集群。')}</div>`;
  }
  const info = S.detected[host.id] || {};
  const k8s = info.k8s || {};
  const cluster = info.cluster || {};
  const os = info.os || {};
  const res = info.resources || {};
  const nodes = Array.isArray(info.nodes) ? info.nodes : [];
  const state = hostState(host);
  const version = (k8s.version || (info.components && info.components.k3s && info.components.k3s.version) || '')
    .replace('k3s version ', '').replace(/\s*\(.*\)$/, '');
  const flavor = k8sFlavorLabel(k8s);
  const role = k8s.role === 'server' || k8s.role === 'control-plane'
    ? '控制平面'
    : k8s.role === 'agent' ? '工作节点' : k8s.role === 'external' ? '外部集群' : '未识别';
  const reachable = !!cluster.reachable;
  const canDeploy = canDeployHost(host);
  const user = info.user ? `${info.user}${info.isRoot ? '（root）' : info.sudo === 'yes' ? '（sudo）' : ''}` : '-';
  const loading = !!info.loading;
  const authFailed = !loading && !!info.authFailed;
  const authError = authFailed ? (info.error || '') : '';

  const systemCard = `<div class="card">
    <div class="card-head"><h3>系统</h3><span class="hint">${esc(state.text)}</span></div>
    <div class="card-body">
      <div class="kv"><span class="k">操作系统</span><span class="v">${esc(os.pretty || os.name || '-')}</span></div>
      <div class="kv"><span class="k">内核 / 架构</span><span class="v">${esc(os.kernel || '-')} ${esc(os.arch ? '/ ' + os.arch : '')}</span></div>
      <div class="kv"><span class="k">CPU</span><span class="v">${res.cpu ? esc(res.cpu) + ' 核' : '-'}</span></div>
      <div class="kv"><span class="k">内存</span><span class="v">${fmtBytes(res.memMB)}</span></div>
      <div class="kv"><span class="k">Swap</span><span class="v">${fmtBytes(res.swapMB)}</span></div>
      <div class="kv"><span class="k">磁盘可用</span><span class="v">${fmtBytes(res.diskFreeMB)}</span></div>
      <div class="kv"><span class="k">运行时长</span><span class="v">${fmtUptime(res.uptimeSeconds)}</span></div>
      <div class="kv"><span class="k">接入 / 用户</span><span class="v">${esc(hostTransportLabel(host))} · ${esc(user)}</span></div>
      <div class="kv"><span class="k">init / cgroup</span><span class="v">${esc(info.init || '-')} ${esc(info.cgroup ? '/ ' + info.cgroup : '')}</span></div>
    </div>
  </div>`;

  let k8sCard;
  if (loading) {
    k8sCard = `<div class="card">
      <div class="card-head"><h3>Kubernetes</h3><span class="hint">读取中</span></div>
      <div class="card-body"><div class="row" style="padding:12px 0"><span class="spinner"></span><span class="muted">正在读取系统与集群信息…</span></div></div>
    </div>`;
  } else if (authFailed) {
    k8sCard = `<div class="card">
      <div class="card-head"><h3>Kubernetes</h3>${badge(hostAuthFailureLabel(host), 'err')}</div>
      <div class="card-body">
        <div class="alert err">${icon('alert')}<div>${esc(authError || '服务器拒绝了登录。')}</div></div>
        <div class="row" style="margin-top:12px">
          <button class="btn primary" data-action="host-edit" data-host="${esc(host.id)}">${icon('edit')} 修改密码</button>
          <button class="btn" data-action="host-detect" data-host="${esc(host.id)}">${icon('refresh')} 重新读取服务器信息</button>
        </div>
      </div>
    </div>`;
  } else if (!k8s.installed) {
    k8sCard = `<div class="card">
      <div class="card-head"><h3>Kubernetes</h3>${badge('未安装', 'warn')}</div>
      <div class="card-body">
        <div class="alert warn">${icon('alert')}<div>这台服务器上没有读取到 Kubernetes。${canDeploy
          ? '可以直接部署 k3s，或先做环境预检。'
          : host.transport === 'local'
            ? `${localTransportBlockReason()}。`
            : '当前接入方式仅用于纳管已有集群，不能部署。'}</div></div>
        <div class="row" style="margin-top:12px">
          ${canDeploy ? `<button class="btn primary" data-action="host-install" data-host="${esc(host.id)}">${icon('rocket')} 安装 / 加入</button>` : ''}
          ${canDeploy ? `<button class="btn" data-action="host-preflight" data-host="${esc(host.id)}">${icon('shield')} 环境预检</button>` : ''}
          <button class="btn" data-action="host-detect" data-host="${esc(host.id)}">${icon('refresh')} 重新读取服务器信息</button>
        </div>
      </div>
    </div>`;
  } else {
    const clusterText = reachable
      ? `已读取完整集群：${cluster.readyNodes}/${cluster.nodeCount} 节点就绪`
      : (cluster.error || '无法读取集群 API');
    const via = info.kubeAccess && info.kubeAccess.via;
    const viaLabel = via ? (via.host && via.host !== via.name ? `${via.name}（${via.host}）` : (via.name || via.host)) : '';
    const workerHint = !reachable && role === '工作节点' && !via
      ? '这是一台工作节点，当前 SSH 入口通常没有集群管理 kubeconfig，因此无法读取完整集群。请切换到控制平面入口，或把该节点连接的控制节点加入服务器列表。'
      : '';
    k8sCard = `<div class="card">
      <div class="card-head"><h3>Kubernetes</h3><span class="hint">${esc(flavor)} ${esc(version || '')}</span></div>
      <div class="card-body">
        <div class="server-meta" style="margin-top:0">
          ${badge(flavor, 'info')}
          ${badge(role, role === '控制平面' ? 'purple' : 'neutral')}
          ${reachable ? badge('API 可达', 'ok') : badge('API 不可达', 'err')}
          ${k8s.managed ? badge('本机在集群中', 'neutral') : ''}
        </div>
        <div class="kv" style="margin-top:10px"><span class="k">版本</span><span class="v">${esc(version || '-')}</span></div>
        <div class="kv"><span class="k">集群节点</span><span class="v">${reachable ? `${cluster.readyNodes}/${cluster.nodeCount} 就绪` : '-'}</span></div>
        <div class="kv"><span class="k">集群 API</span><span class="v">${esc(clusterText)}</span></div>
          ${reachable
          ? `<div class="alert info" style="margin-top:12px">${icon('layers')}<div>${via
            ? `本机是 k3s agent（控制面不在本机），集群数据通过控制节点 <b>${esc(viaLabel)}</b> 读取，下面列出全部节点。`
            : '这台服务器可以读取整个集群，下面列出全部节点；工作负载、指标、事件和 YAML 可在集群详情推窗中查看。'}</div></div>
             <div class="row" style="margin-top:12px">
               <button class="btn primary" data-action="enter-cluster" data-host="${esc(host.id)}">${icon('cluster')} 打开集群详情</button>
               <button class="btn" data-action="host-detect" data-host="${esc(host.id)}">${icon('refresh')} 重新读取服务器信息</button>
             </div>`
          : `<div class="alert warn" style="margin-top:12px">${icon('alert')}<div>${esc(clusterText)}${workerHint ? '<br><br>' + esc(workerHint) : ''}</div></div>
             <div class="row" style="margin-top:12px">
               <button class="btn" data-action="host-detect" data-host="${esc(host.id)}">${icon('refresh')} 重新读取服务器信息</button>
             </div>`}
      </div>
    </div>`;
  }

  const nodesCard = nodes.length ? `<div class="card">
    <div class="card-head"><h3>集群节点</h3><span class="hint">完整集群 · ${nodes.length} 个节点</span></div>
    <div class="table-wrap" style="border:none;border-radius:0 0 14px 14px">
      <table class="data server-node-table">
        <thead><tr><th>节点</th><th>状态</th><th>角色</th><th>版本</th><th>内部 IP</th></tr></thead>
        <tbody>
          ${nodes.map((n) => `<tr style="cursor:default">
            <td class="primary">${esc(n.name)}<div class="tiny dim">${esc(n.os || '')}</div></td>
            <td>${statusBadge(n.status)}${n.schedulable === false ? ' ' + badge('已隔离', 'warn') : ''}</td>
            <td>${(n.roleList || []).map((r) => badge(r, r.includes('control') || r.includes('master') ? 'purple' : 'neutral')).join(' ') || '<span class="dim">worker</span>'}</td>
            <td class="mono">${esc(n.version || '-')}</td>
            <td class="mono">${esc(n.internalIP || '-')}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>` : '';

  return `<div class="card card-pad server-hero">
      <div class="server-avatar">${icon('server')}</div>
      <div class="server-hero-main">
        <h2>${esc(hostName(host))} ${hostStatusBadge(host)}</h2>
        <p>${esc(hostAddress(host))} · ${esc(hostGroupLabel(host))} · ${esc(hostTransportLabel(host))}</p>
        <div class="server-meta">
          ${badge(hostRoleLabel(host) || '自动识别', hostEffectiveRole(host) === 'agent' ? 'cyan' : 'purple')}
          ${loading ? badge('读取中', 'info') : authFailed ? badge(hostAuthFailureLabel(host), 'err') : k8s.installed ? badge(flavor, 'info') : badge('未安装', 'warn')}
          ${cluster.reachable ? badge(`${cluster.readyNodes}/${cluster.nodeCount} 节点`, 'ok') : ''}
          ${host.notes ? badge(truncate(host.notes, 30), 'neutral') : ''}
        </div>
      </div>
      ${(host.transport || 'ssh') === 'ssh' ? `<div class="toolbar">
        <button class="btn sm" data-action="host-ssh" data-host="${esc(host.id)}">${icon('terminal')} 远程连接</button>
      </div>` : ''}
    </div>
    <div class="server-grid">${systemCard}${k8sCard}</div>
    ${nodesCard}`;
}

function refreshServerList() {
  closeHostActionMenu();
  const list = $('#serverList');
  if (list) list.innerHTML = serverTreeHTML();
  const count = $('#serverCount');
  if (count) count.textContent = `${hostGroupNames().length} 个分组 · ${S.hosts.length} 台服务器`;
}

function refreshHostsTable() {
  if (S.view !== 'hosts') return;
  refreshServerList();
  const detail = $('#serverDetail');
  if (detail) detail.innerHTML = serverDetailHTML(activeHost());
}

/* ============================================================
 * 服务器列表操作菜单
 * ============================================================ */
let hostActionMenuEl = null;
let hostActionMenuAnchor = null;

function closeHostActionMenu() {
  if (!hostActionMenuEl) return;
  hostActionMenuEl.remove();
  hostActionMenuEl = null;
  if (hostActionMenuAnchor && hostActionMenuAnchor.isConnected) {
    hostActionMenuAnchor.setAttribute('aria-expanded', 'false');
  }
  hostActionMenuAnchor = null;
}

function openHostActionMenu(anchor, host) {
  if (!anchor || !host) return;
  closeHostActionMenu();
  const info = S.detected[host.id] || {};
  const k8s = info.k8s || {};
  const installed = !!k8s.installed;
  const canDeploy = canDeployHost(host);
  const item = (action, iconName, label, danger = false) => `<button type="button" class="ctx-item${danger ? ' danger' : ''}" role="menuitem" data-action="${action}" data-host="${esc(host.id)}">${icon(iconName)}<span>${esc(label)}</span></button>`;

  const primary = [];
  if ((host.transport || 'ssh') === 'ssh') primary.push(item('host-ssh', 'terminal', '远程连接'));
  primary.push(item('host-edit', 'edit', '编辑连接'));
  primary.push(item('host-detect', 'refresh', '重新读取服务器信息'));
  primary.push(item('host-duplicate', 'copy', '复制'));

  const deploy = [];
  if (canDeploy && !installed) deploy.push(item('host-install', 'rocket', '安装 / 加入'));
  if (canDeploy && installed && (k8s.flavor === 'k3s' || !k8s.flavor)) deploy.push(item('host-uninstall', 'trash', '卸载 k3s', true));

  const menu = document.createElement('div');
  menu.id = 'hostActionMenu';
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', `${hostName(host)} 操作`);
  menu.innerHTML = [
    ...primary,
    deploy.length ? '<div class="ctx-sep"></div>' : '',
    ...deploy,
    '<div class="ctx-sep"></div>',
    item('host-delete', 'trash', '删除服务器配置', true)
  ].filter(Boolean).join('');
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.appendChild(menu);
  hostActionMenuEl = menu;
  hostActionMenuAnchor = anchor;
  anchor.setAttribute('aria-expanded', 'true');

  const rect = anchor.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const gap = 8;
  let left = rect.right - menuRect.width;
  left = Math.max(gap, Math.min(left, window.innerWidth - menuRect.width - gap));
  let top = rect.bottom + 6;
  if (top + menuRect.height > window.innerHeight - gap) {
    top = Math.max(gap, rect.top - menuRect.height - 6);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = '';

  menu.addEventListener('click', () => closeHostActionMenu());
  const first = menu.querySelector('.ctx-item');
  if (first) first.focus({ preventScroll: true });
}

function uniqueCopyName(host) {
  const base = `${hostName(host)} 副本`;
  const names = new Set(S.hosts.map((item) => String(item.name || '')));
  let name = base;
  let n = 2;
  while (names.has(name)) name = `${base} ${n++}`;
  return name;
}

async function duplicateHost(host) {
  const template = {
    id: '',
    name: uniqueCopyName(host),
    group: host.group || defaultGroupName(),
    transport: host.transport || 'ssh',
    host: host.host || '',
    port: host.port || 22,
    user: host.user || 'root',
    role: host.role || 'auto',
    useSudo: !!host.useSudo,
    notes: host.notes || '',
    kubeconfig: host.kubeconfig || '',
    kubectlPath: host.kubectlPath || '',
    context: host.context || '',
    auth: { ...(host.auth || { type: 'password' }) }
  };
  if (template.auth.type === 'password') {
    template.auth.password = '';
    if (host.auth && host.auth.password) {
      try {
        const data = await api(`/hosts/${encodeURIComponent(host.id)}/password`);
        template.auth.password = (data && data.password) || '';
      } catch (err) {
        toast('原密码读取失败，请在复制表单中重新输入', 'warn');
      }
    }
  }
  openHostForm(template, { copy: true });
}

