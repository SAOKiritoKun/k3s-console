'use strict';

/* ============================================================
 * 服务器表单
 * ============================================================ */
function openHostForm(host = null, opts = {}) {
  const isCopy = !!opts.copy;
  const isEdit = !!host && !isCopy;
  const h = host || {
    id: '', name: '', group: '', transport: 'ssh', host: '', port: 22, user: 'root',
    auth: { type: 'password', password: '' }, role: 'server', useSudo: false,
    kubeconfig: '', kubectlPath: '', notes: ''
  };
  const authType = (h.auth && h.auth.type) || 'password';
  // 分组是必选项：只能从后端返回的已有分组里选，不允许在表单里新建。
  // 新建时默认选中「默认分组」，编辑 / 复制时沿用原分组（原分组不存在则回落到默认分组）。
  const allGroups = hostGroupNames();
  const fallbackGroup = defaultGroupName();
  const rawGroup = String(h.group || '').trim();
  const currentGroup = allGroups.includes(rawGroup) ? rawGroup : fallbackGroup;
  const body = `
    <div class="form-grid">
      <label class="field"><span class="field-label">名称 <span class="req">*</span></span>
        <input class="input" id="hf-name" value="${esc(h.name)}" placeholder="例如：生产主节点" />
      </label>
      <label class="field"><span class="field-label">所属分组 <span class="req">*</span></span>
        <select class="select" id="hf-group">
          ${allGroups.map((g) => `<option value="${esc(g)}" ${g === currentGroup ? 'selected' : ''}>${esc(g)}（${hostGroupCount(g)} 台）</option>`).join('')}
        </select>
        <span class="help">服务器必须挂在已有分组下；需要新分组请先在左栏「新增分组」。</span>
      </label>
      <label class="field"><span class="field-label">接入方式</span>
        <select class="select" id="hf-transport">
          <option value="ssh" ${h.transport === 'ssh' ? 'selected' : ''}>SSH 远程连接</option>
          <option value="local" ${h.transport === 'local' ? 'selected' : ''}${isLinuxHost() ? '' : ' disabled'}>本地（仅 Linux 控制端）</option>
          <option value="kubeconfig" ${h.transport === 'kubeconfig' ? 'selected' : ''}>kubeconfig（仅纳管，不可安装）</option>
        </select>
        <span class="help hidden" id="hf-local-hint"></span>
      </label>
      <div class="full" id="hf-ssh-fields">
        <div class="form-grid">
          <label class="field"><span class="field-label">主机地址 / IP <span class="req">*</span></span>
            <input class="input" id="hf-host" value="${esc(h.host)}" placeholder="192.168.1.10 或 node.example.com" />
          </label>
          <label class="field"><span class="field-label">SSH 端口</span>
            <input class="input" id="hf-port" type="number" value="${esc(h.port || 22)}" />
          </label>
          <label class="field"><span class="field-label">用户名</span>
            <input class="input" id="hf-user" value="${esc(h.user || 'root')}" />
          </label>
          <label class="field"><span class="field-label">认证方式</span>
            <select class="select" id="hf-auth">
              <option value="password" ${authType === 'password' ? 'selected' : ''}>密码</option>
              <option value="key" ${authType === 'key' ? 'selected' : ''}>私钥文件</option>
              <option value="agent" ${authType === 'agent' ? 'selected' : ''}>SSH Agent</option>
            </select>
          </label>
          <label class="field full" id="hf-password-wrap"><span class="field-label">密码 ${isEdit && h.auth && h.auth.password ? '<span class="dim">（留空表示不修改）</span>' : ''}</span>
            <div class="password-field">
              <input class="input" id="hf-password" type="password" autocomplete="new-password" value="${isCopy ? esc((h.auth && h.auth.password) || '') : ''}" placeholder="${isEdit ? '不修改请留空；点击眼睛查看已保存密码' : 'SSH 密码'}" />
              <button type="button" class="password-eye" id="hf-password-eye" aria-label="显示密码" title="显示密码" aria-pressed="false">${icon('eye')}</button>
            </div>
          </label>
          <label class="field full hidden" id="hf-key-wrap"><span class="field-label">私钥路径（控制端）</span>
            <input class="input" id="hf-key" value="${esc((h.auth && h.auth.privateKeyPath) || '')}" placeholder="~/.ssh/id_ed25519（留空则使用 config.json 默认密钥）" />
          </label>
        </div>
      </div>
      <label class="field full hidden" id="hf-sudo-wrap">
        <span class="check"><input type="checkbox" id="hf-sudo" ${h.useSudo ? 'checked' : ''} /> 使用 sudo 执行需要特权的命令（非 root 用户建议开启）</span>
      </label>
      <div class="full hidden" id="hf-kubeconfig-fields">
        <div class="form-grid">
          <label class="field full"><span class="field-label">kubeconfig 文件路径（控制端）<span class="req">*</span></span>
            <input class="input" id="hf-kubeconfig" value="${esc(h.kubeconfig || '')}" placeholder="C:\\Users\\me\\.kube\\config 或 ~/.kube/config" />
          </label>
          <label class="field"><span class="field-label">kubectl 路径（可选）</span>
            <input class="input" id="hf-kubectl" value="${esc(h.kubectlPath || '')}" placeholder="默认从 PATH 查找" />
          </label>
          <label class="field"><span class="field-label">Context（可选）</span>
            <input class="input" id="hf-context" value="${esc(h.context || '')}" placeholder="kubeconfig 中的 context 名称" />
          </label>
        </div>
      </div>
      <label class="field full"><span class="field-label">备注</span>
        <input class="input" id="hf-notes" value="${esc(h.notes || '')}" placeholder="可选" />
      </label>
      ${!isEdit ? '<div class="full"><div class="tiny dim">保存后会自动读取该服务器的连通性与 Kubernetes 状态。</div></div>' : ''}
    </div>`;

  const modal = openModal({
    title: isCopy ? '复制服务器' : isEdit ? '编辑服务器' : '添加服务器',
    size: 'wide',
    body,
    foot: `<button class="btn ghost" data-close="1">取消</button><button class="btn primary" id="hf-save">${isCopy ? '复制并读取' : isEdit ? '保存修改' : '添加并读取'}</button>`,
    onMount(m) {
      const transport = $('#hf-transport', m.el);
      const auth = $('#hf-auth', m.el);
      const pwdInput = $('#hf-password', m.el);
      const pwdEye = $('#hf-password-eye', m.el);
      const setPwdVisible = (visible) => {
        pwdInput.type = visible ? 'text' : 'password';
        pwdEye.setAttribute('aria-pressed', visible ? 'true' : 'false');
        pwdEye.setAttribute('aria-label', visible ? '隐藏密码' : '显示密码');
        pwdEye.title = visible ? '隐藏密码' : '显示密码';
        pwdEye.innerHTML = icon(visible ? 'eye-off' : 'eye');
      };
      let pwdLoading = false;
      pwdEye.addEventListener('click', async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (pwdLoading) return;
        const willShow = pwdInput.type === 'password';
        if (willShow && !pwdInput.value && isEdit && h.auth && h.auth.password) {
          pwdLoading = true;
          pwdEye.disabled = true;
          try {
            const data = await api(`/hosts/${encodeURIComponent(h.id)}/password`);
            if (data && data.password) pwdInput.value = data.password;
            setPwdVisible(true);
          } catch (err) {
            toast(errorText(err), 'error');
          } finally {
            pwdLoading = false;
            pwdEye.disabled = false;
          }
          return;
        }
        setPwdVisible(willShow);
      });
      const sync = () => {
        const isKube = transport.value === 'kubeconfig';
        const isLocal = transport.value === 'local';
        // 本地接入 = 控制端即节点：不需要地址和 SSH 凭据，只保留 sudo
        $('#hf-ssh-fields', m.el).classList.toggle('hidden', isKube || isLocal);
        $('#hf-kubeconfig-fields', m.el).classList.toggle('hidden', !isKube);
        $('#hf-sudo-wrap', m.el).classList.toggle('hidden', isKube);
        const blockReason = isLocal ? localTransportBlockReason() : '';
        const hint = $('#hf-local-hint', m.el);
        hint.textContent = blockReason || '命令直接在当前这台机器上执行，不用填写地址和 SSH 凭据。';
        hint.classList.toggle('hidden', !isLocal);
        // 非 Linux 控制端不能充当 k3s 节点，禁止提交；已存在的本地主机仍允许保存，方便改回其他接入方式。
        const localBlocked = !!blockReason && !(isEdit && h.transport === 'local');
        const saveBtn = $('#hf-save', m.el);
        saveBtn.disabled = localBlocked;
        saveBtn.title = localBlocked ? blockReason : '';
      };
      transport.addEventListener('change', sync);
      const syncAuth = () => {
        const type = auth.value;
        if (type !== 'password') setPwdVisible(false);
        $('#hf-password-wrap', m.el).classList.toggle('hidden', type !== 'password');
        $('#hf-key-wrap', m.el).classList.toggle('hidden', type !== 'key');
      };
      auth.addEventListener('change', syncAuth);
      sync();
      syncAuth();
      $('#hf-save', m.el).addEventListener('click', async () => {
        const name = $('#hf-name', m.el).value.trim();
        const t = transport.value;
        const group = $('#hf-group', m.el).value;
        const payload = {
          id: isEdit ? h.id : undefined,
          name,
          group,
          transport: t,
          useSudo: $('#hf-sudo', m.el).checked,
          notes: $('#hf-notes', m.el).value.trim()
        };
        if (t === 'ssh') {
          payload.host = $('#hf-host', m.el).value.trim();
          payload.port = Number($('#hf-port', m.el).value) || 22;
          payload.user = $('#hf-user', m.el).value.trim() || 'root';
          const type = auth.value;
          payload.auth = { type };
          const pwd = $('#hf-password', m.el).value;
          if (type === 'password' && pwd) payload.auth.password = pwd;
          if (type === 'key') payload.auth.privateKeyPath = $('#hf-key', m.el).value.trim();
          if (!name || !payload.host) { toast('请填写名称和主机地址', 'error'); return; }
          if (type === 'password' && !pwd && !isEdit) { toast('请填写 SSH 密码，或改用私钥认证', 'error'); return; }
        } else if (t === 'kubeconfig') {
          payload.kubeconfig = $('#hf-kubeconfig', m.el).value.trim();
          payload.kubectlPath = $('#hf-kubectl', m.el).value.trim();
          payload.context = $('#hf-context', m.el).value.trim();
          if (!name || !payload.kubeconfig) { toast('请填写名称和 kubeconfig 路径', 'error'); return; }
        } else {
          // 本地接入 = 控制端即节点；只有 Linux 控制端能当 k3s 节点（已存在的本地主机允许保留以便改回）
          if (t === 'local' && !isLinuxHost() && !(isEdit && h.transport === 'local')) {
            toast(localTransportBlockReason(), 'error');
            return;
          }
          if (!name) { toast('请填写名称', 'error'); return; }
          if (!payload.user) payload.user = 'root';
        }
        const btn = $('#hf-save', m.el);
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> 保存中';
        try {
          if (isEdit) {
            await api(`/hosts/${encodeURIComponent(h.id)}`, { method: 'PUT', body: { host: payload } });
          } else {
            await api('/hosts', { method: 'POST', body: { host: payload } });
          }
          closeModal();
          // 新增时记住添加前的 id 列表，只让新服务器进入「读取中」
          const before = new Set(S.hosts.map((x) => x.id));
          await loadHosts();
          renderView();
          toast(isCopy ? '服务器已复制' : isEdit ? '服务器已更新' : '服务器已添加', 'success');
          if (isEdit) {
            detectAll(true, h.id);
          } else {
            const addedIds = S.hosts.filter((x) => !before.has(x.id)).map((x) => x.id);
            if (addedIds.length) detectAll(true, addedIds);
          }
        } catch (err) {
          toast(errorText(err), 'error');
          btn.disabled = false;
          btn.textContent = isCopy ? '复制并读取' : isEdit ? '保存修改' : '添加并读取';
        }
      });
    }
  });
  setTimeout(() => { const input = $('#hf-name', modal.el); if (input) input.focus(); }, 80);
}

