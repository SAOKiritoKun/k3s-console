'use strict';

/* ============================================================
 * 资源详情抽屉
 * ============================================================ */
function openResourceDrawer(kind, namespace, name) {
  let item = null;
  if (S.workloadData && S.workloadData.kind === kind) {
    item = (S.workloadData.items || []).find((x) => x.name === name && (x.namespace || '') === (namespace || ''));
  }
  S.detail = { kind, namespace: namespace || '', name, item, tab: 'overview', cache: {}, logState: {} };
  $('#overlay').classList.add('show');
  const root = $('#drawerRoot');
  root.innerHTML = `
    <div class="drawer" id="resourceDrawer">
      <div class="drawer-head">
        <div class="host-ico">${icon(KIND_ICONS[kind] || 'box')}</div>
        <div style="min-width:0;flex:1">
          <div class="drawer-title"><span class="nm">${esc(name)}</span>${badge(kindMeta(kind).label, 'info')}</div>
          <div class="drawer-sub">${esc(namespace || '集群级资源')}</div>
        </div>
        <button class="icon-btn" data-action="drawer-close" title="关闭">${icon('x')}</button>
      </div>
      <div class="drawer-tabs">
        <button class="tab active" data-action="drawer-tab" data-tab="overview">概览</button>
        <button class="tab" data-action="drawer-tab" data-tab="yaml">YAML</button>
        ${kind === 'pods' ? '<button class="tab" data-action="drawer-tab" data-tab="logs">日志</button>' : ''}
        ${kind === 'pods' ? '<button class="tab" data-action="drawer-tab" data-tab="terminal">终端</button>' : ''}
        <button class="tab" data-action="drawer-tab" data-tab="events">事件</button>
        <button class="tab" data-action="drawer-tab" data-tab="describe">Describe</button>
      </div>
      <div class="drawer-body" id="drawerBody"></div>
      <div class="drawer-foot">
        ${kind === 'pods' ? `<button class="btn" data-action="drawer-restart-pod">${icon('refresh')} 重启 Pod</button>` : ''}
        ${['deployments', 'statefulsets', 'replicasets'].includes(kind) ? `<button class="btn" data-action="drawer-scale">${icon('layers')} 扩缩容</button>` : ''}
        ${['deployments', 'statefulsets', 'daemonsets'].includes(kind) ? `<button class="btn" data-action="drawer-restart">${icon('refresh')} 重启</button>` : ''}
        <span class="spacer"></span>
        <button class="btn danger" data-action="drawer-delete">${icon('trash')} 删除</button>
        <button class="btn ghost" data-action="drawer-close">关闭</button>
      </div>
    </div>`;
  requestAnimationFrame(() => { const el = $('#resourceDrawer'); if (el) el.classList.add('show'); });
  renderDrawerTab('overview');
}

function closeDrawer() {
  const drawer = $('#resourceDrawer');
  if (!drawer) { $('#overlay').classList.remove('show'); return; }
  if (S.detail && S.detail.term) closeTerminal(S.detail, '', true);
  drawer.classList.remove('show');
  S.detail = null;
  setTimeout(() => {
    const root = $('#drawerRoot');
    if (root.contains(drawer)) root.innerHTML = '';
    if (!root.querySelector('.drawer') && !$('#modalRoot .modal')) $('#overlay').classList.remove('show');
  }, 240);
}

function renderDrawerTab(tab) {
  if (!S.detail) return;
  const d = S.detail;
  if (d.term && tab !== 'terminal') closeTerminal(d, '', true);
  d.tab = tab;
  $$('#resourceDrawer .drawer-tabs .tab').forEach((el) => el.classList.toggle('active', el.dataset.tab === tab));
  const body = $('#drawerBody');
  if (!body) return;
  if (tab === 'overview') return renderOverviewTab(body);
  if (tab === 'yaml') return renderYamlTab(body);
  if (tab === 'logs') return renderLogsTab(body);
  if (tab === 'terminal') return renderTerminalTab(body);
  if (tab === 'events') return renderEventsTab(body);
  if (tab === 'describe') return renderDescribeTab(body);
}

