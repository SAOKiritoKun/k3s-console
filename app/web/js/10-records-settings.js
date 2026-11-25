'use strict';

/* ============================================================
 * 设置
 * ============================================================ */
function renderSettings() {
  const view = $('#view');
  const tab = S.page.settingsTab || 'config';
  view.innerHTML = `
    ${DEMO ? demoBanner() : ''}
    <div class="tabs-line">
      <button class="tab ${tab === 'config' ? 'active' : ''}" data-action="settings-tab" data-tab="config">config.json</button>
      <button class="tab ${tab === 'security' ? 'active' : ''}" data-action="settings-tab" data-tab="security">访问与安全</button>
      <button class="tab ${tab === 'about' ? 'active' : ''}" data-action="settings-tab" data-tab="about">关于</button>
    </div>
    <div id="settingsBody">${settingsBodyHTML(tab)}</div>`;
  if (tab === 'config') bindConfigEditor();
}

function settingsBodyHTML(tab) {
  if (tab === 'security') {
    const app = (S.config && S.config.app) || {};
    const tokenEnabled = app.accessToken === '__UNCHANGED__' || (app.accessToken && app.accessToken !== '__UNCHANGED__');
    return `
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h3>${icon('lock')} 访问控制</h3></div>
          <div class="card-body">
            <div class="kv"><span class="k">监听地址</span><span class="v">${esc(app.host || '127.0.0.1')}:${esc(app.port || 8964)}</span></div>
            <div class="kv"><span class="k">访问令牌</span><span class="v">${tokenEnabled ? '已启用' : '未启用'}</span></div>
            <div class="kv"><span class="k">令牌存储</span><span class="v">config.json（明文）</span></div>
            <div class="divider" style="margin:12px 0"></div>
            <div class="alert ${tokenEnabled ? 'ok' : 'warn'}" style="margin-top:0">${icon('shield')}<div>
              ${tokenEnabled ? '当前已启用访问令牌，所有 API 请求需要携带 <span class="code-inline">X-Access-Token</span>。' : '未启用访问令牌。强烈建议在 config.json 中设置 <span class="code-inline">app.accessToken</span>，尤其是在监听 0.0.0.0 时。'}
            </div></div>
            <div class="small muted" style="line-height:1.9;margin-top:12px">
              · 默认仅监听 <span class="code-inline">127.0.0.1</span>，不要将其直接暴露到公网。<br>
              · 若确需远程访问，请使用 SSH 隧道、VPN 或反向代理并启用 HTTPS。<br>
              · 令牌可通过 <span class="code-inline">?token=</span>（SSE）或请求头携带。
            </div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>${icon('server')} SSH 安全</h3></div>
          <div class="card-body">
            <div class="kv"><span class="k">默认用户</span><span class="v">${esc((S.config && S.config.ssh && S.config.ssh.defaultUser) || 'root')}</span></div>
            <div class="kv"><span class="k">主机密钥策略</span><span class="v">${esc((S.config && S.config.ssh && S.config.ssh.hostKeyPolicy) || 'accept-new')}</span></div>
            <div class="kv"><span class="k">known_hosts</span><span class="v">${esc((S.config && S.config.ssh && S.config.ssh.knownHostsPath) || '默认')}</span></div>
            <div class="divider" style="margin:12px 0"></div>
            <div class="small muted" style="line-height:1.9">
              · <b>accept-new</b>：首次连接自动记录指纹，后续若变化会拒绝连接。<br>
              · <b>strict</b>：仅允许 known_hosts 中已存在的指纹，最安全。<br>
              · <b>insecure</b>：不校验主机指纹，仅用于受控测试环境。<br>
              · 密码与私钥保存在 config.json 中，请限制文件权限（Linux 建议 <span class="code-inline">chmod 600</span>）。
            </div>
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h3>修改访问令牌</h3></div>
        <div class="card-body">
          <div class="form-grid">
            <label class="field full">新访问令牌（留空表示不启用）
              <input class="input" id="newToken" type="password" autocomplete="new-password" placeholder="设置后所有请求都需要此令牌" />
              <span class="help">保存后立即生效，当前页面会要求重新输入令牌。</span>
            </label>
          </div>
          <button class="btn primary" style="margin-top:12px" data-action="save-token">保存令牌</button>
        </div>
      </div>`;
  }
  if (tab === 'about') {
    return `
      <div class="grid grid-2">
        <div class="card">
          <div class="card-head"><h3>k3s 集群管家</h3><span class="badge info">v${esc(S.health ? S.health.version : '1.0.0')}</span></div>
          <div class="card-body">
            <div class="kv"><span class="k">Node.js</span><span class="v">${esc(S.health ? S.health.node : '-')}</span></div>
            <div class="kv"><span class="k">运行平台</span><span class="v">${esc(S.health ? S.health.platform : '-')}</span></div>
            <div class="kv"><span class="k">SSH 支持</span><span class="v">${S.health && S.health.hasSsh2 ? 'ssh2 已就绪' : '未安装 ssh2'}</span></div>
            <div class="kv"><span class="k">服务器数量</span><span class="v">${S.hosts.length}</span></div>
            <div class="kv"><span class="k">应用配置</span><span class="v">config.json</span></div>
            <div class="kv"><span class="k">服务器数据</span><span class="v">data/server.json</span></div>
            <div class="kv"><span class="k">模板目录</span><span class="v">data/deploymentTemplates/</span></div>
            <div class="divider" style="margin:12px 0"></div>
            <p class="small muted" style="line-height:1.9;margin:0">一个本地优先的 Kubernetes / K3s 运维控制台。通过 SSH 或 kubeconfig 连接服务器，支持环境检测、集群部署、资源查看与修改。服务器凭据保存在本机 data/server.json，应用配置保存在项目根目录 config.json。</p>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>能力清单</h3></div>
          <div class="card-body" style="display:flex;flex-direction:column;gap:9px">
            ${[
              ['server', '服务器管理', 'SSH / 本地 / kubeconfig 三种接入方式'],
              ['shield', '环境预检', '系统、依赖、端口、网络与资源检查'],
              ['rocket', '集群部署', 'k3s 单机 / 多节点集群'],
              ['layers', '资源管理', '20+ 类资源的查看、YAML 编辑与操作'],
              ['terminal', '实时日志', 'SSE 流式输出部署与安装过程'],
              ['lock', '本地凭据', '配置文件热加载与敏感字段掩码']
            ].map(([ico, title, desc]) => `<div class="row" style="gap:10px;align-items:flex-start">
              <span class="stat-ico" style="width:26px;height:26px">${icon(ico)}</span>
              <div><div style="font-size:12px;font-weight:600">${esc(title)}</div><div class="tiny dim">${esc(desc)}</div></div>
            </div>`).join('')}
          </div>
        </div>
      </div>
      <div class="card" style="margin-top:16px">
        <div class="card-head"><h3>本地 API</h3></div>
        <div class="card-body small mono muted" style="line-height:2;word-break:break-all">
          GET /api/health · GET /api/meta · GET|PUT /api/config<br>
          GET|POST /api/hosts · PUT|DELETE /api/hosts/:id<br>
          GET|POST /api/groups · PUT|DELETE /api/groups/:name<br>
          GET|POST /api/templates · DELETE /api/templates/:id<br>
          POST /api/hosts/:id/detect · /preflight · /install · /uninstall<br>
          GET /api/hosts/:id/overview · /nodes · /resources · /resource<br>
          POST /api/hosts/:id/apply · /scale · /restart · /node-action<br>
          POST /api/deploy/cluster · GET /api/jobs · /api/jobs/:id/stream
        </div>
      </div>`;
  }

  const json = S.settingsDraft !== null && S.settingsDraft !== undefined ? S.settingsDraft : JSON.stringify(S.config || {}, null, 2);
  return `
    <div class="card">
      <div class="card-head">
        <h3>${icon('settings')} config.json</h3>
        <div class="row" style="gap:6px">
          <button class="btn sm" data-action="config-format">${icon('scroll')} 格式化</button>
          <button class="btn sm" data-action="config-reload">${icon('refresh')} 从磁盘重载</button>
          <button class="btn sm" data-action="config-download">${icon('download')} 下载</button>
          <button class="btn sm primary" data-action="config-save">${icon('check')} 保存</button>
        </div>
      </div>
      <div class="card-body">
        <div class="alert info" style="margin-bottom:12px">${icon('lock')}<div>敏感字段以 <span class="code-inline">__UNCHANGED__</span> 显示，保存时会自动保留原值。修改端口或监听地址后需要重启 Node 服务。保存成功后配置将热加载。<br>服务器连接信息已独立保存在 <span class="code-inline">data/server.json</span>，不在此编辑器中。</div></div>
        <textarea class="editor" id="configEditor" spellcheck="false" style="min-height:440px"></textarea>
        <div class="row" style="margin-top:10px">
          <span class="tiny dim">路径：config.json（项目根目录）</span>
          <span class="spacer"></span>
          <span class="tiny dim" id="configStatus"></span>
        </div>
      </div>
    </div>`;
}