/* ============================================================
 * 服务器 SSH 远程终端
 * ============================================================ */

function hostShellBadge(st) {
  if (st.status === 'connecting') return badge('连接中', 'info');
  if (st.status === 'running') return badge('已连接', 'ok');
  if (st.status === 'error') return badge('连接失败', 'err');
  return badge('已断开', 'neutral');
}

function paintHostShell(st) {
  if (!st || !st.el || !document.body.contains(st.el)) return;
  const status = $('#hostTermBadge', st.el);
  if (status) status.innerHTML = hostShellBadge(st);
  const reconnect = $('#hostTermReconnect', st.el);
  if (reconnect) reconnect.disabled = st.status === 'connecting';
}

function releaseHostShellSession(st) {
  if (!st) return null;
  if (st.es) {
    try { st.es.close(); } catch (_) { /* ignore */ }
    st.es = null;
  }
  const sessionId = st.sessionId;
  st.sessionId = null;
  st.inputQueue = Promise.resolve();
  if (sessionId) api(`/shells/${encodeURIComponent(sessionId)}/close`, { method: 'POST' }).catch(() => {});
  return sessionId;
}

function sendHostShellClose(sessionId) {
  if (!sessionId) return;
  const headers = {};
  if (token()) headers['X-Access-Token'] = token();
  try {
    fetch(`/api/shells/${encodeURIComponent(sessionId)}/close`, {
      method: 'POST',
      headers,
      keepalive: true
    }).catch(() => {});
  } catch (_) { /* ignore */ }
}

// 页面刷新/关闭时普通 fetch 可能被浏览器中断；用 keepalive 请求立即释放远端 PTY。
function releaseHostShellSessionOnUnload(st) {
  if (!st) return;
  stopHostShellCwdSync(st);
  if (st.es) {
    try { st.es.close(); } catch (_) { /* ignore */ }
    st.es = null;
  }
  const sessionId = st.sessionId;
  st.sessionId = null;
  sendHostShellClose(sessionId);
}

// 页内「关闭窗口」按钮：先送达关闭请求，再关闭窗口；window.close 失效时退回空白页。
function closeHostShellWindow(st) {
  if (!st || st.closed) return;
  st.closed = true;
  stopHostShellCwdSync(st);
  if (st.es) {
    try { st.es.close(); } catch (_) { /* ignore */ }
    st.es = null;
  }
  const sessionId = st.sessionId;
  st.sessionId = null;
  sendHostShellClose(sessionId);
  try { window.close(); } catch (_) { /* ignore */ }
  setTimeout(() => {
    try {
      if (!window.closed) window.location.replace('about:blank');
    } catch (_) { /* ignore */ }
  }, 250);
}

function stopHostShell(st, message = '') {
  if (!st) return;
  st.startToken = (st.startToken || 0) + 1;
  stopHostShellCwdSync(st);
  releaseHostShellSession(st);
  if (message && st.xterm) st.xterm.write(`\r\n${message}\r\n`);
  if (st.status === 'running' || st.status === 'connecting') st.status = 'closed';
  paintHostShell(st);
}

async function startHostShell(st) {
  if (!st || st.closed || !st.xterm) return;
  const host = st.host;
  const token = (st.startToken || 0) + 1;
  st.startToken = token;
  stopHostShellCwdSync(st);
  st.lastCwd = '';
  releaseHostShellSession(st);
  st.status = 'connecting';
  st.tty = true;
  st.inputQueue = Promise.resolve();
  st.xterm.reset();
  st.xterm.write('正在建立 SSH 连接…\r\n');
  paintHostShell(st);

  if (DEMO) {
    st.status = 'closed';
    st.xterm.write('演示模式不会真正建立 SSH 连接。连接真实服务器后，可以在这里以 SSH 客户端身份操作主机。\r\n');
    paintHostShell(st);
    return;
  }

  try {
    const data = await api(`/hosts/${encodeURIComponent(host.id)}/ssh-shell`, { method: 'POST' });
    if (st.closed || st.startToken !== token) {
      if (data && data.sessionId) api(`/shells/${encodeURIComponent(data.sessionId)}/close`, { method: 'POST' }).catch(() => {});
      return;
    }
    st.sessionId = data.sessionId;
    st.tty = !!data.tty;
    st.status = 'running';
    paintHostShell(st);
    st.xterm.fit();
    resizeTerminalSession(st, st.xterm.term.cols, st.xterm.term.rows);
    st.xterm.focus();
    startHostShellCwdSync(st);

    const es = new EventSource(withToken(`/api/shells/${encodeURIComponent(data.sessionId)}/stream`));
    st.es = es;
    es.onmessage = (event) => {
      if (st.closed || st.es !== es || st.startToken !== token) return;
      let payload;
      try { payload = JSON.parse(event.data); } catch (_) { return; }
      if (payload.type === 'snapshot') {
        if (payload.session) {
          st.tty = !!payload.session.tty;
          st.status = payload.session.status === 'running' ? 'running' : 'closed';
          st.exitCode = payload.session.exitCode;
        }
        st.xterm.reset();
        if (payload.output) st.xterm.write(payload.output);
        paintHostShell(st);
        if (st.status !== 'running') {
          stopHostShellCwdSync(st);
          try { es.close(); } catch (_) { /* ignore */ }
          st.es = null;
        }
      } else if (payload.type === 'output') {
        st.xterm.write(payload.data || '');
      } else if (payload.type === 'error') {
        st.xterm.write(`\r\n[终端错误] ${payload.message || '连接异常'}\r\n`);
        paintHostShell(st);
      } else if (payload.type === 'exit') {
        st.status = 'closed';
        st.exitCode = payload.code;
        stopHostShellCwdSync(st);
        st.xterm.write(`\r\n[连接已断开${payload.code === null || payload.code === undefined ? '' : '，退出码 ' + payload.code}]\r\n`);
        try { es.close(); } catch (_) { /* ignore */ }
        st.es = null;
        paintHostShell(st);
      }
    };
    es.onerror = () => {
      if (st.closed || st.es !== es || st.startToken !== token) return;
      if (st.status !== 'running') return;
      st.status = 'error';
      stopHostShellCwdSync(st);
      st.xterm.write('\r\n[SSH 连接中断]\r\n');
      try { es.close(); } catch (_) { /* ignore */ }
      st.es = null;
      paintHostShell(st);
    };
  } catch (err) {
    if (st.closed || st.startToken !== token) return;
    st.status = 'error';
    stopHostShellCwdSync(st);
    if (st.xterm) st.xterm.write(`\r\n${errorText(err)}\r\n`);
    paintHostShell(st);
  }
}