const FIELD_LABELS = {
  name: '名称', namespace: '命名空间', status: '状态', ready: '就绪', readyNum: '就绪数', totalNum: '容器数',
  restarts: '重启次数', node: '节点', ip: 'Pod IP', qos: 'QoS', owner: '控制器', images: '镜像',
  replicas: '副本', desired: '期望副本', available: '可用副本', updated: '已更新', unavailable: '不可用',
  strategy: '更新策略', current: '当前副本', serviceName: '关联服务', type: '类型', clusterIP: 'ClusterIP',
  externalIP: '外部 IP', ports: '端口', selector: '选择器', class: 'Ingress Class', hosts: '域名', tls: 'TLS',
  keys: '键数量', keyList: '键列表', capacity: '容量', storageClass: '存储类', accessModes: '访问模式',
  provisioner: 'Provisioner', reclaimPolicy: '回收策略', bindingMode: '绑定模式', default: '默认',
  claim: '绑定声明', schedule: '调度表达式', suspend: '已暂停', active: '运行中', completions: '完成情况',
  duration: '耗时', lastSchedule: '上次调度', target: '目标', min: '最小副本', max: '最大副本', metrics: '指标',
  policyTypes: '策略类型', podSelector: 'Pod 选择器', ingressRules: '入站规则数', egressRules: '出站规则数',
  secrets: 'Secrets 数量', misscheduled: '错误调度', reason: '原因', message: '消息', object: '对象',
  count: '次数', lastSeen: '最后发生', labels: '标签', createdAt: '创建时间'
};

function renderOverviewTab(body) {
  const d = S.detail;
  const item = d.item;
  if (!item) {
    body.innerHTML = '<div class="alert warn">' + icon('alert') + '<div>列表中没有该资源的摘要信息，请查看 YAML 或 Describe 标签页。</div></div>';
    return;
  }
  const skip = new Set(['labels', 'annotations', 'containers', 'images', 'owner', 'healthy', 'name', 'namespace', 'createdAt', 'createdAt']);
  const rows = Object.entries(item).filter(([k, v]) => !skip.has(k) && v !== null && v !== undefined && typeof v !== 'object').map(([k, v]) => {
    let text = String(v);
    if (k === 'createdAt') text = `${fmtTime(v)}（${age(v)}前）`;
    return `<div class="kv"><span class="k">${esc(FIELD_LABELS[k] || k)}</span><span class="v">${esc(text)}</span></div>`;
  }).join('');
  const labels = Object.entries(item.labels || {});
  body.innerHTML = `
    <div class="grid grid-2" style="gap:10px;margin-bottom:16px">
      <div class="card card-pad" style="padding:13px">
        <div class="tiny dim" style="margin-bottom:4px">状态</div>
        ${item.status ? statusBadge(item.status) : item.ready ? badge('Ready', 'ok') : '<span class="dim">-</span>'}
      </div>
      <div class="card card-pad" style="padding:13px">
        <div class="tiny dim" style="margin-bottom:4px">创建时间</div>
        <div class="mono small">${esc(fmtTime(item.createdAt))}</div>
      </div>
    </div>
    <div class="tiny dim" style="letter-spacing:1px;margin-bottom:6px">属性</div>
    <div style="margin-bottom:18px">${rows || '<div class="dim small">无</div>'}</div>
    ${labels.length ? `<div class="tiny dim" style="letter-spacing:1px;margin-bottom:6px">标签</div>
      <div class="row" style="gap:6px;margin-bottom:18px">${labels.map(([k, v]) => `<span class="badge neutral mono">${esc(k)}=${esc(v)}</span>`).join('')}</div>` : ''}
    ${item.containers && item.containers.length ? `<div class="tiny dim" style="letter-spacing:1px;margin-bottom:6px">容器</div>
      ${item.containers.map((c) => `<div class="kv"><span class="k">${esc(c.name)}</span><span class="v">${esc(c.image)}</span></div>`).join('')}` : ''}
    ${item.images && item.images.length && !item.containers ? `<div class="tiny dim" style="letter-spacing:1px;margin:14px 0 6px">镜像</div>
      <div class="row" style="gap:6px">${item.images.map((img) => `<span class="badge neutral mono">${esc(img)}</span>`).join('')}</div>` : ''}`;
}