function bindConfigEditor() {
  const editor = $('#configEditor');
  if (!editor) return;
  editor.value = S.settingsDraft !== null && S.settingsDraft !== undefined ? S.settingsDraft : JSON.stringify(S.config || {}, null, 2);
  editor.addEventListener('input', () => { S.settingsDraft = editor.value; });
}

async function saveConfig() {
  const editor = $('#configEditor');
  if (!editor) return;
  let parsed;
  try {
    parsed = JSON.parse(editor.value);
  } catch (err) {
    toast('JSON 解析失败：' + err.message, 'error');
    return;
  }
  try {
    const data = await api('/config', { method: 'PUT', body: { config: parsed } });
    S.config = data.config;
    S.settingsDraft = null;
    S.detected = {};
    S.overview = {};
    S.cluster = null;
    S.workloadData = null;
    await loadHosts();
    renderView();
    toast('配置已保存并热加载', 'success');
  } catch (err) {
    toast(errorText(err) + (err.detail ? '：' + truncate(err.detail, 300) : ''), 'error');
  }
}

async function reloadConfig() {
  try {
    const data = await api('/config/reload', { method: 'POST' });
    S.config = data.config;
    S.settingsDraft = null;
    S.detected = {};
    await loadHosts();
    renderView();
    toast('已从磁盘重新加载配置', 'success');
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

async function saveToken() {
  const input = $('#newToken');
  if (!input) return;
  const value = input.value.trim();
  const next = JSON.parse(JSON.stringify(S.config || {}));
  next.app = next.app || {};
  next.app.accessToken = value;
  try {
    const data = await api('/config', { method: 'PUT', body: { config: next } });
    S.config = data.config;
    S.settingsDraft = null;
    sessionStorage.removeItem(TOKEN_KEY);
    toast(value ? '访问令牌已启用，请重新输入令牌' : '访问令牌已关闭', 'success');
    setTimeout(() => { if (value) showTokenModal(); }, 500);
    renderView();
  } catch (err) {
    toast(errorText(err), 'error');
  }
}