function stopHostShellCwdSync(st) {
  if (!st) return;
  if (st.cwdTimer) {
    clearInterval(st.cwdTimer);
    st.cwdTimer = null;
  }
}

function startHostShellCwdSync(st) {
  stopHostShellCwdSync(st);
  if (!st || st.closed || !st.syncCwd || st.status !== 'running' || !st.sessionId || !st.sftp) return;
  // 面板通常已经按主目录加载过；若终端也在同一目录，不必重复请求一次。
  if (!st.lastCwd) st.lastCwd = st.sftp.currentPath() || '';
  const tick = async () => {
    if (!st || st.closed || !st.syncCwd || st.status !== 'running' || !st.sessionId || !st.sftp) {
      stopHostShellCwdSync(st);
      return;
    }
    // 初次打开时面板可能仍在读取主目录，等它完成后再比较，避免重复请求。
    if (st.sftp.state && st.sftp.state.loading) return;
    if (!st.lastCwd) st.lastCwd = st.sftp.currentPath() || '';
    if (st.cwdPolling) return;
    st.cwdPolling = true;
    const sessionId = st.sessionId;
    try {
      const data = await api(`/shells/${encodeURIComponent(sessionId)}/cwd`);
      if (!st || st.closed || !st.syncCwd || st.status !== 'running' || st.sessionId !== sessionId) return;
      const cwd = String((data && data.cwd) || '');
      if (cwd && cwd !== st.lastCwd) {
        st.lastCwd = cwd;
        st.sftp.load(cwd);
      }
    } catch (_) {
      // 终端可能正忙或已结束；下一轮继续尝试，不打扰用户。
    } finally {
      st.cwdPolling = false;
    }
  };
  st.cwdTimer = setInterval(tick, 1000);
  tick();
}

function setHostShellCwdSync(st, enabled) {
  if (!st) return;
  st.syncCwd = !!enabled;
  if (!st.syncCwd) {
    stopHostShellCwdSync(st);
    return;
  }
  st.lastCwd = '';
  startHostShellCwdSync(st);
}

function createHostShellState(host) {
  return {
    host,
    el: null,
    sessionId: null,
    es: null,
    status: 'connecting',
    tty: true,
    xterm: null,
    sftp: null,
    inputQueue: Promise.resolve(),
    startToken: 0,
    closed: false,
    syncCwd: true,
    lastCwd: '',
    cwdTimer: null,
    cwdPolling: false
  };
}

function hostShellWindowHTML(host) {
  return `<div class="remote-window">
    <div class="remote-window-head">
      <div class="remote-window-heading">
        <div class="remote-window-title">${icon('terminal')} 远程连接 · ${esc(hostName(host))}</div>
        <div class="remote-window-sub">${esc(hostAddress(host))} · 关闭窗口会自动断开 SSH</div>
      </div>
      <div class="remote-window-actions">
        <button type="button" class="btn sm btn-icon" id="hostTermFullscreen" title="进入全屏" aria-label="进入全屏" aria-pressed="false">${icon('expand')}</button>
        <button type="button" class="btn sm btn-icon" id="hostTermReconnect" title="重新连接 SSH" aria-label="重新连接 SSH">${icon('refresh')}</button>
        <button type="button" class="btn sm btn-icon" id="hostTermClose" title="关闭窗口并结束本次 SSH 会话" aria-label="关闭窗口并结束本次 SSH 会话">${icon('x')}</button>
      </div>
    </div>
    <div class="remote-shell-grid">
      <section class="remote-pane remote-terminal-pane">
        <div class="remote-pane-head">
          <span class="remote-pane-title">${icon('terminal')} SSH 终端</span>
          <span id="hostTermBadge">${hostShellBadge({ status: 'connecting' })}</span>
          <span class="spacer"></span>
        </div>
        <div class="xterm-shell" id="hostTermOutput"></div>
        <div class="tiny muted remote-term-tip">支持 <span class="code-inline">vim</span>、<span class="code-inline">top</span>、<span class="code-inline">tmux</span> 等全屏程序</div>
      </section>
      <section class="remote-pane remote-sftp-pane">
        <div class="remote-pane-head">
          <span class="remote-pane-title">${icon('folder')} SFTP 文件</span>
          <button type="button" class="sftp-sync" id="hostSftpSync" role="switch" aria-checked="true" title="终端执行 cd 时，文件列表自动切换到同一目录">
            <span class="sftp-sync-track"><span class="sftp-sync-thumb"></span></span>
            <span>跟随终端目录</span>
          </button>
        </div>
        <div class="remote-sftp-body" id="hostSftpPanel"></div>
      </section>
    </div>
  </div>`;
}

function mountHostShell(st, root) {
  st.el = root;
  try {
    st.xterm = createTerminalView($('#hostTermOutput', root), {
      onData: (data) => queueTerminalInput(st, data),
      onResize: (cols, rows) => resizeTerminalSession(st, cols, rows)
    });
  } catch (err) {
    toast(`终端初始化失败：${errorText(err)}`, 'error');
    st.status = 'error';
    paintHostShell(st);
    return;
  }
  try {
    st.sftp = createSftpPanel(st.host, $('#hostSftpPanel', root), { compact: true, dropRoot: root });
  } catch (err) {
    toast(`SFTP 面板初始化失败：${errorText(err)}`, 'error');
  }
  const syncBtn = $('#hostSftpSync', root);
  if (syncBtn) {
    syncBtn.addEventListener('click', () => {
      const next = syncBtn.getAttribute('aria-checked') !== 'true';
      syncBtn.setAttribute('aria-checked', String(next));
      setHostShellCwdSync(st, next);
    });
  }
  const closeBtn = $('#hostTermClose', root);
  if (closeBtn) closeBtn.addEventListener('click', () => closeHostShellWindow(st));
  const fullscreenBtn = $('#hostTermFullscreen', root);
  const syncFullscreenButton = () => {
    if (!fullscreenBtn) return;
    const active = !!document.fullscreenElement;
    const label = active ? '退出全屏' : '进入全屏';
    fullscreenBtn.setAttribute('aria-pressed', String(active));
    fullscreenBtn.title = label;
    fullscreenBtn.setAttribute('aria-label', label);
    const use = fullscreenBtn.querySelector('use');
    if (use) use.setAttribute('href', active ? '#i-compress' : '#i-expand');
  };
  if (fullscreenBtn) {
    fullscreenBtn.addEventListener('click', async () => {
      try {
        if (document.fullscreenElement) {
          await document.exitFullscreen();
        } else {
          const request = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
          if (!request) throw new Error('fullscreen unsupported');
          await request.call(document.documentElement);
        }
      } catch (_) {
        toast('浏览器未允许全屏，可按 F11 切换', 'error');
      }
    });
  }
  document.addEventListener('fullscreenchange', syncFullscreenButton);
  syncFullscreenButton();
  paintHostShell(st);
  const reconnect = $('#hostTermReconnect', root);
  if (reconnect) reconnect.addEventListener('click', () => startHostShell(st));
  st.xterm.focus();
  startHostShell(st);
}