async function renderYamlTab(body) {
  const d = S.detail;
  if (d.cache.yaml) {
    paintYaml(body, d.cache.yaml);
    return;
  }
  body.innerHTML = '<div class="empty"><span class="spinner"></span><p style="margin-top:10px">读取 YAML…</p></div>';
  try {
    const q = new URLSearchParams({ kind: d.kind, namespace: d.namespace, name: d.name });
    const data = await api(`/hosts/${encodeURIComponent(activeHost().id)}/resource?${q.toString()}`);
    d.cache.yaml = data.yaml;
    if (S.detail === d && d.tab === 'yaml') paintYaml(body, data.yaml);
  } catch (err) {
    body.innerHTML = `<div class="alert err">${icon('alert')}<div>${esc(errorText(err))}</div></div>`;
  }
}

function paintYaml(body, yaml) {
  body.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      <span class="tiny dim">可直接编辑并应用（等同 kubectl apply）</span>
      <span class="spacer"></span>
      <button class="btn sm" id="yamlReload">${icon('refresh')} 重新读取</button>
      <button class="btn sm" id="yamlDownload">${icon('download')}</button>
      <button class="btn sm primary" id="yamlApply">${icon('check')} 应用修改</button>
    </div>
    <textarea class="editor" id="yamlEditor" spellcheck="false" style="min-height:460px"></textarea>`;
  const editor = $('#yamlEditor', body);
  editor.value = yaml;
  $('#yamlReload', body).addEventListener('click', () => {
    S.detail.cache.yaml = null;
    renderYamlTab(body);
  });
  $('#yamlDownload', body).addEventListener('click', () => downloadText(`${S.detail.kind}-${S.detail.name}.yaml`, editor.value));
  $('#yamlApply', body).addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: '应用 YAML 修改',
      message: `即将把修改后的 YAML 应用到 <b>${esc(S.detail.namespace || '集群')} / ${esc(S.detail.name)}</b>，是否继续？`,
      confirmText: '应用',
      danger: false
    });
    if (!ok) return;
    try {
      const result = await api(`/hosts/${encodeURIComponent(activeHost().id)}/apply`, { method: 'POST', body: { yaml: editor.value, namespace: S.detail.namespace || '' } });
      toast(truncate(result.output || '已应用', 300), 'success');
      S.detail.cache.yaml = null;
      S.detail.cache.describe = null;
      loadWorkloads(true);
    } catch (err) {
      toast(errorText(err), 'error');
    }
  });
}

async function renderLogsTab(body) {
  const d = S.detail;
  const item = d.item || {};
  const containers = (item.containers || []).map((c) => c.name).filter(Boolean);
  if (!d.logState.container && containers.length) d.logState.container = containers[0];
  const state = d.logState;
  body.innerHTML = `
    <div class="row" style="margin-bottom:10px">
      ${containers.length > 1 ? `<select class="select" id="logContainer" style="width:170px">${containers.map((c) => `<option value="${esc(c)}" ${state.container === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select>` : ''}
      <select class="select" id="logTail" style="width:110px">
        ${[200, 500, 1000, 2000].map((n) => `<option value="${n}" ${(state.tail || 500) === n ? 'selected' : ''}>${n} 行</option>`).join('')}
      </select>
      <label class="check"><input type="checkbox" id="logPrevious" ${state.previous ? 'checked' : ''} /> 上一次运行</label>
      <span class="spacer"></span>
      <button class="btn sm" id="logRefresh">${icon('refresh')} 刷新</button>
      <button class="btn sm" id="logDownload">${icon('download')}</button>
    </div>
    <div class="logbox" id="logContent" style="height:calc(100vh - 320px);min-height:300px">加载中…</div>`;
  const content = $('#logContent', body);
  let currentText = '';
  let loadSeq = 0;
  const load = async () => {
    const seq = ++loadSeq;
    content.textContent = '加载中…';
    try {
      const q = new URLSearchParams({ namespace: d.namespace, pod: d.name, tail: String(state.tail || 500) });
      if (state.container) q.set('container', state.container);
      if (state.previous) q.set('previous', '1');
      const data = await api(`/hosts/${encodeURIComponent(activeHost().id)}/logs?${q.toString()}`);
      if (seq !== loadSeq || S.detail !== d || !content.isConnected) return;
      currentText = data.logs || '';
      content.textContent = currentText || '（无日志输出）';
      content.scrollTop = content.scrollHeight;
    } catch (err) {
      if (seq !== loadSeq || S.detail !== d || !content.isConnected) return;
      currentText = '';
      content.textContent = errorText(err);
    }
  };
  const sel = $('#logContainer', body);
  if (sel) sel.addEventListener('change', () => { state.container = sel.value; load(); });
  $('#logTail', body).addEventListener('change', (e) => { state.tail = Number(e.target.value); load(); });
  $('#logPrevious', body).addEventListener('change', (e) => { state.previous = e.target.checked; load(); });
  $('#logRefresh', body).addEventListener('click', load);
  $('#logDownload', body).addEventListener('click', () => downloadText(`${d.name}.log`, currentText));
  load();
}

function terminalStatus(st) {
  if (st.status === 'connecting') return badge('连接中', 'info');
  if (st.status === 'running') return badge('已连接', 'ok');
  if (st.status === 'error') return badge('连接失败', 'err');
  return badge('已断开', 'neutral');
}

function closeTerminal(d, message = '', dispose = false) {
  if (!d || !d.term) return;
  const st = d.term;
  if (st.es) {
    try { st.es.close(); } catch (_) { /* ignore */ }
    st.es = null;
  }
  const sessionId = st.sessionId;
  st.sessionId = null;
  st.inputQueue = Promise.resolve();
  if (sessionId) {
    api(`/shells/${encodeURIComponent(sessionId)}/close`, { method: 'POST' }).catch(() => {});
  }
  if (st.status === 'running' || st.status === 'connecting') st.status = 'closed';
  if (message && st.xterm) st.xterm.write(`\r\n${message}\r\n`);
  if (dispose && st.xterm) {
    st.xterm.dispose();
    st.xterm = null;
  }
  if (!dispose && S.detail === d && d.tab === 'terminal') paintTerminalState(d);
}

function paintTerminalState(d) {
  const st = d && d.term;
  if (!st || S.detail !== d) return;
  const status = $('#termBadge');
  if (status) status.innerHTML = terminalStatus(st);
  const reconnect = $('#termReconnect');
  if (reconnect) reconnect.disabled = st.status === 'connecting';
  const close = $('#termClose');
  if (close) close.disabled = st.status === 'connecting';
}

async function startTerminal(d, container) {
  const st = d && d.term;
  if (!st || !st.xterm) return;
  const startToken = (st.startToken || 0) + 1;
  st.startToken = startToken;
  if (st.es) {
    try { st.es.close(); } catch (_) { /* ignore */ }
    st.es = null;
  }
  if (st.sessionId) {
    const oldId = st.sessionId;
    st.sessionId = null;
    api(`/shells/${encodeURIComponent(oldId)}/close`, { method: 'POST' }).catch(() => {});
  }
  st.container = container || '';
  st.status = 'connecting';
  st.tty = true;
  st.inputQueue = Promise.resolve();
  st.xterm.reset();
  st.xterm.write('正在建立容器终端…\r\n');
  paintTerminalState(d);

  if (DEMO) {
    st.status = 'closed';
    st.xterm.write('演示模式不会真正打开容器终端。连接真实 SSH 集群后，可以在这里进入指定容器执行命令。\r\n');
    paintTerminalState(d);
    return;
  }

  try {
    const data = await api(`/hosts/${encodeURIComponent(activeHost().id)}/shell`, {
      method: 'POST',
      body: { namespace: d.namespace, pod: d.name, container: st.container }
    });
    if (S.detail !== d || d.tab !== 'terminal' || d.term !== st || st.startToken !== startToken || st.status !== 'connecting') {
      api(`/shells/${encodeURIComponent(data.sessionId)}/close`, { method: 'POST' }).catch(() => {});
      return;
    }
    st.sessionId = data.sessionId;
    st.tty = !!data.tty;
    st.status = 'running';
    paintTerminalState(d);
    st.xterm.fit();
    resizeTerminalSession(st, st.xterm.term.cols, st.xterm.term.rows);
    st.xterm.focus();
    const es = new EventSource(withToken(`/api/shells/${encodeURIComponent(data.sessionId)}/stream`));
    st.es = es;
    es.onmessage = (event) => {
      if (S.detail !== d || d.term !== st || st.startToken !== startToken || st.es !== es) return;
      let payload;
      try { payload = JSON.parse(event.data); } catch (_) { return; }
      if (S.detail !== d || d.term !== st) return;
      if (payload.type === 'snapshot') {
        if (payload.session) {
          st.tty = !!payload.session.tty;
          st.status = payload.session.status === 'running' ? 'running' : 'closed';
          st.exitCode = payload.session.exitCode;
        }
        st.xterm.reset();
        if (payload.output) st.xterm.write(payload.output);
        paintTerminalState(d);
        if (st.status !== 'running') {
          try { es.close(); } catch (_) { /* ignore */ }
          st.es = null;
        }
      } else if (payload.type === 'output') {
        st.xterm.write(payload.data || '');
      } else if (payload.type === 'error') {
        st.xterm.write(`\r\n[终端错误] ${payload.message || '连接异常'}\r\n`);
        paintTerminalState(d);
      } else if (payload.type === 'exit') {
        st.status = 'closed';
        st.exitCode = payload.code;
        st.xterm.write(`\r\n[终端已结束${payload.code === null || payload.code === undefined ? '' : '，退出码 ' + payload.code}]\r\n`);
        try { es.close(); } catch (_) { /* ignore */ }
        st.es = null;
        paintTerminalState(d);
      }
    };
    es.onerror = () => {
      if (S.detail !== d || d.term !== st || st.startToken !== startToken || st.es !== es) return;
      if (st.status !== 'running') return;
      st.status = 'error';
      st.xterm.write('\r\n[终端连接中断]\r\n');
      try { es.close(); } catch (_) { /* ignore */ }
      st.es = null;
      paintTerminalState(d);
    };
  } catch (err) {
    if (S.detail !== d || d.tab !== 'terminal' || d.term !== st || st.startToken !== startToken || st.status !== 'connecting') return;
    st.status = 'error';
    if (st.xterm) st.xterm.write(`\r\n${errorText(err)}\r\n`);
    paintTerminalState(d);
  }
}

function renderTerminalTab(body) {
  const d = S.detail;
  const item = d.item || {};
  const containers = (item.containers || []).map((c) => c.name).filter(Boolean);
  const old = d.term;
  const preferred = old && containers.includes(old.container) ? old.container : (containers[0] || '');
  if (old) closeTerminal(d, '', true);
  d.term = {
    container: preferred,
    sessionId: null,
    es: null,
    tty: true,
    status: 'idle',
    xterm: null,
    inputQueue: Promise.resolve(),
    startToken: 0
  };

  if (!containers.length) {
    body.innerHTML = `<div class="empty"><p>该 Pod 没有可用的容器列表，无法打开终端。</p></div>`;
    return;
  }

  const ptyHint = activeHost() && activeHost().transport === 'ssh'
    ? '直接在终端中键入；支持 <span class="code-inline">vim</span>、<span class="code-inline">top</span>、<span class="code-inline">tmux</span> 等全屏程序；依赖容器内存在 <span class="code-inline">sh</span>。'
    : '直接在终端中键入；本地 kubeconfig 模式没有 PTY，全屏程序可能无法正常交互；依赖容器内存在 <span class="code-inline">sh</span>。';
  body.innerHTML = `
    <div class="row" style="margin-bottom:10px;flex-wrap:wrap;gap:8px">
      <span class="tiny dim">容器</span>
      <select class="select" id="termContainer" style="width:190px">
        ${containers.map((c) => `<option value="${esc(c)}" ${c === preferred ? 'selected' : ''}>${esc(c)}</option>`).join('')}
      </select>
      <span id="termBadge">${terminalStatus(d.term)}</span>
      <span class="spacer"></span>
      <button class="btn sm" id="termReconnect">${icon('refresh')} 重连</button>
      <button class="btn sm ghost" id="termClose">断开</button>
    </div>
    <div class="alert info" style="margin-bottom:10px">
      <div>命令直接在该容器内执行，使用容器自身的用户和文件系统；支持 <span class="code-inline">cd</span>、环境变量等会话状态。退出请执行 <span class="code-inline">exit</span>。</div>
    </div>
    <div class="xterm-shell" id="termOutput"></div>
    <div class="tiny dim" style="margin-top:8px">${ptyHint}</div>`;

  try {
    d.term.xterm = createTerminalView($('#termOutput', body), {
      onData: (data) => queueTerminalInput(d.term, data),
      onResize: (cols, rows) => resizeTerminalSession(d.term, cols, rows)
    });
  } catch (err) {
    $('#termOutput', body).innerHTML = `<div class="alert danger" style="margin:12px">终端初始化失败：${esc(errorText(err))}</div>`;
    return;
  }

  $('#termContainer', body).addEventListener('change', (e) => {
    closeTerminal(d);
    startTerminal(d, e.target.value);
  });
  $('#termReconnect', body).addEventListener('click', () => startTerminal(d, d.term.container));
  $('#termClose', body).addEventListener('click', () => closeTerminal(d, '[已手动断开]'));
  d.term.xterm.focus();
  startTerminal(d, preferred);
}

async function renderEventsTab(body) {  const d = S.detail;
  body.innerHTML = '<div class="empty"><span class="spinner"></span><p style="margin-top:10px">读取事件…</p></div>';
  try {
    const q = new URLSearchParams({ namespace: d.namespace, name: d.name });
    const data = await api(`/hosts/${encodeURIComponent(activeHost().id)}/events?${q.toString()}`);
    if (S.detail !== d || d.tab !== 'events') return;
    const items = data.items || [];
    if (!items.length) { body.innerHTML = '<div class="empty"><p>暂无相关事件</p></div>'; return; }
    body.innerHTML = `<div class="table-wrap" style="border:none"><table class="data">
      <thead><tr><th>类型</th><th>原因</th><th>消息</th><th class="right">次数</th><th>时间</th></tr></thead>
      <tbody>${items.map((e) => `<tr style="cursor:default">
        <td>${statusBadge(e.type)}</td><td>${esc(e.reason)}</td>
        <td><div style="max-width:320px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(e.message)}">${esc(e.message)}</div></td>
        <td class="right mono">${esc(e.count)}</td><td class="mono">${esc(age(e.lastSeen))}前</td>
      </tr>`).join('')}</tbody></table></div>`;
  } catch (err) {
    body.innerHTML = `<div class="alert err">${icon('alert')}<div>${esc(errorText(err))}</div></div>`;
  }
}

async function renderDescribeTab(body) {
  const d = S.detail;
  body.innerHTML = '<div class="empty"><span class="spinner"></span><p style="margin-top:10px">读取详情…</p></div>';
  try {
    const q = new URLSearchParams({ kind: d.kind, namespace: d.namespace, name: d.name });
    const data = await api(`/hosts/${encodeURIComponent(activeHost().id)}/describe?${q.toString()}`);
    if (S.detail !== d || d.tab !== 'describe') return;
    body.innerHTML = `<div class="row" style="margin-bottom:8px"><span class="tiny dim">kubectl describe</span><span class="spacer"></span><button class="btn sm" id="descCopy">${icon('copy')} 复制</button></div>
      <div class="logbox" style="white-space:pre">${esc(data.text)}</div>`;
    $('#descCopy', body).addEventListener('click', () => copyText(data.text));
  } catch (err) {
    body.innerHTML = `<div class="alert err">${icon('alert')}<div>${esc(errorText(err))}</div></div>`;
  }
}

function downloadText(filename, text) {
  const blob = new Blob([text || ''], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function drawerScale() {
  const d = S.detail;
  if (!d) return;
  const item = d.item || {};
  const current = item.desired !== undefined ? item.desired : Number(String(item.replicas || '').split('/')[0]) || 1;
  openModal({
    title: `扩缩容 · ${d.name}`,
    size: 'narrow',
    body: `<label class="field">副本数
        <input class="input" id="scaleInput" type="number" min="0" max="10000" value="${esc(current)}" />
        <span class="help">当前期望副本：${esc(current)}。缩容到 0 会停止所有 Pod。</span>
      </label>`,
    foot: `<button class="btn ghost" data-close="1">取消</button><button class="btn primary" id="scaleSave">应用</button>`,
    onMount(m) {
      const input = $('#scaleInput', m.el);
      setTimeout(() => { input.focus(); input.select(); }, 60);
      $('#scaleSave', m.el).addEventListener('click', async () => {
        const replicas = Number(input.value);
        if (!Number.isInteger(replicas) || replicas < 0) { toast('请输入合法的副本数', 'error'); return; }
        try {
          const data = await api(`/hosts/${encodeURIComponent(activeHost().id)}/scale`, { method: 'POST', body: { kind: d.kind, namespace: d.namespace, name: d.name, replicas } });
          closeModal();
          toast(truncate(data.output || '已更新副本数', 200), 'success');
          loadWorkloads(true);
        } catch (err) {
          toast(errorText(err), 'error');
        }
      });
    }
  });
}

async function drawerRestartPod() {
  const d = S.detail;
  if (!d || d.kind !== 'pods') return;
  const owner = d.item && d.item.owner && d.item.owner !== '-' ? d.item.owner : '';
  const ok = await confirmDialog({
    title: owner ? '重启 Pod' : '删除裸 Pod',
    message: owner
      ? `将删除 Pod <b>${esc(d.name)}</b>（由 <b>${esc(owner)}</b> 管理），控制器会重新创建一个 Pod。原 Pod 内未持久化数据会丢失。`
      : `Pod <b>${esc(d.name)}</b> 没有控制器管理，删除后不会自动重建，服务会直接消失。此操作不可撤销。`,
    confirmText: owner ? '删除并重启' : '删除 Pod',
    danger: true
  });
  if (!ok) return;
  try {
    const q = new URLSearchParams({ kind: d.kind, namespace: d.namespace, name: d.name });
    await api(`/hosts/${encodeURIComponent(activeHost().id)}/resource?${q.toString()}`, { method: 'DELETE' });
    closeDrawer();
    toast(owner ? 'Pod 已删除，等待控制器重建' : '裸 Pod 已删除', 'success');
    loadWorkloads(true);
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

async function drawerRestart() {
  const d = S.detail;
  if (!d) return;
  const ok = await confirmDialog({
    title: '重启资源',
    message: `对 <b>${esc(d.name)}</b> 执行滚动重启？Pod 会依次重建。`,
    confirmText: '重启'
  });
  if (!ok) return;
  try {
    const data = await api(`/hosts/${encodeURIComponent(activeHost().id)}/restart`, { method: 'POST', body: { kind: d.kind, namespace: d.namespace, name: d.name } });
    toast(truncate(data.output || '已触发重启', 200), 'success');
    loadWorkloads(true);
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

async function drawerDelete() {
  const d = S.detail;
  if (!d) return;
  const ok = await confirmDialog({
    title: '删除资源',
    message: `即将删除 <b>${esc(d.name)}</b>（${esc(d.namespace || '集群级')}）。该操作不可撤销。`,
    confirmText: '删除',
    danger: true
  });
  if (!ok) return;
  try {
    const q = new URLSearchParams({ kind: d.kind, namespace: d.namespace, name: d.name });
    const data = await api(`/hosts/${encodeURIComponent(activeHost().id)}/resource?${q.toString()}`, { method: 'DELETE' });
    closeDrawer();
    toast(truncate(data.output || '已删除', 200), 'success');
    loadWorkloads(true);
  } catch (err) {
    toast(errorText(err), 'error');
  }
}