function openHostShell(host) {
  if (!host) return;
  if ((host.transport || 'ssh') !== 'ssh') {
    toast('只有 SSH 接入方式支持远程连接', 'error');
    return;
  }
  const availWidth = Math.round((window.screen && screen.availWidth) || 1440);
  const availHeight = Math.round((window.screen && screen.availHeight) || 900);
  // 默认铺满可用桌面区域；浏览器不允许脚本直接进入 F11 全屏，真正的全屏由窗口内按钮触发。
  const width = Math.max(720, availWidth);
  const height = Math.max(560, availHeight);
  const left = Math.max(0, Math.round((window.screen && screen.availLeft) || 0));
  const top = Math.max(0, Math.round((window.screen && screen.availTop) || 0));
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('remote', host.id);
  const features = `popup=yes,width=${width},height=${height},left=${left},top=${top},resizable=yes,scrollbars=yes,fullscreen=yes`;
  const win = window.open('', `k8s-remote-${host.id}`, features);
  if (!win) {
    toast('浏览器拦截了远程连接窗口，请允许本站弹出窗口后重试', 'error', 5200);
    return;
  }
  try {
    if (token()) win.sessionStorage.setItem(TOKEN_KEY, token());
  } catch (_) { /* ignore */ }
  try {
    win.location.href = url.toString();
  } catch (_) { /* ignore */ }
  try { win.focus(); } catch (_) { /* ignore */ }
}

function requestHostShellFullscreen() {
  if (document.fullscreenElement || !document.fullscreenEnabled) return;
  const request = document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen;
  if (!request) return;
  try {
    const result = request.call(document.documentElement);
    if (result && typeof result.catch === 'function') result.catch(() => { /* 浏览器要求用户手势时静默回退到最大化 */ });
  } catch (_) { /* ignore */ }
}

function initDetachedHostShell(host) {
  document.body.classList.add('remote-detached');
  document.title = `远程连接 · ${hostName(host)}`;
  const st = createHostShellState(host);
  const root = $('#view');
  root.innerHTML = hostShellWindowHTML(host);
  const handlePageHide = (event) => {
    if (event.persisted) return;
    st.closed = true;
    releaseHostShellSessionOnUnload(st);
  };
  // 页内关闭按钮、右上角原生关闭和刷新都会释放 SSH 会话。
  window.addEventListener('beforeunload', handlePageHide);
  window.addEventListener('pagehide', handlePageHide);
  mountHostShell(st, root);
  requestHostShellFullscreen();
}

/* ============================================================
 * 预检 / 安装
 * ============================================================ */
async function openPreflight(host) {
  const modal = openModal({
    title: `环境预检 · ${hostName(host)}`,
    size: 'wide',
    body: '<div class="row" style="padding:20px 0"><span class="spinner"></span><span class="muted">正在检测系统环境、依赖与网络…</span></div>',
    foot: '<button class="btn ghost" data-close="1">关闭</button>',
    onMount(m) {
      api(`/hosts/${encodeURIComponent(host.id)}/preflight`, { method: 'POST', body: { mode: hostEffectiveRole(host) === 'agent' ? 'k3s-agent' : 'k3s-server' } })
        .then((result) => {
          const checks = result.checks || [];
          const fail = checks.filter((c) => c.status === 'fail').length;
          const warn = checks.filter((c) => c.status === 'warn').length;
          $('.modal-body', m.el).innerHTML = `
            <div class="row" style="margin-bottom:14px">
              ${result.ok ? badge('可以安装', 'ok') : badge('存在阻塞项', 'err')}
              <span class="small muted">${checks.length} 项检查 · ${fail} 项失败 · ${warn} 项警告</span>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px">
              ${checks.map((c) => `
                <div class="preflight-row">
                  <span class="badge ${c.status === 'pass' ? 'ok' : c.status === 'warn' ? 'warn' : 'err'}">${c.status === 'pass' ? '通过' : c.status === 'warn' ? '警告' : '失败'}</span>
                  <div style="min-width:0;flex:1">
                    <div style="font-size:12.5px">${esc(c.label)}</div>
                    <div class="tiny dim" style="margin-top:2px;word-break:break-all">${esc(c.detail)}</div>
                  </div>
                </div>`).join('')}
            </div>
            ${result.detected && result.detected.os ? `<div class="alert info" style="margin-top:16px">${icon('cpu')}<div>${esc(result.detected.os.pretty || '')} · ${esc(result.detected.os.arch || '')} · ${esc(result.detected.resources.cpu || 0)} 核 / ${esc(result.detected.resources.memMB || 0)} MB · ${esc(result.detected.init || '')}</div></div>` : ''}`;
          if (result.ok) {
            const foot = $('.modal-foot', m.el);
            if (foot) foot.innerHTML = `<button class="btn ghost" data-close="1">关闭</button><button class="btn primary" id="pf-install">${icon('rocket')} 继续安装</button>`;
            const btn = $('#pf-install', m.el);
            if (btn) btn.addEventListener('click', () => {
              closeModal();
              openInstallModal(host, { role: hostEffectiveRole(host) === 'agent' ? 'agent' : 'server', lockRole: true });
            });
          }
        })
        .catch((err) => {
          $('.modal-body', m.el).innerHTML = `<div class="alert err">${icon('alert')}<div>${esc(errorText(err))}${err.detail ? '<br><br><span class="mono tiny">' + esc(truncate(err.detail, 600)) + '</span>' : ''}</div></div>`;
        });
    }
  });
  return modal;
}

const INSTALL_COMPONENTS = [
  { id: 'core', name: 'Kubernetes 核心', desc: 'kube-apiserver / controller-manager / scheduler / kubelet / kube-proxy / containerd', required: true },
  { id: 'coredns', name: 'CoreDNS', desc: '集群 DNS，Pod 域名解析', required: true },
  { id: 'traefik', name: 'Traefik', desc: '默认 Ingress 控制器', required: false },
  { id: 'servicelb', name: 'ServiceLB', desc: 'Service LoadBalancer 实现', required: false },
  { id: 'local-storage', name: 'Local Path Provisioner', desc: '本地存储卷供给', required: false },
  { id: 'metrics-server', name: 'Metrics Server', desc: 'kubectl top / HPA 指标', required: false }
];

function componentChecklistHTML() {
  return `<div class="component-list">
    ${INSTALL_COMPONENTS.map((component) => `
      <label class="component-item ${component.required ? 'required' : ''}">
        <input type="checkbox" value="${esc(component.id)}" data-install-component="${esc(component.id)}" ${component.required ? 'checked disabled' : 'checked'} />
        <span class="component-copy">
          <b>${esc(component.name)}</b>
          <small>${esc(component.desc)}</small>
        </span>
        ${component.required ? '<span class="badge neutral">必装</span>' : ''}
      </label>`).join('')}
  </div>
  <div class="tiny dim" style="margin-top:6px">勾选表示预装；必装组件已锁定，不可取消。etcd 不在列表中：单机默认 SQLite，3 / 5 台控制平面高可用时自动使用 k3s 内嵌 etcd，不需要单独勾选。</div>`;
}

function componentsToDisable(root) {
  return $$('[data-install-component]', root || document)
    .filter((el) => !el.checked)
    .map((el) => el.dataset.installComponent)
    .filter((value) => value && value !== 'core');
}

function isExistingClusterMaster(host) {
  const info = S.detected[host.id];
  return !!(info && info.k8s && info.k8s.installed && info.k8s.role !== 'agent');
}

function offlinePackagesStamp(packages = S.offlinePackages) {
  return JSON.stringify((Array.isArray(packages) ? packages : []).map((pkg) => [
    pkg.id, pkg.version, pkg.arch, pkg.valid, pkg.signature, pkg.size,
    Array.isArray(pkg.files) ? pkg.files.length : 0, pkg.hasChecksums ? 1 : 0
  ]));
}

async function loadOfflinePackages(options = {}) {
  const keepOnError = !!options.keepOnError;
  if (DEMO) {
    S.offlinePackages = [];
    S.offlinePackagesLoaded = true;
    S.offlinePackagesError = '演示模式不读取本地安装包';
    S.offlinePackagesStamp = offlinePackagesStamp();
    return false;
  }
  const previous = S.offlinePackagesStamp;
  const previousError = S.offlinePackagesError;
  try {
    const data = await api('/offline/packages');
    S.offlinePackages = Array.isArray(data.packages) ? data.packages : [];
    S.offlinePackagesError = '';
    S.offlinePackagesStamp = offlinePackagesStamp();
    return S.offlinePackagesStamp !== previous || previousError !== S.offlinePackagesError;
  } catch (err) {
    if (!keepOnError) {
      S.offlinePackages = [];
      S.offlinePackagesStamp = '';
    }
    S.offlinePackagesError = errorText(err);
    return S.offlinePackagesStamp !== previous || previousError !== S.offlinePackagesError;
  } finally {
    S.offlinePackagesLoaded = true;
  }
}

function normalizeArch(value) {
  const text = String(value || '').toLowerCase();
  if (text === 'x86_64' || text === 'amd64' || text === 'x64') return 'amd64';
  if (text === 'aarch64' || text === 'arm64') return 'arm64';
  if (text === 'armv7l' || text === 'armv6l' || text === 'armhf' || text === 'arm') return 'armhf';
  return text;
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function hostImagesTableHTML(data) {
  const images = Array.isArray(data && data.images) ? data.images : [];
  const toolbar = `<div class="row" style="justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
    <span class="tiny dim">共 ${esc(String(data && data.total !== undefined ? data.total : images.length))} 个镜像${data && data.fetchedAt ? ` · ${esc(new Date(data.fetchedAt).toLocaleString())}` : ''}</span>
    <div class="row" style="gap:8px">
      <button class="btn sm" data-import-image="1" title="上传 .tar 镜像包并导入该节点">${icon('upload')} 导入镜像</button>
      <button class="btn sm" data-import-image-multi="1" title="选多台服务器，同一个 tar 一次导入">${icon('upload')} 多台导入</button>
      <button class="btn sm" data-images-refresh="1">${icon('refresh')} 刷新</button>
    </div>
  </div>`;
  if (!images.length) {
    const repo = S.imageRepository && S.imageRepository.repository ? S.imageRepository.repository : 'docker.io';
    return `${toolbar}<div class="alert info">${icon('box')}<div>节点上还没有读取到镜像。可以重新读取，或确认 k3s/containerd 已启动。当前镜像仓库：<b class="mono">${esc(repo)}</b>，未配置时会使用默认的 <b class="mono">docker.io</b>。</div></div>`;
  }
  const rows = images.map((item) => {
    const tags = Array.isArray(item.repoTags) ? item.repoTags.filter(Boolean) : [];
    const primary = tags[0] || '<none>';
    const extra = tags.slice(1);
    const digest = Array.isArray(item.repoDigests) && item.repoDigests[0] ? item.repoDigests[0] : '';
    const shortId = String(item.id || '').replace(/^sha256:/, '').slice(0, 12) || '-';
    return `<tr>
      <td class="primary">
        <div class="image-name-row">
          <span class="mono">${esc(primary)}</span>
          ${primary !== '<none>' ? `<button class="icon-btn inline-copy-btn" data-copy-image="${esc(primary)}" title="复制镜像名" aria-label="复制镜像名">${icon('copy')}</button>` : ''}
        </div>
        ${extra.length ? `<div class="tiny dim mono" style="margin-top:2px">${extra.map((tag) => esc(tag)).join('<br>')}</div>` : ''}
        ${digest ? `<div class="tiny dim mono" style="margin-top:2px">${esc(digest)}</div>` : ''}
      </td>
      <td class="mono" title="${esc(item.id || '')}">${esc(shortId)}</td>
      <td class="right">${esc(formatBytes(item.size))}</td>
      <td class="right">
        <div class="row-actions" style="opacity:1">
          <button class="icon-btn" data-download-image="${esc(primary)}" title="导出并下载镜像 tar" aria-label="导出并下载镜像 tar" ${primary === '<none>' ? 'disabled' : ''}>${icon('download')}</button>
          <button class="icon-btn danger" data-delete-image="${esc(item.id || '')}" data-delete-label="${esc(primary)}" title="删除镜像（含该镜像的所有 tag）" aria-label="删除镜像" ${item.id ? '' : 'disabled'}>${icon('trash')}</button>
        </div>
      </td>
    </tr>`;
  }).join('');
  return `${toolbar}<div class="table-wrap"><table class="data">
    <thead><tr><th>镜像</th><th>镜像 ID</th><th class="right">大小</th><th class="right">操作</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

async function deleteK3sImage(host, imageId, label) {
  if (!host || !imageId) return;
  const name = label || imageId;
  const ok = await confirmDialog({
    title: '删除节点镜像',
    message: `确定从 <b>${esc(hostName(host))}</b> 删除镜像 <span class="code-inline">${esc(name)}</span>？<br><br>该镜像的所有 tag 都会被删除。正在运行的容器不会立即停止，但后续重启或重新调度时可能需要重新拉取；请不要删除 k3s 系统镜像。`,
    confirmText: '删除镜像',
    danger: true
  });
  if (!ok) {
    openHostImagesModal(host);
    return;
  }
  try {
    await api(`/hosts/${encodeURIComponent(host.id)}/images?image=${encodeURIComponent(imageId)}`, { method: 'DELETE' });
    toast('镜像已删除', 'success', 2600);
  } catch (err) {
    toast(errorText(err), 'error', 5000);
  } finally {
    openHostImagesModal(host);
  }
}

function openHostImagesModal(host) {
  if (!host) return;
  const modal = openModal({
    title: `k3s 镜像 · ${hostName(host)}`,
    size: 'wide',
    body: `<div class="alert info">${icon('refresh')}<div>正在读取节点镜像…</div></div>`
  });
  const root = modal.el;
  const setBody = (html) => {
    if (!root.isConnected) return;
    modal.setBody(html);
  };
  const load = async () => {
    setBody(`<div class="alert info">${icon('refresh')}<div>正在读取节点镜像…</div></div>`);
    try {
      const data = await api(`/hosts/${encodeURIComponent(host.id)}/images`);
      if (!root.isConnected) return;
      setBody(hostImagesTableHTML(data));
    } catch (err) {
      if (!root.isConnected) return;
      setBody(`<div class="alert err">${icon('alert')}<div>${esc(errorText(err))}</div></div>
        <div class="row" style="justify-content:flex-end"><button class="btn sm" data-images-refresh="1">${icon('refresh')} 重试</button></div>`);
    }
  };
  root.addEventListener('click', async (event) => {
    const refresh = event.target.closest('[data-images-refresh]');
    if (refresh) {
      event.preventDefault();
      await load();
      return;
    }
    const importBtn = event.target.closest('[data-import-image]');
    if (importBtn) {
      event.preventDefault();
      if (importBtn.disabled) return;
      // 导入的跟踪窗口会替换掉镜像列表弹窗，关闭窗口后回到镜像列表
      importK3sImageTar(host, { onClose: () => openHostImagesModal(host) });
      return;
    }
    const importMultiBtn = event.target.closest('[data-import-image-multi]');
    if (importMultiBtn) {
      event.preventDefault();
      if (importMultiBtn.disabled) return;
      // 镜像按节点各存一份，可以跨集群多选：同一个 tar 一次分发到所有选中节点
      const pool = S.hosts.filter((item) => (item.transport || 'ssh') === 'ssh');
      openHostPicker({
        hosts: pool,
        allowMixed: true,
        initial: [host.id],
        title: '选择要导入镜像的服务器',
        hint: '镜像按节点独立存储，可以跨集群多选；同一个 tar 会依次分发到每台服务器导入。',
        confirmText: '选择镜像包',
        onConfirm: (picked) => importK3sImageTar(picked, { onClose: () => openHostImagesModal(host) })
      });
      return;
    }
    const copy = event.target.closest('[data-copy-image]');
    if (copy) {
      event.preventDefault();
      await copyText(copy.dataset.copyImage || '');
      return;
    }
    const download = event.target.closest('[data-download-image]');
    if (download) {
      event.preventDefault();
      const image = download.dataset.downloadImage || '';
      if (!image || image === '<none>') return;
      download.disabled = true;
      try {
        const created = await api(`/hosts/${encodeURIComponent(host.id)}/images/export`, {
          method: 'POST',
          body: { image }
        });
        // 跟踪窗口会替换掉镜像列表弹窗；关闭窗口时再回到镜像列表
        openJobModal(created.jobId, {
          onClose: () => openHostImagesModal(host)
        });
      } catch (err) {
        download.disabled = false;
        toast(errorText(err), 'error', 6000);
      }
      return;
    }
    const remove = event.target.closest('[data-delete-image]');
    if (remove) {
      event.preventDefault();
      await deleteK3sImage(host, remove.dataset.deleteImage || '', remove.dataset.deleteLabel || '');
    }
  });
  load();
}

function offlinePackageById(id) {
  return S.offlinePackages.find((pkg) => pkg.id === id) || null;
}

function offlineTargetArchs(hosts = []) {
  const archs = [];
  for (const host of hosts) {
    const detected = S.detected[host.id];
    const arch = normalizeArch(detected && detected.os && detected.os.arch);
    if (arch && !archs.includes(arch)) archs.push(arch);
  }
  return archs;
}

function offlinePackageCompatible(pkg, hosts = []) {
  if (!pkg || !pkg.valid) return false;
  const archs = offlineTargetArchs(hosts);
  return !archs.length || archs.every((arch) => arch === pkg.arch);
}

function defaultOfflinePackageId(hosts = []) {
  const compatible = S.offlinePackages.find((pkg) => offlinePackageCompatible(pkg, hosts));
  return compatible ? compatible.id : '';
}

function offlinePackageOptions(selectedId, hosts = []) {
  if (!S.offlinePackages.length) {
    return `<option value="">${S.offlinePackagesLoaded ? '未找到离线安装包' : '加载中…'}</option>`;
  }
  const hasCompatible = S.offlinePackages.some((pkg) => offlinePackageCompatible(pkg, hosts));
  const placeholder = hasCompatible ? '' : '<option value="" selected>没有可用的离线安装包</option>';
  return placeholder + S.offlinePackages.map((pkg) => {
    const compatible = offlinePackageCompatible(pkg, hosts);
    const reason = !pkg.valid
      ? `不完整：${(pkg.issues && pkg.issues[0]) || '缺少文件'}`
      : !compatible
        ? `架构不匹配：${pkg.archLabel}`
        : '';
    const label = `${pkg.version || pkg.id} · ${pkg.archLabel} · ${formatBytes(pkg.size)}${reason ? ` · ${reason}` : ''}`;
    return `<option value="${esc(pkg.id)}" ${pkg.id === selectedId ? 'selected' : ''} ${compatible ? '' : 'disabled'}>${esc(label)}</option>`;
  }).join('');
}

function offlinePackageInfo(pkg) {
  if (!pkg) return '';
  return `<div class="offline-package-info">
    <div class="opi-main">${icon('box')}<b>${esc(pkg.version || pkg.id)}</b><span class="badge info">${esc(pkg.archLabel)}</span></div>
    <div class="opi-meta">${formatBytes(pkg.size)} · ${pkg.files.length} 个文件${pkg.hasChecksums ? ' · 含 SHA256 校验' : ''}</div>
    <div class="opi-note">安装时由控制端自动上传到目标服务器，无需手动复制。</div>
  </div>`;
}

function setOfflineSelectOptions(select, html, preferred) {
  const wanted = preferred !== undefined ? preferred : select.value;
  select.innerHTML = html;
  select.disabled = !S.offlinePackages.length;
  if (select.disabled) return '';
  const exact = Array.from(select.options).find((opt) => opt.value === wanted && !opt.disabled);
  if (exact) {
    select.value = exact.value;
    return exact.value;
  }
  const first = Array.from(select.options).find((opt) => opt.value && !opt.disabled);
  select.value = first ? first.value : '';
  return select.value;
}

function setOfflinePackageHelp(errorEl, emptyEl) {
  if (errorEl) {
    errorEl.textContent = S.offlinePackagesError || '';
    errorEl.classList.toggle('hidden', !S.offlinePackagesError);
  }
  if (emptyEl) emptyEl.classList.toggle('hidden', !!S.offlinePackages.length);
}

function refreshOfflinePackageUi() {
  const deploySelect = $('#depOfflinePackage');
  const deployWrap = $('#depOfflineWrap');
  if (deploySelect && deployWrap && !deployWrap.classList.contains('hidden')) {
    const form = ensureDeployForm();
    const hosts = [...form.serverIds, ...form.agentIds].map(findHost).filter(Boolean);
    const selected = setOfflineSelectOptions(deploySelect, offlinePackageOptions(form.offlinePackageId || deploySelect.value, hosts), form.offlinePackageId || deploySelect.value);
    form.offlinePackageId = selected;
    const pkg = offlinePackageById(selected);
    const version = $('#depVersion');
    if (version) version.value = pkg ? pkg.version || '' : '';
    const info = $('#depOfflineInfo');
    if (info) info.innerHTML = offlinePackageInfo(pkg);
    setOfflinePackageHelp($('#depOfflineError'), $('#depOfflineEmpty'));
  }

  const modalSelect = $('#if-offline-package');
  const modalWrap = $('#if-offline-wrap');
  if (modalSelect && modalWrap && !modalWrap.classList.contains('hidden')) {
    const host = findHost(modalSelect.dataset.hostId);
    const hosts = host ? [host] : [];
    const selected = setOfflineSelectOptions(modalSelect, offlinePackageOptions(modalSelect.value, hosts), modalSelect.value);
    const pkg = offlinePackageById(selected);
    const version = $('#if-version');
    if (version) version.value = pkg ? pkg.version || '' : '';
    const info = $('#if-offline-info');
    if (info) info.innerHTML = offlinePackageInfo(pkg);
    setOfflinePackageHelp($('#ifOfflineError'), $('#ifOfflineEmpty'));
  }
}

let offlinePollBusy = false;
async function pollOfflinePackages() {
  if (DEMO || document.hidden || offlinePollBusy) return;
  const deployActive = S.view === 'deploy' && S.deployTab === 'install'
    && ensureDeployForm().installMode === 'offline' && $('#depOfflinePackage');
  const modalActive = $('#if-offline-wrap') && !$('#if-offline-wrap').classList.contains('hidden')
    && $('#if-offline-package');
  if (!deployActive && !modalActive) return;
  offlinePollBusy = true;
  try {
    const changed = await loadOfflinePackages({ keepOnError: true });
    if (changed) refreshOfflinePackageUi();
  } finally {
    offlinePollBusy = false;
  }
}

function openInstallModal(host, presets = {}) {
  const isAgentRole = presets.role === 'agent' || (!presets.role && hostEffectiveRole(host) === 'agent');
  const lockedRole = presets.lockRole ? (presets.role === 'agent' ? 'agent' : 'server') : '';
  const masters = S.hosts.filter((h) => h.id !== host.id && isExistingClusterMaster(h));
  const initialOfflinePkgId = defaultOfflinePackageId([host]);
  const initialOfflinePkg = offlinePackageById(initialOfflinePkgId);
  const configuredMirror = !!(S.config && S.config.k3s && S.config.k3s.mirror);
  const mirrorUrl = String((S.config && S.config.k3s && S.config.k3s.mirrorUrl) || 'https://rancher-mirror.rancher.cn/k3s').trim();
  const roleField = lockedRole
    ? `<div class="field">安装方式
        <div class="install-mode-pill">
          <span class="badge ${lockedRole === 'agent' ? 'cyan' : 'purple'}">${lockedRole === 'agent' ? '加入已有集群' : '安装新集群'}</span>
          <span class="tiny dim">${lockedRole === 'agent' ? '仅安装工作节点' : '单机控制平面'}</span>
        </div>
      </div>
      <input type="hidden" id="if-role" value="${lockedRole}" />`
    : `<label class="field" id="if-role-wrap">节点角色
        <select class="select" id="if-role">
          <option value="server" ${isAgentRole ? '' : 'selected'}>主节点 / 单机</option>
          <option value="agent" ${isAgentRole ? 'selected' : ''}>工作节点</option>
        </select>
      </label>`;
  const body = `
    <div class="form-grid">
      ${roleField}
      <div class="full" id="if-install-mode-wrap">
        <div class="tiny dim" style="margin-bottom:6px;letter-spacing:.6px">安装方式</div>
        <div class="row" style="gap:18px;align-items:center;flex-wrap:wrap">
          <label class="check"><input type="radio" name="if-install-mode" value="online" checked /> 在线安装（下载 k3s）</label>
          <label class="check"><input type="radio" name="if-install-mode" value="offline" /> 离线安装（使用预置安装包）</label>
        </div>
      </div>
      <label class="field full hidden" id="if-offline-wrap">离线安装包
        <select class="select" id="if-offline-package" data-host-id="${esc(host.id)}" ${S.offlinePackages.length ? '' : 'disabled'}>
          ${offlinePackageOptions(initialOfflinePkgId, [host])}
        </select>
        <span class="help">从控制端 <span class="code-inline">packages/</span> 预置的安装包中选择：支持解压目录或 <span class="code-inline">.tar.gz</span> 归档。安装时由控制台自动上传到目标机；归档在本地临时解压，上传完成后立即清理。离线模式下每 10 秒自动扫描一次。</span>
        <span class="help ${S.offlinePackagesError ? '' : 'hidden'}" id="ifOfflineError" style="color:var(--err)">${esc(S.offlinePackagesError || '')}</span>
        <span class="help ${S.offlinePackages.length ? 'hidden' : ''}" id="ifOfflineEmpty" style="color:var(--err)">未找到离线包。请在项目 packages/ 下准备目录，包含 k3s、k3s-airgap-images-&lt;arch&gt;.tar、install.sh。</span>
        <div id="if-offline-info">${offlinePackageInfo(initialOfflinePkg)}</div>
      </label>
      <div class="full" id="if-datastore-wrap">
        <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
          <span class="tiny dim" style="letter-spacing:.6px">数据存储</span>
          <span class="badge info">SQLite（单机）</span>
          <span class="tiny dim">etcd 由 k3s 内嵌管理，不是可勾选组件；需要 etcd 高可用请改用 3 / 5 台控制平面部署。</span>
        </div>
      </div>
      <div class="full" id="if-k3s-fields">
        <div class="form-grid">
          <label class="field">版本（可选）
            <input class="input" id="if-version" placeholder="v1.30.4+k3s1，留空安装最新版" />
            <span class="help">cgroup v1 旧内核会自动使用兼容版本 v1.34.1+k3s1。</span>
          </label>
          <label class="field">通道
            <select class="select" id="if-channel">
              <option value="stable">stable（稳定）</option>
              <option value="latest">latest（最新）</option>
              <option value="testing">testing（测试）</option>
            </select>
          </label>
          <label class="field full" id="if-token-wrap">集群 Token（可选）
            <input class="input" id="if-token" placeholder="主节点留空自动生成；工作节点自动从主节点读取" />
          </label>
          <label class="field full hidden" id="if-server-wrap">主节点
            <select class="select" id="if-master">
              <option value="">自动选择 config 中的 server 角色</option>
              ${masters.map((m) => `<option value="${esc(m.id)}">${esc(hostName(m))} · ${esc(hostAddress(m))}</option>`).join('')}
            </select>
            <span class="help">工作节点通过该主节点的 API 加入集群，Token 会自动读取。</span>
          </label>
          <label class="field full">附加参数（每行一个）
            <textarea class="textarea" id="if-flags" rows="2" placeholder="--kubelet-arg=max-pods=150&#10;--node-label=env=prod"></textarea>
          </label>
          <div class="full" id="if-components-wrap">
            ${componentChecklistHTML()}
          </div>
          <div class="full row" style="gap:18px">
            <label class="check" id="if-mirror-wrap" title="镜像源：${esc(mirrorUrl)}"><input type="checkbox" id="if-mirror" ${configuredMirror ? 'checked' : ''} /> 使用国内镜像源</label>
            <label class="check"><input type="checkbox" id="if-force" /> 强制重装</label>
          </div>
        </div>
      </div>
    </div>`;

  const installTitle = lockedRole === 'agent' ? '加入已有集群' : lockedRole === 'server' ? '安装单机 k3s' : '安装 Kubernetes';
  const modal = openModal({
    title: `${installTitle} · ${hostName(host)}`,
    size: 'wide',
    body,
    foot: `<button class="btn ghost" data-close="1">取消</button><button class="btn primary" id="if-start">${icon('rocket')} ${lockedRole === 'agent' ? '加入集群' : '开始安装'}</button>`,
    onMount(m) {
      const role = $('#if-role', m.el);
      const offlineSelect = $('#if-offline-package', m.el);
      const applyOfflinePackage = () => {
        const pkg = offlinePackageById(offlineSelect ? offlineSelect.value : '');
        const info = $('#if-offline-info', m.el);
        if (info) info.innerHTML = offlinePackageInfo(pkg);
        const versionInput = $('#if-version', m.el);
        if (versionInput && pkg) versionInput.value = pkg.version || '';
      };
      const sync = () => {
        const agent = role.value === 'agent';
        const modeEl = $('input[name="if-install-mode"]:checked', m.el);
        const offline = modeEl && modeEl.value === 'offline';
        $('#if-datastore-wrap', m.el)?.classList.toggle('hidden', agent);
        $('#if-server-wrap', m.el).classList.toggle('hidden', !agent);
        $('#if-token-wrap', m.el).classList.toggle('hidden', agent);
        $('#if-components-wrap', m.el).classList.toggle('hidden', agent);
        $('#if-offline-wrap', m.el)?.classList.toggle('hidden', !offline);
        $('#if-mirror-wrap', m.el)?.classList.toggle('hidden', offline);
        const mirror = $('#if-mirror', m.el);
        if (mirror) mirror.disabled = offline;
        const versionInput = $('#if-version', m.el);
        if (versionInput) versionInput.disabled = offline;
        if (offline && offlineSelect && !offlineSelect.value) {
          const fallback = defaultOfflinePackageId([host]);
          if (fallback) offlineSelect.value = fallback;
        }
        if (offline) applyOfflinePackage();
        if (offline) pollOfflinePackages();
      };
      if (role && role.tagName === 'SELECT') role.addEventListener('change', sync);
      if (offlineSelect) offlineSelect.addEventListener('change', applyOfflinePackage);
      $$('input[name="if-install-mode"]', m.el).forEach((el) => el.addEventListener('change', sync));
      sync();
      $('#if-start', m.el).addEventListener('click', async () => {
        const btn = $('#if-start', m.el);
        const options = {};
        const installMode = ($('input[name="if-install-mode"]:checked', m.el) || {}).value || 'online';
        const selectedPkg = installMode === 'offline' ? offlinePackageById(offlineSelect ? offlineSelect.value : '') : null;
        options.version = installMode === 'offline' ? (selectedPkg ? selectedPkg.version : '') : $('#if-version', m.el).value.trim();
        options.channel = $('#if-channel', m.el).value;
        options.token = $('#if-token', m.el).value.trim();
        options.flags = $('#if-flags', m.el).value.split('\n').map((s) => s.trim()).filter(Boolean);
        options.disable = role.value === 'server' ? componentsToDisable(m.el) : [];
        options.installMode = installMode;
        options.offlinePackageId = selectedPkg ? selectedPkg.id : '';
        if (options.installMode === 'offline' && !options.offlinePackageId) {
          toast('请选择离线安装包', 'error');
          return;
        }
        options.mirror = options.installMode === 'online' && $('#if-mirror', m.el).checked ? 'cn' : '';
        options.force = $('#if-force', m.el).checked;
        options.role = role.value;
        if (role.value === 'agent') {
          const masterId = $('#if-master', m.el).value;
          if (!masterId) { toast('请选择主节点', 'error'); return; }
          options.masterId = masterId;
        }
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> 提交中';
        try {
          const body = { role: role.value, options };
          const data = await api(`/hosts/${encodeURIComponent(host.id)}/install`, { method: 'POST', body });
          closeModal();
          openJobModal(data.jobId);
          toast('安装操作已启动', 'success');
        } catch (err) {
          toast(errorText(err), 'error');
          btn.disabled = false;
          btn.innerHTML = icon('rocket') + ' 开始安装';
        }
      });
    }
  });
  return modal;
}

function goDeployInstall(hostId) {
  if (!S.deployForm) S.deployForm = { serverIds: [], agentIds: [] };
  S.deployForm.serverIds = [hostId];
  S.deployForm.agentIds = [];
  goDeployTab('install');
}

// 快捷卸载：直接跳到「部署中心 → k3s 安装/卸载 → 卸载」，并预选当前服务器
function goDeployUninstall(hostId) {
  S.k3sUninstallHostIds = hostId ? [hostId] : [];
  goDeployTab('install', { k3sPage: 'uninstall' });
  if (hostId && !k3sUninstallSelectedIds().includes(hostId)) {
    toast('该服务器没有出现在可卸载列表（可能未安装 k3s 或信息未读取），请先重新读取服务器信息', 'error');
  }
}

function openInstallChoice(host) {
  const hasMaster = S.hosts.some((h) => h.id !== host.id && isExistingClusterMaster(h));
  openModal({
    title: `安装或加入 · ${hostName(host)}`,
    size: 'wide',
    body: `
      <div class="install-choice-grid">
        <div class="install-choice-card">
          <div class="install-choice-icon">${icon('rocket')}</div>
          <h4>安装 Kubernetes</h4>
          <p>在这台机器上初始化新的 k3s 集群。只有这一台时安装为单机；需要多台时进入集群安装，再选择 1 / 3 / 5 台控制平面。</p>
          <div class="install-choice-actions">
            <button class="btn primary" id="ic-single">${icon('server')} 单机安装这台</button>
            <button class="btn" id="ic-cluster">${icon('cluster')} 安装多台集群</button>
          </div>
        </div>
        <div class="install-choice-card">
          <div class="install-choice-icon">${icon('link')}</div>
          <h4>加入已有集群</h4>
          <p>只在这台机器上安装 k3s 工作节点，加入一个已经存在的控制平面；不会在本机初始化控制平面。</p>
          <div class="install-choice-actions">
            <button class="btn" id="ic-join" ${hasMaster ? '' : 'disabled title="需要先在服务器列表中添加并读取一个控制平面"'}>${icon('plus')} 作为工作节点加入</button>
            ${hasMaster ? '' : '<span class="tiny dim">当前没有可用控制平面，请先添加或读取一台主节点。</span>'}
          </div>
        </div>
      </div>
      <div class="alert info" style="margin-top:14px">${icon('server')}<div>「安装多台集群」会打开「部署中心 → k3s 安装/卸载」页签，并预先选中当前机器作为控制平面；可以继续添加服务器或工作节点。</div></div>`,
    foot: '<button class="btn ghost" data-close="1">取消</button>',
    onMount(m) {
      $('#ic-single', m.el).addEventListener('click', () => {
        closeModal();
        openInstallModal(host, { role: 'server', lockRole: true });
      });
      $('#ic-cluster', m.el).addEventListener('click', () => {
        closeModal();
        goDeployInstall(host.id);
      });
      const joinBtn = $('#ic-join', m.el);
      if (joinBtn && !joinBtn.disabled) {
        joinBtn.addEventListener('click', () => {
          closeModal();
          openInstallModal(host, { role: 'agent', lockRole: true });
        });
      }
    }
  });
}

function uninstallHost(host) {
  const info = S.detected[host.id] || {};
  const k8s = info.k8s || {};
  if (k8s.installed && k8s.flavor !== 'k3s') {
    toast('当前只支持 k3s 卸载；外部 Kubernetes / kubeadm 集群请使用对应集群的清理流程，避免误删共享的 kubelet 与容器运行时。', 'error');
    return;
  }
  goDeployUninstall(host.id);
}

async function deleteHost(host) {
  const ok = await confirmDialog({
    title: '确认删除',
    message: `确定删除服务器 <b>${esc(hostName(host))}</b> 吗？<br><span class="tiny dim">只删除 data/server.json 中的连接配置，不影响服务器本身。</span>`,
    confirmText: '确认删除',
    danger: true
  });
  if (!ok) return;
  try {
    await api(`/hosts/${encodeURIComponent(host.id)}`, { method: 'DELETE' });
    closeModal();
    delete S.detected[host.id];
    delete S.overview[host.id];
    await loadHosts();
    renderView();
    toast('服务器配置已删除', 'success');
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

/* ============================================================
 * 服务器分组（左栏二级树的一级层级）
 * 分组就是目录：新增 / 重命名 / 删除，以及把服务器拖到别的分组。
 * ============================================================ */
function toggleHostGroup(name) {
  if (!name) return;
  const collapsed = !S.page.collapsedGroups[name];
  S.page.collapsedGroups[name] = collapsed;
  const node = document.querySelector(`[data-group-node="${CSS.escape(name)}"]`);
  if (!node) { refreshServerList(); return; }
  node.classList.toggle('collapsed', collapsed);
  const head = node.querySelector('.group-node-head');
  if (head) head.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
}

async function addHostGroup() {
  const name = await promptDialog({
    title: '新增分组',
    label: '分组名称',
    placeholder: '例如：生产环境',
    maxlength: 40,
    confirmText: '创建分组'
  });
  if (!name) return;
  if (hostGroupNames().includes(name)) { toast('该分组已存在', 'error'); return; }
  try {
    await api('/groups', { method: 'POST', body: { name } });
    await loadHosts();
    S.page.collapsedGroups[name] = false;
    refreshServerList();
    toast(`分组「${name}」已创建`, 'success');
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

async function renameHostGroup(name) {
  if (!name || name === defaultGroupName()) return;
  const next = await promptDialog({
    title: '重命名分组',
    label: '新的分组名称',
    value: name,
    maxlength: 40,
    confirmText: '保存'
  });
  if (!next || next === name) return;
  if (hostGroupNames().includes(next)) { toast('该分组已存在', 'error'); return; }
  try {
    await api(`/groups/${encodeURIComponent(name)}`, { method: 'PUT', body: { name: next } });
    await loadHosts();
    if (S.page.collapsedGroups[name] !== undefined) {
      S.page.collapsedGroups[next] = S.page.collapsedGroups[name];
      delete S.page.collapsedGroups[name];
    }
    refreshServerList();
    toast(`分组已重命名为「${next}」`, 'success');
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

async function deleteHostGroup(name) {
  if (!name || name === defaultGroupName()) return;
  const hosts = S.hosts.filter((h) => String(h.group || '').trim() === name);
  const message = hosts.length
    ? `分组 <b>${esc(name)}</b> 下还有 <b>${hosts.length}</b> 台服务器：<br><span class="tiny">${hosts.map((h) => esc(hostName(h))).join('、')}</span><br><br>删除分组会<b>连同这些服务器配置一起删除</b>（不会影响服务器本机）。确定继续吗？`
    : `确定删除空分组 <b>${esc(name)}</b> 吗？`;
  const ok = await confirmDialog({
    title: hosts.length ? '删除分组并删除其下服务器' : '确认删除分组',
    message,
    confirmText: hosts.length ? `删除分组和 ${hosts.length} 台服务器` : '删除分组',
    danger: true
  });
  if (!ok) return;
  try {
    const result = await api(`/groups/${encodeURIComponent(name)}`, { method: 'DELETE' });
    const removed = (result && result.removed) || [];
    for (const item of removed) {
      delete S.detected[item.id];
      delete S.overview[item.id];
      delete S.page.collapsedGroups[item.id];
    }
    delete S.page.collapsedGroups[name];
    await loadHosts();
    renderView();
    toast(removed.length ? `分组已删除，同时删除 ${removed.length} 台服务器` : '分组已删除', 'success');
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

async function moveHostToGroup(hostId, groupName) {
  const host = findHost(hostId);
  if (!host || !groupName) return;
  if (String(host.group || '').trim() === groupName) return;
  try {
    await api(`/hosts/${encodeURIComponent(hostId)}/group`, { method: 'PUT', body: { group: groupName } });
    host.group = groupName;
    S.page.collapsedGroups[groupName] = false;
    refreshServerList();
    renderView();
    toast(`${hostName(host)} 已移动到「${groupName}」`, 'success', 2200);
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

/* ============================================================
 * 拖拽：把二级的服务器拖到一级的分组上即可换组
 * ============================================================ */
let dragHostId = '';

function clearDropTargets() {
  document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
  document.querySelectorAll('.server-item-wrap.dragging').forEach((el) => el.classList.remove('dragging'));
}

function bindHostTreeDrag() {
  // #serverList 每次渲染都会重建，所以监听挂在 document 上做委托
  const inTree = (el) => !!(el && el.closest && el.closest('#serverList'));
  document.addEventListener('dragstart', (event) => {
    if (!inTree(event.target)) return;
    const wrap = event.target.closest('.server-item-wrap[data-drag-host]');
    if (!wrap) return;
    dragHostId = wrap.dataset.dragHost || '';
    if (!dragHostId) return;
    wrap.classList.add('dragging');
    try {
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', dragHostId);
    } catch (_) { /* 部分浏览器限制 */ }
  });
  document.addEventListener('dragend', (event) => {
    if (!inTree(event.target) && !dragHostId) return;
    dragHostId = '';
    clearDropTargets();
  });
  document.addEventListener('dragover', (event) => {
    if (!dragHostId) return;
    const node = event.target.closest('[data-drop-group]');
    if (!node || !inTree(node)) { clearDropTargets(); return; }
    const groupName = node.dataset.dropGroup || '';
    const host = findHost(dragHostId);
    if (!groupName || (host && String(host.group || '').trim() === groupName)) { clearDropTargets(); return; }
    event.preventDefault();
    try { event.dataTransfer.dropEffect = 'move'; } catch (_) { /* ignore */ }
    if (!node.classList.contains('drop-target')) {
      clearDropTargets();
      node.classList.add('drop-target');
    }
  });
  document.addEventListener('dragleave', (event) => {
    const node = event.target.closest && event.target.closest('[data-drop-group]');
    if (!node) return;
    if (node.contains(event.relatedTarget)) return;
    node.classList.remove('drop-target');
  });
  document.addEventListener('drop', async (event) => {
    const node = event.target.closest && event.target.closest('[data-drop-group]');
    const hostId = dragHostId || (event.dataTransfer && event.dataTransfer.getData('text/plain')) || '';
    clearDropTargets();
    dragHostId = '';
    if (!node || !inTree(node) || !hostId) return;
    event.preventDefault();
    const groupName = node.dataset.dropGroup || '';
    if (!groupName) return;
    await moveHostToGroup(hostId, groupName);
  });
}

