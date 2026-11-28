'use strict';

/* ============================================================
 * 部署中心
 * ============================================================ */
const YAML_TEMPLATES = {
  deployment: { label: 'Deployment（无状态应用）', yaml: `apiVersion: apps/v1
kind: Deployment
metadata:
  name: demo-app
  namespace: default
  labels:
    app: demo-app
spec:
  replicas: 2
  selector:
    matchLabels:
      app: demo-app
  template:
    metadata:
      labels:
        app: demo-app
    spec:
      containers:
        - name: demo-app
          image: nginx:1.27-alpine
          ports:
            - containerPort: 80
          resources:
            requests:
              cpu: 50m
              memory: 64Mi
            limits:
              cpu: 500m
              memory: 256Mi
` },
  pod: { label: 'Pod（单实例）', yaml: `apiVersion: v1
kind: Pod
metadata:
  name: demo-pod
  namespace: default
  labels:
    app: demo-pod
spec:
  containers:
    - name: demo-pod
      image: nginx:1.27-alpine
      ports:
        - containerPort: 80
` },
  service: { label: 'Service（ClusterIP）', yaml: `apiVersion: v1
kind: Service
metadata:
  name: demo-app
  namespace: default
spec:
  selector:
    app: demo-app
  ports:
    - name: http
      port: 80
      targetPort: 80
  type: ClusterIP
` },
  configmap: { label: 'ConfigMap', yaml: `apiVersion: v1
kind: ConfigMap
metadata:
  name: demo-config
  namespace: default
data:
  APP_ENV: production
  LOG_LEVEL: info
` },
  namespace: { label: 'Namespace', yaml: `apiVersion: v1
kind: Namespace
metadata:
  name: demo
  labels:
    env: demo
` },
  ingress: { label: 'Ingress（nginx）', yaml: `apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: demo-app
  namespace: default
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
    - host: demo.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: demo-app
                port:
                  number: 80
` },
  networkpolicy: { label: 'NetworkPolicy（网络策略）', yaml: `apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: demo-app-allow
  namespace: default
spec:
  podSelector:
    matchLabels:
      app: demo-app
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: default
      ports:
        - protocol: TCP
          port: 80
` },
  cronjob: { label: 'CronJob', yaml: `apiVersion: batch/v1
kind: CronJob
metadata:
  name: demo-backup
  namespace: default
spec:
  schedule: "0 3 * * *"
  concurrencyPolicy: Forbid
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: OnFailure
          containers:
            - name: backup
              image: busybox:1.36
              command: ["/bin/sh", "-c", "date; echo backup done"]
` }
};

const LEGACY_YAML_TEMPLATES_KEY = 'k3s-yaml-templates';

function legacyYamlTemplates() {
  try {
    const raw = localStorage.getItem(LEGACY_YAML_TEMPLATES_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list)
      ? list.filter((t) => t && typeof t.name === 'string' && typeof t.yaml === 'string' && String(t.name).trim())
      : [];
  } catch (_) {
    return [];
  }
}

async function migrateLegacyYamlTemplates() {
  if (DEMO) return;
  const legacy = legacyYamlTemplates();
  if (!legacy.length) return;
  let failed = false;
  for (const template of legacy) {
    try {
      await api('/templates', { method: 'POST', body: { name: template.name, yaml: template.yaml } });
    } catch (_) {
      failed = true;
    }
  }
  if (!failed) localStorage.removeItem(LEGACY_YAML_TEMPLATES_KEY);
}

async function loadDeploymentTemplates() {
  try {
    await migrateLegacyYamlTemplates();
    const data = await api('/templates');
    S.deploymentTemplates = Array.isArray(data.templates)
      ? data.templates.filter((t) => t && typeof t.id === 'string' && typeof t.name === 'string' && typeof t.yaml === 'string')
      : [];
    S.deploymentTemplatesLoaded = true;
  } catch (error) {
    S.deploymentTemplates = [];
    S.deploymentTemplatesLoaded = true;
    throw error;
  }
}

function yamlTemplateByKey(key) {
  if (YAML_TEMPLATES[key]) return YAML_TEMPLATES[key];
  if (!key || !key.startsWith('custom:')) return null;
  const id = key.slice('custom:'.length);
  const template = S.deploymentTemplates.find((t) => t.id === id);
  return template ? { label: template.name, yaml: template.yaml } : null;
}

function checkYamlSyntax(yaml) {
  const source = String(yaml || '');
  if (!source.trim()) return { ok: false, message: 'YAML 内容为空' };
  if (typeof jsyaml === 'undefined' || !jsyaml || typeof jsyaml.loadAll !== 'function') {
    return { ok: true, skipped: true };
  }
  try {
    const docs = jsyaml.loadAll(source).filter((doc) => doc !== null && doc !== undefined);
    if (!docs.length) return { ok: false, message: '没有可解析的 YAML 文档' };
    return { ok: true };
  } catch (error) {
    const mark = error && error.mark;
    const reason = (error && (error.reason || error.message)) || 'YAML 语法错误';
    const position = mark ? `（第 ${mark.line + 1} 行，第 ${mark.column + 1} 列）` : '';
    return { ok: false, message: `${reason}${position}`, line: mark ? mark.line + 1 : 0, column: mark ? mark.column + 1 : 0 };
  }
}

function paintYamlSyntaxStatus(result, selector = '#yamlSyntaxStatus') {
  const el = $(selector);
  if (!el) return;
  if (!result || result.ok || result.skipped) {
    el.textContent = '';
    el.className = 'tiny dim hidden';
    return;
  }
  el.textContent = `YAML 语法错误：${result.message}`;
  el.className = 'tiny yaml-syntax-error';
}

function updateYamlSyntaxStatus() {
  const editor = $('#deployYaml');
  if (!editor) return;
  paintYamlSyntaxStatus(checkYamlSyntax(editor.value));
}

let yamlSyntaxTimer = null;
function scheduleYamlSyntaxCheck() {
  if (yamlSyntaxTimer) clearTimeout(yamlSyntaxTimer);
  yamlSyntaxTimer = setTimeout(updateYamlSyntaxStatus, 250);
}

function checkYamlTemplateSyntax() {
  const editor = $('#deployYaml');
  if (!editor) return;
  const result = checkYamlSyntax(editor.value);
  paintYamlSyntaxStatus(result);
  if (result.skipped) {
    toast('YAML 解析器未加载，无法检测语法', 'error');
    return;
  }
  if (result.ok) {
    toast('模板语法检测通过', 'success', 1800);
    return;
  }
  toast(`模板语法错误：${result.message}`, 'error');
}

function yamlTemplateOptionsHTML() {
  const base = Object.entries(YAML_TEMPLATES)
    .map(([key, template]) => `<option value="${key}">${esc(template.label)}</option>`)
    .join('');
  const custom = S.deploymentTemplates;
  if (!custom.length) return base;
  return `${base}<optgroup label="我的模板">${custom
    .map((template) => `<option value="custom:${esc(template.id)}">${esc(template.name)}</option>`)
    .join('')}</optgroup>`;
}

function updateYamlTemplateDeleteButton() {
  const button = $('[data-action="yaml-template-delete"]');
  if (!button) return;
  const select = $('#yamlTemplate');
  const isCustom = !!(select && select.value.startsWith('custom:'));
  button.classList.toggle('hidden', !isCustom);
  button.disabled = !isCustom;
}

function refreshYamlTemplateOptions(selectedKey) {
  const select = $('#yamlTemplate');
  if (!select) return;
  select.innerHTML = `<option value="">选择模板…</option>${yamlTemplateOptionsHTML()}`;
  if (selectedKey) select.value = selectedKey;
  updateYamlTemplateDeleteButton();
}

async function deleteYamlTemplate() {
  const select = $('#yamlTemplate');
  const key = select ? select.value : '';
  if (!key.startsWith('custom:')) {
    toast('请先选择一个「我的模板」', 'info');
    return;
  }
  const template = yamlTemplateByKey(key);
  if (!template) {
    toast('模板不存在，请重新选择', 'error');
    return;
  }
  const confirmed = await confirmDialog({
    title: '删除模板',
    message: `确定删除「<b>${esc(template.label)}</b>」吗？<br><span class="tiny dim">对应文件会从 data/deployment-templates 中删除，且无法恢复。</span>`,
    confirmText: '删除',
    danger: true
  });
  if (!confirmed) return;
  const id = key.slice('custom:'.length);
  try {
    await api(`/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
    S.deploymentTemplates = S.deploymentTemplates.filter((item) => item.id !== id);
    refreshYamlTemplateOptions('');
    toast(`已删除模板「${template.label}」`, 'success');
  } catch (error) {
    toast(`删除模板失败：${errorText(error)}`, 'error');
  }
}

function openSaveYamlTemplateDialog() {
  const yaml = ($('#deployYaml') || {}).value || '';
  if (!yaml.trim()) {
    toast('YAML 内容为空，无法保存模板', 'error');
    return;
  }
  openModal({
    title: '保存模板',
    size: 'narrow',
    body: `<div class="field">
      <label class="label" for="yamlTemplateName">模板名称</label>
      <input class="input" id="yamlTemplateName" maxlength="40" placeholder="例如：我的 Nginx 应用" autocomplete="off" />
      <div class="tiny dim" style="margin-top:6px">保存到 data/deployment-templates 目录；同名模板会覆盖，之后可从模板下拉框重新载入或删除。</div>
      <div class="alert err hidden" id="yamlTemplateError" style="margin-top:10px"></div>
    </div>`,
    foot: `<button class="btn" data-close="1">取消</button><button class="btn primary" id="yamlTemplateSave">${icon('check')} 保存</button>`,
    onMount: (modal) => {
      const input = $('#yamlTemplateName');
      const saveBtn = $('#yamlTemplateSave');
      const errorBox = $('#yamlTemplateError');
      const showError = (message) => {
        if (!errorBox) return;
        errorBox.textContent = message;
        errorBox.classList.remove('hidden');
      };
      const submit = async () => {
        const name = (input ? input.value : '').trim();
        if (!name) {
          toast('请输入模板名称', 'error');
          if (input) input.focus();
          return;
        }
        const syntax = checkYamlSyntax(yaml);
        if (!syntax.ok) {
          showError(`YAML 语法错误：${syntax.message}`);
          paintYamlSyntaxStatus(syntax);
          return;
        }
        if (saveBtn) saveBtn.disabled = true;
        try {
          const data = await api('/templates', { method: 'POST', body: { name, yaml } });
          const template = data.template;
          const index = S.deploymentTemplates.findIndex((item) => item.id === template.id);
          if (index >= 0) S.deploymentTemplates[index] = template;
          else S.deploymentTemplates.push(template);
          S.deploymentTemplates.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
          refreshYamlTemplateOptions(`custom:${template.id}`);
          modal.close();
          toast(`已保存模板「${template.name}」`, 'ok');
        } catch (error) {
          if (saveBtn) saveBtn.disabled = false;
          showError(`保存失败：${errorText(error)}`);
        }
      };
      if (saveBtn) saveBtn.onclick = submit;
      if (input) {
        input.onkeydown = (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        };
        requestAnimationFrame(() => { input.focus(); });
      }
    }
  });
}

function hostHasKubernetes(host) {
  const info = S.detected[host.id];
  return !!(info && info.k8s && info.k8s.installed);
}

function deployEligibleHosts() {
  const allowInstalled = !!(S.deployForm && S.deployForm.force);
  return S.hosts.filter((h) => canDeployHost(h) && (allowInstalled || !hostHasKubernetes(h)));
}

function deployExcludedHosts() {
  return S.hosts.filter((h) => canDeployHost(h) && hostHasKubernetes(h));
}

function installedDeployTargets(ids) {
  return ids.map((id) => findHost(id)).filter((host) => host && hostHasKubernetes(host));
}

function ensureDeployForm() {
  if (!S.deployForm) S.deployForm = { serverIds: [], agentIds: [] };
  if (!Array.isArray(S.deployForm.serverIds)) S.deployForm.serverIds = [];
  if (!Array.isArray(S.deployForm.agentIds)) S.deployForm.agentIds = [];
  if (typeof S.deployForm.force !== 'boolean') S.deployForm.force = false;
  if (!S.deployForm.installMode) S.deployForm.installMode = 'online';
  if (typeof S.deployForm.mirror !== 'boolean') {
    const configuredMirror = S.config && S.config.k3s ? S.config.k3s.mirror : 'cn';
    S.deployForm.mirror = !!configuredMirror;
    S.deployForm.mirrorConfig = configuredMirror;
  }
  const latestMirror = S.config && S.config.k3s ? S.config.k3s.mirror : 'cn';
  if (S.deployForm.mirrorConfig !== latestMirror) {
    S.deployForm.mirror = !!latestMirror;
    S.deployForm.mirrorConfig = latestMirror;
  }
  if (typeof S.deployForm.offlinePackageId !== 'string') S.deployForm.offlinePackageId = '';
  const eligible = deployEligibleHosts();
  const ids = new Set(eligible.map((h) => h.id));
  S.deployForm.serverIds = S.deployForm.serverIds.filter((id) => ids.has(id));
  S.deployForm.agentIds = S.deployForm.agentIds.filter((id) => ids.has(id) && !S.deployForm.serverIds.includes(id));
  return S.deployForm;
}

function deployCenterHead(active) {
  const tab = DEPLOY_TABS.includes(active) ? active : 'install';
  const meta = DEPLOY_TAB_META[tab];
  return `<div class="view-head" style="margin-bottom:12px">
    <div>
      <div class="view-crumb">部署中心<span>/</span>${meta.label}</div>
      <h2>${meta.label}</h2><p>${meta.desc}</p>
    </div>
  </div>
  <div class="deploy-subswitch">
    ${DEPLOY_TABS.map((item) => `<button class="${item === tab ? 'active' : ''}" data-action="deploy-tab" data-tab="${item}">${DEPLOY_TAB_META[item].label}</button>`).join('')}
  </div>`;
}

function deployTargetHosts() {
  return S.hosts.filter((host) => clusterCapable(host));
}

function deployTargetHost() {
  const host = activeHost();
  if (host && clusterCapable(host)) return host;
  return deployTargetHosts()[0] || null;
}

// ---------------------------------------------------------------- 组件与镜像页

const COMPONENT_SUBTABS = [
  { id: 'components', label: '组件管理', ico: 'box', desc: 'Helm 插件按用途分类，点安装后再选服务器' },
  { id: 'images', label: '镜像管理', ico: 'layers', desc: '常用基础镜像，点拉取后再选服务器' },
  { id: 'node-images', label: '查看服务器内镜像', ico: 'server', desc: '按服务器查看、导入、导出、删除节点镜像' }
];

function componentSubTabOf(value) {
  return COMPONENT_SUBTABS.some((tab) => tab.id === value) ? value : 'components';
}

function goComponentsTab(tab) {
  S.componentsTab = componentSubTabOf(tab);
  goDeployTab('components');
}

function componentSubTabsHTML(active) {
  return `<div class="panel-tabs" role="tablist" aria-label="组件与镜像子页签">
    ${COMPONENT_SUBTABS.map((tab) => `<button class="panel-tab ${tab.id === active ? 'active' : ''}" role="tab" aria-selected="${tab.id === active}" data-action="components-subtab" data-tab="${tab.id}" title="${esc(tab.desc)}">${icon(tab.ico)} ${esc(tab.label)}</button>`).join('')}
  </div>`;
}

// 节点级操作可用的服务器：kubeconfig 接入没有节点，读不了也拉不了镜像
function deployNodeHosts() {
  return S.hosts.filter((host) => (host.transport || 'ssh') !== 'kubeconfig');
}

function hostIsK3s(host) {
  const k8s = host && S.detected[host.id] ? S.detected[host.id].k8s : null;
  return !!(k8s && k8s.flavor === 'k3s');
}

// 插件安装只认 k3s；镜像拉取走 k3s ctr，也优先 k3s 节点（读取到之前先全给出）
function deployOperationPool() {
  const all = deployNodeHosts();
  const k3s = all.filter(hostIsK3s);
  return k3s.length ? k3s : all;
}

function pickInitialHostIds(pool) {
  const active = activeHost();
  if (active && pool.some((host) => host.id === active.id)) return [active.id];
  return pool.length ? [pool[0].id] : [];
}

// HelmChart 是集群级资源：同一个集群只需要装一次
function dedupeHostsByCluster(hosts) {
  const seen = new Set();
  const targets = [];
  for (const host of hosts || []) {
    const key = detectedClusterKey(host) || `host:${host.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(host);
  }
  return targets;
}

// 「查看服务器内镜像」：一次只查看一台服务器，切换后重新读取该节点的镜像
function nodeImagePool() {
  return deployOperationPool();
}

function nodeImageHost() {
  const pool = nodeImagePool();
  if (!pool.length) return null;
  return pool.find((host) => host.id === S.hostImageTarget) || pool.find((host) => host.id === S.activeHostId) || pool[0];
}

function nodeImageBarHTML(extra = '') {
  const pool = nodeImagePool();
  const current = nodeImageHost();
  const options = pool.length
    ? pool.map((host) => `<option value="${esc(host.id)}" ${current && current.id === host.id ? 'selected' : ''}>${esc(hostName(host))}${hostIsK3s(host) ? '' : '（未检测到 k3s）'}</option>`).join('')
    : '<option value="">没有可用的服务器</option>';
  return `<div class="deploy-target">
    <span class="deploy-target-label">${icon('server')} 服务器</span>
    <select class="select" id="nodeImageHostSelect" aria-label="选择要查看镜像的服务器" ${pool.length ? '' : 'disabled'}>${options}</select>
    ${extra}
    <span class="tiny dim">共 ${pool.length} 台可查看</span>
  </div>`;
}

function renderDeploy() {
  maybeAutoDetect();
  let tab = S.deployTab || 'install';
  if (!DEPLOY_TABS.includes(tab)) tab = 'install';
  S.deployTab = tab;
  if (tab === 'install') return renderK8sInstall();
  if (tab === 'components') return renderDeployComponents();
  if (tab === 'custom') return renderDeployCustom();
  return renderDeployUpgrade();
}

function renderDeployUpgrade() {
  const view = $('#view');
  const candidates = S.hosts.filter((h) => (h.transport || 'ssh') !== 'kubeconfig'
    && S.detected[h.id] && S.detected[h.id].k8s && S.detected[h.id].k8s.installed
    && S.detected[h.id].k8s.flavor === 'k3s');
  const preferred = activeHost() ? activeHost().id : '';
  if (!candidates.some((h) => h.id === S.deployUpgradeHost)) {
    S.deployUpgradeHost = candidates.some((h) => h.id === preferred) ? preferred : (candidates.length ? candidates[0].id : '');
  }
  const host = findHost(S.deployUpgradeHost);
  const info = host ? S.detected[host.id] : null;
  const k8s = info && info.k8s ? info.k8s : {};
  const isAgent = k8s.role === 'agent';
  const masters = candidates.filter((h) => {
    const d = S.detected[h.id];
    // 只能选同一集群的控制平面：别的集群看不到这台节点，确认阶段必然超时
    return d && d.k8s && d.k8s.role !== 'agent' && sameCluster(host, h);
  });
  const version = (k8s.version || '').replace('k3s version ', '').replace(/\s*\(.*\)$/, '');

  const pending = S.hosts.some((h) => !S.detected[h.id] || (S.detected[h.id] && S.detected[h.id].loading));
  const form = !candidates.length
    ? (pending
      ? `<div class="alert info">${icon('refresh')}<div>正在读取服务器与 k3s 版本，请稍候…</div></div>`
      : `<div class="alert warn">${icon('alert')}<div>还没有读取到可升级的 k3s 节点。请先在“服务器”页面重新读取服务器信息，kubeconfig 纳管的入口不能执行升级。</div></div>`)
    : `<div class="form-grid" style="margin-top:4px">
        <label class="field full">升级节点
          <select class="select" id="upHost">
            ${candidates.map((h) => {
              const d = S.detected[h.id];
              const v = (d.k8s.version || '').replace('k3s version ', '').replace(/\s*\(.*\)$/, '');
              return `<option value="${esc(h.id)}" ${h.id === host.id ? 'selected' : ''}>${esc(hostName(h))} · ${esc(hostAddress(h))} · ${esc(v || '版本未知')}</option>`;
            }).join('')}
          </select>
        </label>
        <div class="full row" style="gap:10px">
          ${badge(isAgent ? '工作节点' : '控制平面', isAgent ? 'cyan' : 'purple')}
          ${badge(version || '版本未知', 'neutral')}
          <span class="hint">当前节点版本</span>
        </div>
        ${isAgent ? (masters.length ? `<label class="field full">用于确认升级结果的主节点
          <select class="select" id="upMaster">
            <option value="">自动选择同集群控制平面</option>
            ${masters.map((m) => `<option value="${esc(m.id)}">${esc(hostName(m))} · ${esc(hostAddress(m))}</option>`).join('')}
          </select>
          <span class="help">升级完成后用它查询该节点是否 Ready，所以只能选同一集群的控制平面。</span>
        </label>` : `<div class="full alert warn">${icon('alert')}<div>没有读到与 <b>${esc(hostName(host))}</b> 同集群的控制平面，升级后无法确认节点状态。请先把该集群的控制平面加入服务器列表并重新读取。</div></div>`) : ''}
        <label class="field">目标版本
          <input class="input" id="upVersion" placeholder="例如 v1.31.4+k3s1" />
          <span class="help">必须填写完整版本号；升级脚本会保留现有 k3s 启动参数。</span>
        </label>
        <label class="field">更新通道
          <select class="select" id="upChannel">
            <option value="stable">stable</option>
            <option value="latest">latest</option>
            <option value="testing">testing</option>
          </select>
        </label>
        <div class="full alert warn">${icon('alert')}<div>升级会重启 k3s 服务。高可用集群请一次只升级一个控制平面，等待该节点 Ready 后再升级下一台；升级前请确认 etcd 健康且有备份。</div></div>
        <div class="full row">
          <button class="btn primary" data-action="upgrade-start"${isAgent && !masters.length ? ' disabled title="没有同集群的控制平面，无法确认升级结果"' : ''}>${icon('rocket')} 开始升级该节点</button>
          <span class="spacer"></span>
          <span class="hint">仅支持 k3s</span>
        </div>
      </div>`;

  view.innerHTML = `${DEMO ? demoBanner() : ''}${deployCenterHead('upgrade')}
    <div class="deploy-layout">
      <div class="card">
        <div class="card-head"><h3>${icon('refresh')} 升级现有 k3s</h3><span class="hint">逐台执行</span></div>
        <div class="card-body">${form}</div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-head"><h3>升级顺序</h3></div>
          <div class="card-body small muted" style="line-height:1.9">
            <div>· 单机集群：直接升级唯一节点，期间 API 会短暂中断。</div>
            <div>· 3 / 5 台控制平面：逐台升级，不要同时重启多台。</div>
            <div>· 工作节点最后升级，避免业务 Pod 同时漂移。</div>
            <div>· 升级失败不会自动回滚，操作日志会保留原始输出。</div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>还没有集群？</h3></div>
          <div class="card-body">
            <p class="small muted" style="margin-top:0;line-height:1.8">全新安装 k3s 单机或 3 / 5 台高可用集群，请打开「k3s 安装/卸载」页签的安装页面。</p>
            <button class="btn" data-action="goto-install">${icon('plus')} 安装 k3s 集群</button>
          </div>
        </div>
      </div>
    </div>`;

  const sel = $('#upHost');
  if (sel) sel.addEventListener('change', () => { S.deployUpgradeHost = sel.value; renderView(); });
}

async function startUpgrade() {
  const host = findHost(S.deployUpgradeHost);
  if (!host) { toast('请选择要升级的节点', 'error'); return; }
  const info = S.detected[host.id];
  const k8s = info && info.k8s ? info.k8s : {};
  const version = ($('#upVersion') || {}).value ? $('#upVersion').value.trim() : '';
  if (!version) { toast('请填写目标版本，例如 v1.31.4+k3s1', 'error'); return; }
  const role = k8s.role === 'agent' ? 'agent' : 'server';
  if (role === 'agent' && !$('#upMaster')) {
    toast('没有读到同集群的控制平面，无法确认升级结果；请先读取该集群的控制平面', 'error');
    return;
  }
  const masterId = role === 'agent' && $('#upMaster') ? $('#upMaster').value : '';
  const current = (k8s.version || '').replace('k3s version ', '').replace(/\s*\(.*\)$/, '') || '版本未知';
  const ok = await confirmDialog({
    title: '升级 k3s 节点',
    message: `即将把 <b>${esc(hostName(host))}</b> 从 <b>${esc(current)}</b> 升级到 <b>${esc(version)}</b>。升级会重启 k3s 服务，期间节点可能短暂不可用。${role === 'server' ? '<br><br><b>如果是高可用控制平面，请确认其他控制面健康后再继续。</b>' : ''}`,
    confirmText: '开始升级',
    danger: true
  });
  if (!ok) return;
  try {
    const data = await api(`/hosts/${encodeURIComponent(host.id)}/upgrade`, {
      method: 'POST',
      body: { role, options: { version, channel: ($('#upChannel') || {}).value || 'stable', masterId } }
    });
    openJobModal(data.jobId);
    refreshJobs();
    toast('升级操作已启动', 'success');
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

function k3sPageSwitchHTML(active) {
  const current = active === 'uninstall' ? 'uninstall' : 'install';
  return `<div class="k3s-page-switch" role="tablist" aria-label="k3s 安装或卸载">
    <button role="tab" aria-selected="${current === 'install'}" class="${current === 'install' ? 'active' : ''}" data-action="k3s-page" data-page="install">${icon('rocket')} 安装 k3s</button>
    <button role="tab" aria-selected="${current === 'uninstall'}" class="${current === 'uninstall' ? 'active' : ''}" data-action="k3s-page" data-page="uninstall">${icon('power')} 卸载 k3s</button>
  </div>`;
}

function renderK8sInstall() {
  if (S.k3sPage === 'uninstall') return renderK3sUninstall();
  const view = $('#view');
  const form = ensureDeployForm();
  const eligible = deployEligibleHosts();
  const excluded = deployExcludedHosts();
  const excludedPreview = excluded.slice(0, 4).map((h) => hostName(h)).join('、');
  const servers = eligible.filter((h) => form.serverIds.includes(h.id));
  const serverCount = servers.length;
  const serverOk = [1, 3, 5].includes(serverCount);
  const haMode = serverCount === 3 || serverCount === 5;
  const agentHosts = eligible.filter((h) => form.agentIds.includes(h.id));
  const deployTargets = [...servers, ...agentHosts];
  let offlinePkg = offlinePackageById(form.offlinePackageId);
  if (!offlinePackageCompatible(offlinePkg, deployTargets)) {
    form.offlinePackageId = defaultOfflinePackageId(deployTargets);
    offlinePkg = offlinePackageById(form.offlinePackageId);
  }
  const offline = form.installMode === 'offline';
  const mirrorUrl = String((S.config && S.config.k3s && S.config.k3s.mirrorUrl) || 'https://rancher-mirror.rancher.cn/k3s').trim();

  view.innerHTML = `${DEMO ? demoBanner() : ''}${deployCenterHead('install')}${k3sPageSwitchHTML('install')}
    <div class="deploy-layout">
      <div class="card">
        <div class="card-head"><h3>${icon('rocket')} 新建 k3s 集群</h3><span class="hint">1 台单机 / 3 或 5 台高可用</span></div>
        <div class="card-body">
          ${!eligible.length ? `<div class="alert warn">${icon('alert')}<div>${excluded.length
            ? `当前 ${excluded.length} 台可部署服务器都已安装 Kubernetes，已从安装列表排除。需要重装已有节点，请到服务器页对目标机器使用“安装 / 加入”，或点击下方“强制重装已安装节点”后再确认。`
            : '还没有可用于部署的服务器。请先在“服务器”页面添加 SSH 或本地主机。'}</div></div>
            <div class="row" style="margin-top:12px">
              ${excluded.length ? `<button class="btn" data-action="deploy-force-show">${icon('alert')} 强制重装已安装节点</button>` : ''}
              <button class="btn primary" data-action="host-add">${icon('plus')} 添加服务器</button>
            </div>`
          : `
          ${excluded.length ? (form.force
            ? `<div class="alert warn" style="margin-bottom:14px">${icon('alert')}<div>已勾选“强制重装”：${excluded.length} 台已安装 Kubernetes 的服务器也会出现在列表中${excludedPreview ? `（${esc(excludedPreview)}${excluded.length > 4 ? ' 等' : ''}）` : ''}。部署会覆盖现有 k3s 配置；如果不是明确要重建，请取消勾选并到服务器页处理。</div></div>`
            : `<div class="alert info" style="margin-bottom:14px">${icon('server')}<div>已自动排除 ${excluded.length} 台已安装 Kubernetes 的服务器${excludedPreview ? `（${esc(excludedPreview)}${excluded.length > 4 ? ' 等' : ''}）` : ''}。新建集群只显示未安装节点；需要重装已有节点，请先勾选“强制重装”或到服务器页使用“安装 / 加入”。</div></div>`)
            : ''}
          <div class="form-grid" style="margin-top:16px">
            <div class="full row" style="gap:8px;align-items:center">
              <button class="btn sm" data-action="deploy-pick-hosts">${icon('server')} 选择多台服务器</button>
              <span class="tiny dim">打开服务器选择器批量选择；也可直接勾选下方卡片</span>
            </div>
            <div class="full">
              <div class="tiny dim" style="margin-bottom:8px;letter-spacing:.6px">控制平面（1 台单机，或 3 / 5 台高可用）<span class="req">*</span></div>
              <div class="agent-picker">
                ${eligible.map((h) => {
                  const existing = hostHasKubernetes(h);
                  return `<label class="agent-option">
                    <input type="checkbox" data-deploy-server value="${esc(h.id)}" ${form.serverIds.includes(h.id) ? 'checked' : ''} />
                    <div style="min-width:0">
                      <div style="font-size:12px;font-weight:550">${esc(hostName(h))}</div>
                      <div class="tiny dim mono">${esc(hostAddress(h))}</div>
                    </div>
                    ${existing ? badge('已有集群', 'warn') : hostStatusBadge(h)}
                  </label>`;
                }).join('')}
              </div>
              <div class="tiny" style="margin-top:8px;color:${serverOk ? 'var(--muted)' : 'var(--err)'}">
                已选 ${serverCount} 台${serverCount === 1 ? ' · 单机控制平面，可添加工作节点' : haMode ? ` · etcd 可容忍 ${Math.floor((serverCount - 1) / 2)} 台故障` : ' · 需要 1 台单机或 3 / 5 台高可用'}
              </div>
              <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px">
                <span class="tiny dim" style="letter-spacing:.6px">数据存储</span>
                <span class="badge ${haMode ? 'purple' : serverCount === 1 ? 'info' : 'neutral'}">${serverCount === 1 ? 'SQLite（单机）' : haMode ? `内嵌 etcd（${serverCount} 节点）` : '需要 1 / 3 / 5 台控制平面'}</span>
                <span class="tiny dim">etcd 由 k3s 内嵌管理，不是可勾选组件</span>
              </div>
            </div>
            <div class="full">
              <div class="tiny dim" style="margin-bottom:8px;letter-spacing:.6px">工作节点（可选，多选）</div>
              <div class="agent-picker">
                ${eligible.filter((h) => !form.serverIds.includes(h.id)).map((h) => {
                  const existing = hostHasKubernetes(h);
                  return `<label class="agent-option">
                    <input type="checkbox" data-deploy-agent value="${esc(h.id)}" ${form.agentIds.includes(h.id) ? 'checked' : ''} />
                    <div style="min-width:0">
                      <div style="font-size:12px;font-weight:550">${esc(hostName(h))}</div>
                      <div class="tiny dim mono">${esc(hostAddress(h))}</div>
                    </div>
                    ${existing ? badge('已有集群', 'warn') : hostStatusBadge(h)}
                  </label>`;
                }).join('') || '<div class="tiny dim">没有其他可选节点；控制平面默认也承载业务。</div>'}
              </div>
            </div>
          </div>
          ${eligible.length < 3 ? `<div class="alert info" style="margin-top:14px">${icon('server')}<div>高可用集群至少需要 3 台控制平面；不足 3 台时，可选择 1 台作为单机控制平面，其余勾选为工作节点。</div></div>` : ''}

          <div class="divider" style="margin:16px 0"></div>

          <div id="deployOptions">
            <div class="form-grid">
              <div class="full">
                <div class="tiny dim" style="margin-bottom:6px;letter-spacing:.6px">安装方式</div>
                <div class="row" style="gap:18px;align-items:center;flex-wrap:wrap">
                  <label class="check"><input type="radio" name="depInstallMode" value="online" ${form.installMode === 'offline' ? '' : 'checked'} /> 在线安装（下载 k3s）</label>
                  <label class="check"><input type="radio" name="depInstallMode" value="offline" ${form.installMode === 'offline' ? 'checked' : ''} /> 离线安装（使用预置安装包）</label>
                </div>
              </div>
              <label class="field full ${offline ? '' : 'hidden'}" id="depOfflineWrap">离线安装包
                <div class="row" style="gap:8px;align-items:center;flex-wrap:wrap">
                  <select class="select" id="depOfflinePackage" style="flex:1 1 320px;min-width:220px" ${S.offlinePackages.length ? '' : 'disabled'}>
                    ${offlinePackageOptions(form.offlinePackageId, deployTargets)}
                  </select>
                  <button class="btn sm ghost" data-action="offline-refresh" title="重新扫描 packages/ 目录">${icon('refresh')} 重新扫描</button>
                </div>
                <span class="help">从控制端 <span class="code-inline">packages/</span> 预置的安装包中选择：支持解压目录或 <span class="code-inline">.tar.gz</span> 归档。部署时自动上传到选中的每台服务器；归档会在本地临时解压，上传完成后立即清理本地临时文件。离线模式下每 10 秒自动扫描一次。</span>
                <span class="help ${S.offlinePackagesError ? '' : 'hidden'}" id="depOfflineError" style="color:var(--err)">${esc(S.offlinePackagesError || '')}</span>
                <span class="help ${S.offlinePackages.length ? 'hidden' : ''}" id="depOfflineEmpty" style="color:var(--err)">未找到离线包。请在项目 packages/ 下准备目录，包含 k3s、k3s-airgap-images-&lt;arch&gt;.tar、install.sh。</span>
                <div id="depOfflineInfo">${offlinePackageInfo(offlinePkg)}</div>
              </label>
              <label class="field">k3s 版本
                <input class="input" id="depVersion" value="${offline ? esc(offlinePkg ? offlinePkg.version : '') : ''}" ${offline ? 'disabled' : ''} placeholder="留空安装最新稳定版" />
                <span class="help">${offline ? '离线安装的版本由所选安装包固定。' : 'cgroup v1 旧内核会自动使用兼容版本 v1.34.1+k3s1。'}</span>
              </label>
              <label class="field">更新通道
                <select class="select" id="depChannel" ${offline ? 'disabled' : ''}>
                  <option value="stable">stable</option>
                  <option value="latest">latest</option>
                  <option value="testing">testing</option>
                </select>
              </label>
              <label class="field full">集群 Token（可选）
                <input class="input" id="depToken" placeholder="留空自动生成，或使用 config.json 中的 clusterToken" />
                <span class="help">工作节点会自动从主节点读取 Token，无需填写。</span>
              </label>
              <label class="field full">附加参数（每行一个）
                <textarea class="textarea" id="depFlags" rows="2" placeholder="--kubelet-arg=max-pods=150&#10;--node-label=env=prod"></textarea>
              </label>
              <div class="full">
                ${componentChecklistHTML()}
              </div>
              <div class="full row" style="gap:18px">
                ${offline ? '' : `<label class="check" title="镜像源：${esc(mirrorUrl)}"><input type="checkbox" id="depMirror" ${form.mirror ? 'checked' : ''} /> 国内镜像源</label>`}
                <label class="check" title="默认只允许未安装 Kubernetes 的服务器；勾选后已安装节点也会出现，部署会覆盖现有 k3s 配置"><input type="checkbox" id="depForce" ${form.force ? 'checked' : ''} /> 强制重装</label>
              </div>
              ${offline ? '' : `<div class="full tiny dim" style="margin-top:-4px">镜像源：<span class="code-inline">${esc(mirrorUrl)}</span> · 可在 config.json 的 <span class="code-inline">k3s.mirrorUrl</span> 修改</div>`}
            </div>
          </div>

          <div class="alert warn" style="margin-top:16px">${icon('alert')}<div>部署会在目标节点安装系统组件并写入配置。若节点上已有 <b>业务数据或自建集群</b>，请勾选“强制重装”前先确认可覆盖，或改用“纳管已有集群”。</div></div>

          <div class="row" style="margin-top:16px">
            <button class="btn" data-action="deploy-preflight">${icon('shield')} 部署前预检</button>
            <button class="btn" data-action="host-add">${icon('plus')} 添加节点</button>
            <span class="spacer"></span>
            <button class="btn primary lg" data-action="deploy-start">${icon('rocket')} 开始部署</button>
          </div>`}
        </div>
      </div>

      <div class="stack">
        <div class="card">
          <div class="card-head"><h3>安装后</h3></div>
          <div class="card-body small muted" style="line-height:1.9">
            <div>· 数据存储：单机默认 SQLite，3 / 5 台控制平面自动使用内嵌 etcd；etcd 不在此处勾选，当前不接外部 etcd。</div>
            <div>· k3s 默认使用 <span class="code-inline">stable</span> 通道；取消勾选预装组件会自动使用 <span class="code-inline">--disable</span> 关闭对应内置组件。</div>
            <div>· 工作节点需要通过主节点的 6443 端口加入集群。</div>
            <div>· 部署过程可在“操作记录”查看实时日志，失败不会自动回滚。</div>
            <div>· 离线安装：从项目 <span class="code-inline">packages/</span> 选择预置安装包，控制台会自动上传到选中的服务器；不会访问外网。</div>
            <div>· 已有集群加工作节点：在服务器页对该节点选择“工作节点”安装，需要主节点 Token；控制平面扩容暂不支持。</div>
          </div>
        </div>
        <div class="card">
          <div class="card-head"><h3>单机 / 小规模</h3></div>
          <div class="card-body">
            <p class="small muted" style="margin-top:0;line-height:1.8">只选 1 台控制平面即为单机集群，其余节点可勾选为工作节点；单机也可以从服务器详情安装。</p>
            <button class="btn" data-action="goto-hosts">${icon('server')} 前往服务器</button>
          </div>
        </div>
      </div>
    </div>`;

  $$('[data-deploy-server]').forEach((el) => {
    el.addEventListener('change', () => {
      const set = new Set(form.serverIds);
      if (el.checked) set.add(el.value); else set.delete(el.value);
      form.serverIds = Array.from(set);
      form.agentIds = form.agentIds.filter((id) => !form.serverIds.includes(id));
      renderView();
    });
  });
  $$('[data-deploy-agent]').forEach((el) => {
    el.addEventListener('change', () => {
      const set = new Set(form.agentIds);
      if (el.checked) set.add(el.value); else set.delete(el.value);
      form.agentIds = Array.from(set);
    });
  });
  $$('input[name="depInstallMode"]').forEach((el) => {
    el.addEventListener('change', () => {
      form.installMode = el.value === 'offline' ? 'offline' : 'online';
      renderView();
      if (form.installMode === 'offline') pollOfflinePackages();
    });
  });
  const offlinePackage = $('#depOfflinePackage');
  if (offlinePackage) {
    offlinePackage.addEventListener('change', () => {
      form.offlinePackageId = offlinePackage.value;
      const pkg = offlinePackageById(offlinePackage.value);
      const version = $('#depVersion');
      if (version) version.value = pkg ? pkg.version || '' : '';
      const info = $('#depOfflineInfo');
      if (info) info.innerHTML = offlinePackageInfo(pkg);
    });
  }
  const forceEl = $('#depForce');
  if (forceEl) {
    forceEl.addEventListener('change', () => {
      form.force = forceEl.checked;
      const allowed = new Set(deployEligibleHosts().map((h) => h.id));
      form.serverIds = form.serverIds.filter((id) => allowed.has(id));
      form.agentIds = form.agentIds.filter((id) => allowed.has(id) && !form.serverIds.includes(id));
      renderView();
    });
  }
  const mirrorEl = $('#depMirror');
  if (mirrorEl) {
    mirrorEl.addEventListener('change', () => { form.mirror = mirrorEl.checked; });
  }
}

function k3sUninstallHosts() {
  return S.hosts.filter((host) => {
    if (!canDeployHost(host)) return false;
    const info = S.detected[host.id];
    const k8s = (info && info.k8s) || {};
    return !!(info && info.reachable && k8s.installed && (!k8s.flavor || k8s.flavor === 'k3s'));
  });
}

function k3sUninstallExcludedHosts() {
  return S.hosts.filter((host) => {
    if (!canDeployHost(host)) return false;
    const info = S.detected[host.id];
    const k8s = (info && info.k8s) || {};
    return !!(info && info.reachable && k8s.installed && k8s.flavor && k8s.flavor !== 'k3s');
  });
}

function k3sUninstallHostInfo(host) {
  const info = S.detected[host.id] || {};
  const k8s = info.k8s || {};
  const role = k8s.role === 'agent' || k8s.role === 'worker'
    ? '工作节点'
    : (k8s.role === 'server' || k8s.role === 'control-plane' || k8s.role === 'master')
      ? '控制平面 / 单机'
      : 'k3s 节点';
  return `<div class="stack" style="gap:8px">
    <div class="row" style="justify-content:space-between;gap:8px">
      <b>${esc(hostName(host))}</b>
      ${badge(role, 'neutral')}
    </div>
    <div class="mono tiny dim">${esc(hostAddress(host))}</div>
    <div class="row" style="gap:8px;flex-wrap:wrap">
      ${badge(k8s.version || '版本未知', 'purple')}
      ${hostStatusBadge(host)}
    </div>
  </div>`;
}

function setK3sPage(page) {
  const next = page === 'uninstall' ? 'uninstall' : 'install';
  if (S.k3sPage === next) return;
  S.k3sPage = next;
  renderView();
}

// 卸载确认口令：不区分大小写、忽略首尾空格
const UNINSTALL_CONFIRM_TEXT = 'uninstall';

function isUninstallConfirmed(value) {
  return String(value || '').trim().toLowerCase() === UNINSTALL_CONFIRM_TEXT;
}

// 卸载目标多选：只允许同一 k3s 集群内的服务器（集群归属由检测到的节点列表判定）
function k3sUninstallSelectedIds() {
  const targets = k3sUninstallHosts();
  const known = new Map(targets.map((host) => [host.id, host]));
  const raw = (Array.isArray(S.k3sUninstallHostIds) ? S.k3sUninstallHostIds : []).filter((id) => known.has(id));
  if (!raw.length) return [];
  const first = known.get(raw[0]);
  const kept = raw.filter((id) => id === first.id || sameCluster(first, known.get(id)));
  S.k3sUninstallHostIds = kept;
  return kept;
}

function k3sUninstallRoleRank(host) {
  const k8s = ((S.detected[host.id] || {}).k8s) || {};
  const role = k8s.role;
  if (role === 'agent' || role === 'worker') return 0;
  return 1;
}

function k3sUninstallListState() {
  return {
    hosts: k3sUninstallHosts(),
    selected: new Set(k3sUninstallSelectedIds()),
    allowMixed: false,
    strictCluster: true
  };
}

function k3sUninstallListHTML() {
  const state = k3sUninstallListState();
  const count = state.selected.size;
  const note = count > 1
    ? `已选 ${count} 台（同一集群），会按「工作节点 → 控制平面」的顺序逐台卸载。`
    : count === 1
      ? '已选 1 台；继续勾选时只能选同一集群内的服务器。'
      : '可勾选多台，但必须是同一个 k3s 集群内的服务器。';
  // 按集群分组展示，跨集群的卡片会被禁用，避免选错
  const groups = new Map();
  for (const host of state.hosts) {
    const key = detectedClusterKey(host) || `single:${host.id}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(host);
  }
  const groupList = [...groups.entries()];
  const showCaption = groupList.length > 1;
  return `<div class="row" style="justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px">
      <span class="tiny dim">${esc(note)}</span>
      <span class="tiny dim" id="k3sUninstallCount">${count} 台已选</span>
    </div>
    <div class="picker-list" id="k3sUninstallList" style="max-height:330px">
      ${groupList.map(([, hosts]) => {
        const caption = hosts[0];
        const info = S.detected[caption.id] || {};
        const nodes = (Array.isArray(info.nodes) ? info.nodes : []).map((n) => n.name).filter(Boolean);
        const label = nodes.length
          ? `集群 · ${nodes.slice(0, 4).join(', ')}${nodes.length > 4 ? '…' : ''}（${nodes.length} 个节点）`
          : `集群 · ${hostName(caption)}`;
        return `${showCaption ? `<div class="tiny dim" style="padding:2px 2px 6px;letter-spacing:.4px">${esc(label)}</div>` : ''}
          ${hosts.map((host) => hostPickerCardHTML(host, state)).join('')}`;
      }).join('')}
    </div>`;
}

function renderK3sUninstall() {
  const view = $('#view');
  const targets = k3sUninstallHosts();
  const excluded = k3sUninstallExcludedHosts();
  const selectedIds = targets.length ? k3sUninstallSelectedIds() : [];
  const selected = targets.filter((host) => selectedIds.includes(host.id));
  const excludedText = excluded.length
    ? `另有 ${excluded.length} 台已安装外部 Kubernetes / kubeadm 的服务器不会出现在列表中，避免误删共享的 kubelet 与容器运行时。`
    : '';
  const summary = selected.length > 1
    ? `<div class="alert warn" style="margin-bottom:12px">${icon('alert')}<div>即将卸载 <b>${selected.length} 台</b>服务器上的 k3s：${selected.map((host) => esc(hostName(host))).join('、')}。这是不可逆操作，集群数据、证书和 K3s 内置 etcd 数据都会被删除。</div></div>`
    : `<div class="alert err" style="margin-bottom:12px">${icon('alert')}<div>即将卸载${selected.length === 1 ? ` <b>${esc(hostName(selected[0]))}</b> ` : ''}服务器上的 k3s。这是不可逆操作，集群数据、证书和 K3s 内置 etcd 数据都会被删除。</div></div>`;

  view.innerHTML = `${DEMO ? demoBanner() : ''}${deployCenterHead('install')}${k3sPageSwitchHTML('uninstall')}
    <div class="deploy-layout">
      <div class="card">
        <div class="card-head"><h3>${icon('power')} 卸载现有 k3s</h3>
          <div class="row" style="gap:8px">
            <span class="hint">不可逆操作</span>
            <button class="icon-btn" data-action="detect-all" title="重新读取服务器信息">${icon('refresh')}</button>
          </div>
        </div>
        <div class="card-body">
          ${!targets.length ? `<div class="alert info">${icon('server')}<div>暂未读取到可卸载的 k3s 服务器。请确认服务器已安装 k3s，并重新读取服务器信息；如果还没有服务器，请先在“服务器”页面添加。${excluded.length ? `<br>${esc(excludedText)}` : ''}</div></div>
            <div class="row" style="margin-top:12px">
              <button class="btn" data-action="detect-all">${icon('refresh')} 全部重新读取</button>
              <button class="btn primary" data-action="host-add">${icon('plus')} 添加服务器</button>
            </div>`
          : `<div class="field">
              <span class="field-label">目标服务器（可多选，仅限同一集群）</span>
              <div id="k3sUninstallTargets">${k3sUninstallListHTML()}</div>
              <span class="help">仅列出已安装 k3s 且可远程操作的服务器。${esc(excludedText)}</span>
            </div>
            <div id="k3sUninstallSummary" style="margin:12px 0 14px">${summary}</div>
            <label class="check" style="margin:8px 0 8px"><input type="checkbox" id="k3sUninstallDeep" checked /> 深度清理残留（推荐）</label>
            <div class="note-box">
              <div class="note-title">${icon('trash')} 勾选后会额外清理</div>
              <ul>
                <li>systemd 备份与 drop-in 配置</li>
                <li><span class="code-inline">/etc/rancher/node</span>、Pod 日志</li>
                <li>残留 CNI / 网络接口、IPVS 与 iptables / ip6tables 规则（含 nftables 残留检测）</li>
              </ul>
              <div class="note-safe">${icon('shield')}<span>不会删除外部 Docker / containerd、<span class="code-inline">/etc/kubernetes</span>、<span class="code-inline">/root/.kube</span>；外部日志目录（如 /home 下的软链目标）只移除软链，保留目标内容。</span></div>
            </div>
            <div class="row" style="margin-top:14px">
              <button class="btn danger" id="k3sUninstallStart" disabled>${icon('power')} 卸载</button>
            </div>`}
        </div>
      </div>
      <div class="stack">
        <div class="card">
          <div class="card-head"><h3>操作说明</h3></div>
          <div class="card-body small muted" style="line-height:1.9">
            <div>· 当前只支持卸载 k3s；外部 Kubernetes / kubeadm 集群请使用对应集群的清理流程。</div>
            <div>· 支持多选，但只能勾选同一个 k3s 集群内的服务器，避免误删其他集群。</div>
            <div>· 点击「卸载」后会在弹窗里二次确认：输入 <span class="code-inline">uninstall</span> 才会真正执行。</div>
            <div>· 多选时按「工作节点 → 控制平面」的顺序逐台卸载，单台失败不影响其余服务器。</div>
            <div>· 默认执行 k3s 官方卸载脚本，并追加深度清理；只清理 k3s 自身数据，不删除业务数据目录。</div>
            <div>· 卸载过程生成异步任务，可在弹窗或“操作记录”中查看实时日志，支持取消。</div>
            <div>· 卸载完成后建议重新读取服务器信息；如需重装，可回到“安装 k3s”页面。</div>
          </div>
        </div>
        ${selected.length ? `<div class="card">
          <div class="card-head"><h3>当前目标${selected.length > 1 ? `（${selected.length} 台）` : ''}</h3></div>
          <div class="card-body stack" style="gap:12px">${selected.map((host) => k3sUninstallHostInfo(host)).join('')}</div>
        </div>` : ''}
      </div>
    </div>`;

  if (targets.length) bindK3sUninstallPage();
}

function bindK3sUninstallPage() {
  const button = $('#k3sUninstallStart');
  const listWrap = $('#k3sUninstallTargets');
  if (!button || !listWrap) return;

  const syncButton = () => {
    const hasSelection = k3sUninstallSelectedIds().length > 0;
    button.disabled = button.dataset.busy === '1' || !hasSelection;
  };

  const toggle = (id) => {
    const current = k3sUninstallSelectedIds();
    const host = k3sUninstallHosts().find((item) => item.id === id);
    if (!host) return;
    let next;
    if (current.includes(id)) {
      next = current.filter((item) => item !== id);
    } else {
      // 只能追加同一集群的服务器
      if (current.length && !sameCluster(k3sUninstallHosts().find((item) => item.id === current[0]), host)) {
        toast('只能选择同一个 k3s 集群内的服务器', 'error');
        return;
      }
      next = [...current, id];
    }
    S.k3sUninstallHostIds = next;
    listWrap.innerHTML = k3sUninstallListHTML();
    const ids = k3sUninstallSelectedIds();
    const selectedHosts = k3sUninstallHosts().filter((item) => ids.includes(item.id));
    const summary = $('#k3sUninstallSummary');
    if (summary) {
      summary.innerHTML = selectedHosts.length > 1
        ? `<div class="alert warn" style="margin-bottom:12px">${icon('alert')}<div>即将卸载 <b>${selectedHosts.length} 台</b>服务器上的 k3s：${selectedHosts.map((host) => esc(hostName(host))).join('、')}。这是不可逆操作，集群数据、证书和 K3s 内置 etcd 数据都会被删除。</div></div>`
        : `<div class="alert err" style="margin-bottom:12px">${icon('alert')}<div>即将卸载${selectedHosts.length === 1 ? ` <b>${esc(hostName(selectedHosts[0]))}</b> ` : ''}服务器上的 k3s。这是不可逆操作，集群数据、证书和 K3s 内置 etcd 数据都会被删除。</div></div>`;
    }
    syncButton();
  };

  listWrap.addEventListener('click', (event) => {
    const card = event.target.closest('[data-picker-host]');
    if (!card || card.classList.contains('disabled')) return;
    toggle(card.dataset.pickerHost);
  });
  listWrap.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const card = event.target.closest('[data-picker-host]');
    if (!card || card.classList.contains('disabled')) return;
    event.preventDefault();
    toggle(card.dataset.pickerHost);
  });

  button.addEventListener('click', openK3sUninstallConfirm);
  syncButton();
}

// 二次确认弹窗：列出目标服务器，输入 uninstall 后才会真正执行
function openK3sUninstallConfirm() {
  const ids = k3sUninstallSelectedIds();
  const selected = k3sUninstallHosts().filter((host) => ids.includes(host.id));
  if (!selected.length) {
    toast('请先勾选要卸载的服务器', 'error');
    return;
  }
  const ordered = selected.slice().sort((a, b) => k3sUninstallRoleRank(a) - k3sUninstallRoleRank(b));
  const deep = $('#k3sUninstallDeep');
  const deepClean = !deep || deep.checked;
  const inputId = `uninstall-confirm-${Date.now()}`;
  const rows = ordered.map((host) => {
    const role = k3sUninstallRoleRank(host) === 0 ? '工作节点' : '控制平面';
    return `<div class="row" style="justify-content:space-between;align-items:center;gap:10px">
      <span style="font-size:12px">${esc(hostName(host))}</span>
      ${badge(role)}
    </div>`;
  }).join('');

  openModal({
    title: '确认卸载 k3s',
    size: 'narrow',
    body: `
      <div class="alert err" style="margin-bottom:12px">${icon('alert')}<div>即将卸载 <b>${ordered.length} 台</b>服务器上的 k3s。这是不可逆操作，集群数据、证书和 K3s 内置 etcd 数据都会被删除。</div></div>
      <div class="stack" style="gap:6px;margin-bottom:14px">${rows}</div>
      <label class="field">
        <span class="field-label">输入 <span class="code-inline">uninstall</span> 执行卸载</span>
        <input class="input" id="${inputId}" autocomplete="off" spellcheck="false" placeholder="uninstall" />
        <span class="help">深度清理残留：<b style="color:var(--text)">${deepClean ? '已开启' : '已关闭'}</b>（可在页面勾选调整）；不区分大小写，首尾空格会自动忽略。</span>
      </label>`,
    foot: `<button class="btn ghost" data-close="1">取消</button>
           <button class="btn danger" id="uninstallConfirmGo" disabled>${icon('power')} 执行卸载</button>`,
    onMount(modal) {
      const input = $('#' + inputId, modal.el);
      const go = $('#uninstallConfirmGo', modal.el);
      if (!input || !go) return;
      const sync = () => { go.disabled = !isUninstallConfirmed(input.value); };
      input.addEventListener('input', sync);
      input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          if (!go.disabled) go.click();
        }
      });
      go.addEventListener('click', () => {
        if (go.disabled) return;
        closeModal();
        startK3sUninstall({ deepClean });
      });
      sync();
      setTimeout(() => input.focus(), 50);
    }
  });
}

// 已通过弹窗二次确认后执行：deepClean 由弹窗按当时页面上的勾选状态传入
async function startK3sUninstall(options = {}) {
  const targets = k3sUninstallHosts();
  const ids = k3sUninstallSelectedIds();
  const button = $('#k3sUninstallStart');
  const selected = targets.filter((host) => ids.includes(host.id));
  if (!selected.length) {
    toast('请先勾选要卸载的服务器', 'error');
    return;
  }
  if (button && button.dataset.busy === '1') return;

  // 先卸载工作节点、再卸载控制平面，避免集群 API 提前消失
  const ordered = selected.slice().sort((a, b) => k3sUninstallRoleRank(a) - k3sUninstallRoleRank(b));
  const deep = $('#k3sUninstallDeep');
  const deepClean = typeof options.deepClean === 'boolean' ? options.deepClean : (!deep || deep.checked);
  const originalHTML = button ? button.innerHTML : '';
  if (button) {
    button.dataset.busy = '1';
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span> 正在创建卸载任务`;
  }
  try {
    const data = ordered.length === 1
      ? await api(`/hosts/${encodeURIComponent(ordered[0].id)}/uninstall`, {
        method: 'POST',
        body: { confirm: UNINSTALL_CONFIRM_TEXT, deepClean }
      })
      : await api('/uninstall', {
        method: 'POST',
        body: { confirm: UNINSTALL_CONFIRM_TEXT, deepClean, hostIds: ordered.map((host) => host.id) }
      });
    S.k3sUninstallHostIds = [];
    if (button) {
      button.textContent = '已开始卸载';
      delete button.dataset.busy;
      button.disabled = true;
    }
    openJobModal(data.jobId, {
      onClose: () => { if (S.view === 'deploy' && S.k3sPage === 'uninstall') renderView(); }
    });
    toast(ordered.length > 1 ? `已开始卸载 ${ordered.length} 台服务器` : `已开始卸载 ${hostName(ordered[0])}`, 'success');
  } catch (err) {
    toast(errorText(err), 'error');
    if (button) {
      delete button.dataset.busy;
      button.disabled = false;
      button.innerHTML = originalHTML;
    }
  }
}

function openDeployHostPicker() {
  const form = ensureDeployForm();
  openHostPicker({
    title: '选择部署服务器',
    allowMixed: true,
    hosts: deployEligibleHosts(),
    initial: form.serverIds,
    confirmText: '应用到部署',
    onConfirm(hosts) {
      form.serverIds = hosts.map((h) => h.id);
      form.agentIds = form.agentIds.filter((id) => !form.serverIds.includes(id));
      renderView();
    }
  });
}

const COMPONENT_GROUPS = [
  { id: 'network', name: '网络与入口', desc: '把集群内服务安全地暴露出去' },
  { id: 'security', name: '安全与证书', desc: 'TLS 证书签发与集群安全能力' },
  { id: 'observability', name: '可观测性', desc: '指标采集、监控与告警基础' },
  { id: 'management', name: '集群管理', desc: 'Web 控制台与日常运维入口' }
];

const COMMUNITY_COMPONENTS = [
  {
    id: 'ingress-nginx',
    name: 'Ingress NGINX',
    ico: 'link',
    category: 'network',
    desc: '社区最常用的 Ingress 控制器，适合替代或补充 k3s 自带的 Traefik。',
    repo: 'https://kubernetes.github.io/ingress-nginx',
    chart: 'ingress-nginx',
    namespace: 'ingress-nginx',
    note: '如集群已有 Traefik，请先确认 80/443 与 IngressClass 规划。'
  },
  {
    id: 'cert-manager',
    name: 'cert-manager',
    ico: 'shield',
    category: 'security',
    desc: '自动签发和续期 TLS 证书，配合 Ingress 使用。',
    repo: 'https://charts.jetstack.io',
    chart: 'cert-manager',
    namespace: 'cert-manager',
    values: 'installCRDs: true',
    note: '会安装 CRD，首次部署请确认集群 API 可用。'
  },
  {
    id: 'kube-state-metrics',
    name: 'kube-state-metrics',
    ico: 'activity',
    category: 'observability',
    desc: '把集群对象状态暴露为 Prometheus 指标，常用于监控和告警。',
    repo: 'https://prometheus-community.github.io/helm-charts',
    chart: 'kube-state-metrics',
    namespace: 'kube-system',
    note: '只提供指标端点，需配合 Prometheus 采集。'
  },
  {
    id: 'metrics-server',
    name: 'Metrics Server',
    ico: 'activity',
    category: 'observability',
    desc: '提供 CPU / 内存资源指标，`kubectl top` 和 HPA 依赖它。',
    repo: 'https://kubernetes-sigs.github.io/metrics-server/',
    chart: 'metrics-server',
    namespace: 'kube-system',
    note: 'k3s 通常已内置；重复部署前请先确认现有组件状态。'
  },
  {
    id: 'kubernetes-dashboard',
    name: 'Kubernetes Dashboard',
    ico: 'box',
    category: 'management',
    desc: '官方 Web 管理界面，适合临时查看和演示。',
    repo: 'https://kubernetes.github.io/dashboard/',
    chart: 'kubernetes-dashboard',
    namespace: 'kubernetes-dashboard',
    note: '默认只创建最小权限账号，生产环境请自行配置访问控制。'
  }
];

function componentCardHTML(component, installable) {
  return `<div class="card card-pad">
    <div class="stat-ico" style="margin-bottom:10px">${icon(component.ico)}</div>
    <div class="row" style="gap:8px"><h3 style="margin:0;font-size:14px">${esc(component.name)}</h3>${badge('Helm', 'info')}</div>
    <p class="small muted" style="line-height:1.7;min-height:54px;margin:8px 0">${esc(component.desc)}</p>
    <div class="tiny dim mono" style="margin-bottom:8px">${esc(component.namespace)}</div>
    <div class="tiny dim" style="line-height:1.6;margin-bottom:12px">${esc(component.note)}</div>
    <button class="btn primary" data-action="component-install" data-component="${esc(component.id)}" ${installable ? '' : 'disabled'} title="${installable ? '安装时选择目标服务器，可多选（同集群自动去重）' : '需要至少一台已装好 k3s 的服务器'}">${icon('rocket')} 安装插件</button>
  </div>`;
}

function componentGroupHTML(group, installable) {
  const items = COMMUNITY_COMPONENTS.filter((component) => component.category === group.id);
  if (!items.length) return '';
  return `<section class="component-group">
    <div class="component-group-head"><h3>${esc(group.name)}</h3><span>${esc(group.desc)}</span></div>
    <div class="grid grid-3">${items.map((component) => componentCardHTML(component, installable)).join('')}</div>
  </section>`;
}

function configuredImageRef(image) {
  const ref = String(image || '').trim();
  if (!ref) return '';
  const first = ref.split('/')[0];
  const hasRegistry = ref.includes('/') && (first.includes('.') || first.includes(':') || first === 'localhost');
  if (hasRegistry) return ref;
  const repository = (S.imageRepository && S.imageRepository.repository) || 'docker.io';
  const rest = ref.replace(/^library\//, '');
  if (repository === 'docker.io') {
    return rest.includes('/') ? `docker.io/${rest}` : `docker.io/library/${rest}`;
  }
  return `${repository.replace(/\/+$/, '')}/${rest}`;
}

function imageTagOf(ref) {
  const text = String(ref || '');
  const index = text.lastIndexOf(':');
  return index >= 0 ? text.slice(index + 1) : '';
}

function imageRepoOf(ref) {
  const text = String(ref || '');
  const index = text.lastIndexOf(':');
  return index >= 0 ? text.slice(0, index) : text;
}

function baseImageCardHTML(image) {
  const versions = Array.isArray(image.versions) && image.versions.length ? image.versions : [imageTagOf(image.image)];
  // 版本可能刚被改过，选中值要落回列表里，避免下拉和下面的镜像名对不上
  const fallbackVersion = imageTagOf(image.image);
  const wantedVersion = S.baseImageVersions[image.id] || fallbackVersion;
  const currentVersion = versions.indexOf(wantedVersion) >= 0
    ? wantedVersion
    : (versions.indexOf(fallbackVersion) >= 0 ? fallbackVersion : versions[0]);
  const ref = `${imageRepoOf(image.image)}:${currentVersion}`;
  const pullRef = configuredImageRef(ref);
  const page = image.page ? `${String(image.page).split('?')[0]}?name=${encodeURIComponent(currentVersion)}` : '';
  const tone = normalizeTone(image.tone);
  const toneBadge = isCustomTone(tone)
    ? `<span class="badge custom"${toneStyle(tone)}>${esc(imageKindLabel(image))}</span>`
    : badge(imageKindLabel(image), tone);
  return `<div class="card card-pad base-image-card">
    <div class="row" style="justify-content:space-between;align-items:flex-start;gap:8px">
      <div class="stat-ico ${toneClass(tone)}"${toneStyle(tone)}>${icon(image.ico)}</div>
      <div class="row" style="gap:4px;align-items:center">
        ${image.kind ? toneBadge : ''}
        <button class="icon-btn" style="width:28px;height:28px" data-action="image-menu" data-image="${esc(image.id)}" title="编辑或删除这个镜像" aria-haspopup="menu" aria-expanded="false">${icon('more')}</button>
      </div>
    </div>
    <h3 style="margin:10px 0 0;font-size:14px">${esc(image.name)}</h3>
    <label class="image-version-row" for="image-version-${esc(image.id)}">
      <span>版本</span>
      <select class="select image-version-select" id="image-version-${esc(image.id)}" data-image-version="${esc(image.id)}" title="选择 ${esc(image.name)} 镜像版本">
        ${versions.map((version) => `<option value="${esc(version)}" ${version === currentVersion ? 'selected' : ''}>${esc(version)}</option>`).join('')}
      </select>
    </label>
    <p class="small muted" style="line-height:1.7;min-height:54px;margin:8px 0">${esc(image.desc)}</p>
    <div class="image-ref mono copyable">
      <span class="copyable-text">${esc(ref)}</span>
      <button class="icon-btn copy-hover-btn" data-action="image-copy" data-image="${esc(ref)}" title="复制镜像名" aria-label="复制镜像名">${icon('copy')}</button>
    </div>
    <div class="row" style="gap:6px;flex-wrap:wrap;margin-top:8px">
      <button class="btn sm" data-action="image-pull" data-image="${esc(ref)}" title="拉取时选择目标服务器，可多选">${icon('download')} 拉取镜像</button>
      <span class="copy-command-menu">
        <button class="btn sm copy-command-trigger" type="button" aria-haspopup="true" aria-label="复制镜像拉取命令" title="鼠标悬浮选择 docker 或 k3s 拉取命令">${icon('copy')} 复制拉取命令 <span class="copy-command-caret">▾</span></button>
        <span class="copy-command-pop" role="menu">
          <button class="copy-command-item" type="button" role="menuitem" data-action="image-pull-copy" data-command="docker pull ${esc(pullRef)}" title="复制 docker pull 命令">${icon('copy')} docker pull</button>
          <button class="copy-command-item" type="button" role="menuitem" data-action="image-pull-copy" data-command="k3s ctr -n k8s.io images pull ${esc(pullRef)}" title="复制 k3s ctr pull 命令">${icon('copy')} k3s pull</button>
        </span>
      </span>
      ${page ? `<a class="btn sm" href="${esc(page)}" target="_blank" rel="noopener noreferrer" title="打开镜像页">${icon('external')} 镜像页</a>` : ''}
    </div>
    <div class="image-pull-status" data-pull-status aria-live="polite"></div>
  </div>`;
}

function updateBaseImageVersion(select) {
  if (!select) return;
  const id = select.dataset.imageVersion;
  const image = findBaseImage(id);
  const card = select.closest('.base-image-card');
  if (!image || !card) return;
  const version = select.value;
  S.baseImageVersions[id] = version;
  const ref = `${imageRepoOf(image.image)}:${version}`;
  const fullRef = configuredImageRef(ref);
  const text = card.querySelector('.copyable-text');
  if (text) text.textContent = ref;
  const copyName = card.querySelector('[data-action="image-copy"]');
  if (copyName) copyName.dataset.image = ref;
  const pull = card.querySelector('[data-action="image-pull"]');
  if (pull) pull.dataset.image = ref;
  const commands = card.querySelectorAll('[data-action="image-pull-copy"]');
  commands.forEach((button, index) => {
    button.dataset.command = index === 0
      ? `docker pull ${fullRef}`
      : `k3s ctr -n k8s.io images pull ${fullRef}`;
  });
  const page = card.querySelector('a[href]');
  if (page && image.page) page.href = `${String(image.page).split('?')[0]}?name=${encodeURIComponent(version)}`;
  const status = card.querySelector('[data-pull-status]');
  if (status) {
    status.className = 'image-pull-status';
    status.innerHTML = '';
  }
}

// 分类页签前面的「查看全部」，默认就停在这里
const IMAGE_ALL_CATEGORY = { id: 'all', label: '查看全部' };

/* ============================================================
 * 镜像清单：分类和镜像都来自 data/image-management/images.json
 * ============================================================ */
function imageCatalog() {
  return (S.imageCatalog && Array.isArray(S.imageCatalog.images) && Array.isArray(S.imageCatalog.categories))
    ? S.imageCatalog
    : { categories: [], images: [], skipped: 0, file: '', error: '', missing: false };
}

function imageCatalogCategories() {
  return imageCatalog().categories;
}

function imageCatalogImages() {
  return imageCatalog().images;
}

function findBaseImage(id) {
  return imageCatalogImages().find((item) => item.id === id) || null;
}

// 打开页面时读一次清单（服务端每次请求都重新读盘），改完 images.json 刷新浏览器即可
async function loadImageCatalog() {
  if (S.imageCatalog && S.imageCatalog.loaded) return S.imageCatalog;
  try {
    const data = await api('/images/catalog');
    S.imageCatalog = {
      categories: Array.isArray(data.categories) ? data.categories : [],
      images: Array.isArray(data.images) ? data.images : [],
      skipped: Number(data.skipped) || 0,
      missing: Boolean(data.missing),
      file: data.file || 'data/image-management/images.json',
      error: '',
      loaded: true
    };
  } catch (err) {
    S.imageCatalog = {
      categories: [],
      images: [],
      skipped: 0,
      missing: false,
      file: 'data/image-management/images.json',
      error: errorText(err),
      loaded: true
    };
  }
  return S.imageCatalog;
}

function imageCategoryTabs() {
  return [IMAGE_ALL_CATEGORY, ...imageCatalogCategories()];
}

function baseImagesHTML() {
  const categoryId = imageCategoryId();
  const tab = imageCategoryTabs().find((item) => item.id === categoryId) || IMAGE_ALL_CATEGORY;
  const images = imageCategoryImages(categoryId);
  const catalog = imageCatalog();
  const bar = `<div class="image-repo-bar">
      <span class="image-repo-text">${icon('box')}<span>当前仓库：<b class="mono">${esc(S.imageRepository && S.imageRepository.repository ? S.imageRepository.repository : 'docker.io')}</b></span></span>
      <div class="row" style="gap:8px;flex-wrap:wrap">
        <button class="btn sm" data-action="image-new" title="新增一个镜像配置">${icon('plus')} 新增镜像配置</button>
        <button class="btn sm" data-action="image-repo-config">${icon('settings')} 仓库配置</button>
      </div>
    </div>`;
  // 清单读不出来时只留工具栏并说明原因；文件还不存在就当空清单，直接让人新增
  if (catalog.error) {
    return `<section class="component-group">${bar}
    <div class="alert err">${icon('alert')}<div>读取镜像清单失败：${esc(catalog.error)}<div class="tiny dim" style="margin-top:6px">清单文件：<span class="mono">${esc(catalog.file)}</span>。修好后刷新页面。</div></div></div>
  </section>`;
  }
  const hasImages = images.length > 0;
  return `<section class="component-group">
    ${bar}
    ${hasImages ? `<p class="tiny dim" style="line-height:1.65;margin:-2px 0 10px">以下为示例 tag，请按目标架构和版本要求替换。点「拉取镜像」后再选目标服务器（可多选），镜像会写进每台节点的本地镜像库；复制后的镜像名可直接用于 Pod 或 YAML。</p>` : ''}
    ${imageCategoryTabsHTML()}
    ${catalog.skipped ? `<div class="alert warn" style="margin-bottom:12px">${icon('alert')}<div>清单里有 ${catalog.skipped} 条配置缺少必要字段（分类要 id + label，镜像要 name + image），已跳过。</div></div>` : ''}
    ${hasImages
      ? `<div class="grid grid-3">${images.map(baseImageCardHTML).join('')}</div>`
      : `<div class="alert info">${icon('box')}<div>「${esc(tab.label)}」下还没有镜像。</div></div>`}
  </section>`;
}

function imageCategoryId() {
  const wanted = String(S.imageCategory || '');
  return imageCategoryTabs().some((item) => item.id === wanted) ? wanted : IMAGE_ALL_CATEGORY.id;
}

// 镜像归属：kind 按分类 id 匹配，改分类名称不影响归属；兼容老写法（kind 直接写分类名）
function imageCategoryOf(image) {
  const kind = String((image && image.kind) || '').trim();
  if (!kind) return null;
  const categories = imageCatalogCategories();
  return categories.find((item) => item.id === kind) || categories.find((item) => item.label === kind) || null;
}

// 卡片角标显示分类名，而不是 kind 原文
function imageKindLabel(image) {
  const category = imageCategoryOf(image);
  return category ? category.label : String((image && image.kind) || '').trim();
}

function imageCategoryImages(categoryId) {
  const categories = imageCatalogCategories();
  const images = imageCatalogImages();
  if (categoryId === IMAGE_ALL_CATEGORY.id) {
    // 「查看全部」按页签顺序分组排列，和上面的分类顺序保持一致
    const grouped = categories.flatMap((category) => images.filter((item) => imageCategoryOf(item) === category));
    // 兜底：kind 没有对应分类的镜像也要出现在全部里
    return grouped.concat(images.filter((item) => !imageCategoryOf(item)));
  }
  const category = categories.find((item) => item.id === categoryId);
  return category ? images.filter((item) => imageCategoryOf(item) === category) : [];
}

function imageCategoryTabsHTML() {
  const current = imageCategoryId();
  const tabs = imageCategoryTabs().map((category) => {
    const active = category.id === current;
    const isAll = category.id === IMAGE_ALL_CATEGORY.id;
    const draggable = isAll ? '' : ` draggable="true" data-drag-category="${esc(category.id)}"`;
    return `<button class="panel-tab ${active ? 'active' : ''}" role="tab" aria-selected="${active}" data-action="image-category" data-category="${esc(category.id)}"${draggable}>
      <span>${esc(category.label)}</span>
      ${isAll ? '' : `<span class="tab-del" data-action="image-category-delete" data-category="${esc(category.id)}" role="button" aria-label="删除分类 ${esc(category.label)}" title="删除分类">×</span>`}
    </button>`;
  }).join('');
  return `<div class="panel-tabs sub" role="tablist" aria-label="镜像分类">${tabs}
    <button class="panel-tab add" data-action="image-category-add" title="新增分类">${icon('plus')}</button>
  </div>`;
}

/* ============================================================
 * 镜像清单编辑：分类（页签）增删改名 + 单个镜像增删改
 * 保存直接写回 data/image-management/images.json
 * ============================================================ */
const IMAGE_ICON_CHOICES = ['box', 'server', 'cluster', 'layers', 'rocket', 'activity', 'settings', 'refresh', 'expand', 'compress', 'search', 'terminal', 'cpu', 'link', 'download', 'filter', 'shield', 'zap', 'external', 'lock', 'eye', 'folder', 'file', 'upload', 'grid', 'play', 'stop', 'clock', 'scroll', 'power', 'sun', 'moon', 'arrow-left', 'alert'];
const IMAGE_TONE_CHOICES = [
  { value: 'purple', label: '紫', hex: '#a78bfa' },
  { value: 'cyan', label: '青', hex: '#22d3ee' },
  { value: 'ok', label: '绿', hex: '#34d399' },
  { value: 'warn', label: '黄', hex: '#fbbf24' },
  { value: 'info', label: '蓝', hex: '#60a5fa' },
  { value: 'err', label: '红', hex: '#fb7185' },
  { value: 'neutral', label: '灰', hex: '#94a3b8' }
];

// 配色可以存预置名字（purple/ok/...），也可以存自定义的 #rrggbb
const TONE_HEX_RE = /^#[0-9a-f]{6}$/i;
function isCustomTone(tone) {
  return TONE_HEX_RE.test(String(tone || '').trim());
}
function normalizeTone(tone) {
  const value = String(tone || '').trim();
  if (!value) return 'neutral';
  if (isCustomTone(value)) return value.toLowerCase();
  return IMAGE_TONE_CHOICES.some((item) => item.value === value) ? value : 'neutral';
}
function toneHexOf(tone) {
  if (isCustomTone(tone)) return String(tone).toLowerCase();
  const preset = IMAGE_TONE_CHOICES.find((item) => item.value === tone);
  return preset ? preset.hex : '#94a3b8';
}
function toneClass(tone) {
  return isCustomTone(tone) ? 'tone-custom' : `tone-${tone}`;
}
function toneStyle(tone) {
  return isCustomTone(tone) ? ` style="--tone:${esc(tone)}"` : '';
}
function hexToRgb(hex) {
  const n = parseInt(String(hex).slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}
function rgbToHex(r, g, b) {
  const part = (v) => Math.max(0, Math.min(255, Math.round(Number(v) || 0))).toString(16).padStart(2, '0');
  return `#${part(r)}${part(g)}${part(b)}`;
}

// 保存接口统一返回整份清单，直接替换内存里的数据
function applyImageCatalog(catalog) {
  if (!catalog || !Array.isArray(catalog.categories) || !Array.isArray(catalog.images)) return;
  S.imageCatalog = {
    categories: catalog.categories,
    images: catalog.images,
    skipped: Number(catalog.skipped) || 0,
    missing: false,
    file: (S.imageCatalog && S.imageCatalog.file) || 'data/image-management/images.json',
    error: '',
    loaded: true
  };
}

async function saveImageCatalog(path, method, body) {
  const data = await api(path, { method, body });
  applyImageCatalog(data.catalog);
  return data.catalog;
}

function openImageEditor(image) {
  const editing = Boolean(image && image.id);
  const categories = imageCatalogCategories();
  const tabId = imageCategoryId();
  const current = image || {
    name: '',
    kind: tabId === IMAGE_ALL_CATEGORY.id ? '' : tabId,
    image: '',
    versions: [],
    ico: 'box',
    tone: 'neutral',
    page: '',
    desc: ''
  };
  const versionsText = Array.isArray(current.versions) ? current.versions.join(', ') : '';
  // 图标直接摆图标本身，选中项高亮；清单里写了不在候选里的图标时也保留可选
  const rawIco = String(current.ico || '').trim();
  const iconChoices = rawIco && !IMAGE_ICON_CHOICES.includes(rawIco) ? [rawIco].concat(IMAGE_ICON_CHOICES) : IMAGE_ICON_CHOICES;
  let pickedIco = rawIco || 'box';
  const initialTone = normalizeTone(current.tone);
  let pickedTone = initialTone;
  let customHex = isCustomTone(initialTone) ? initialTone : toneHexOf(initialTone);
  const customRgb = hexToRgb(customHex);
  openModal({
    title: editing ? '编辑镜像' : '新增镜像',
    size: 'narrow',
    body: `
      <label class="field">镜像名称
        <input class="input" id="imageEditName" autocomplete="off" spellcheck="false" placeholder="例如 MySQL" value="${esc(current.name || '')}" />
      </label>
      <div class="grid two" style="gap:10px;margin-top:12px">
        <label class="field">分类
          <select class="select" id="imageEditKind">
            <option value="">无</option>
            ${categories.map((item) => `<option value="${esc(item.id)}" ${item.id === (current.kind || '') ? 'selected' : ''}>${esc(item.label)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="field" style="margin-top:12px">配色
        <div class="tone-row" id="imageEditToneRow">
          ${IMAGE_TONE_CHOICES.map((tone) => `<button type="button" class="tone-swatch ${tone.value === initialTone ? 'active' : ''}" data-tone="${tone.value}" style="--tone:${tone.hex}" title="${tone.label}" aria-pressed="${tone.value === initialTone}"><i></i></button>`).join('')}
          <input type="color" class="tone-color-input ${isCustomTone(initialTone) ? 'active' : ''}" id="imageEditToneColor" value="${customHex}" title="自定义颜色：打开系统调色板" />
          <button type="button" class="btn sm ghost tone-eye" id="imageEditToneEye" title="从屏幕上取一个颜色">${icon('eye')} 取色</button>
        </div>
        <div class="tone-custom-panel ${isCustomTone(initialTone) ? '' : 'hidden'}" id="imageEditToneCustom">
          <div class="tone-line">色值
            <input class="input tone-hex" id="imageEditToneHex" maxlength="7" autocomplete="off" spellcheck="false" value="${customHex}" />
            <span class="tone-line-sep">RGB</span>
            <input class="input tone-rgb" id="imageEditToneR" type="number" min="0" max="255" value="${customRgb.r}" />
            <input class="input tone-rgb" id="imageEditToneG" type="number" min="0" max="255" value="${customRgb.g}" />
            <input class="input tone-rgb" id="imageEditToneB" type="number" min="0" max="255" value="${customRgb.b}" />
          </div>
          <div class="tone-preview" id="imageEditTonePreview"></div>
        </div>
        <span class="help">卡片图标和分类角标的颜色；取色笔只在 localhost 或 HTTPS 下可用。</span>
      </div>
      <label class="field" style="margin-top:12px">镜像地址
        <input class="input" id="imageEditImage" autocomplete="off" spellcheck="false" placeholder="例如 mysql:8.4" value="${esc(current.image || '')}" />
        <span class="help">写完整的 <span class="code-inline">仓库/镜像:tag</span>，卡片上默认显示这个 tag。</span>
      </label>
      <label class="field" style="margin-top:12px">版本（可选）
        <input class="input" id="imageEditVersions" autocomplete="off" spellcheck="false" placeholder="8.4, 8.0" value="${esc(versionsText)}" />
        <span class="help">逗号分隔；留空时用镜像地址里的 tag。</span>
      </label>
      <div class="field" style="margin-top:12px">图标
        <div class="icon-grid" id="imageEditIcoGrid" role="listbox" aria-label="选择图标">
          ${iconChoices.map((name) => `<button type="button" class="icon-choice ${name === pickedIco ? 'active' : ''}" role="option" aria-selected="${name === pickedIco}" data-ico="${esc(name)}" title="${esc(name)}">${icon(name)}</button>`).join('')}
        </div>
      </div>
      <label class="field" style="margin-top:12px">镜像页地址（可选）
        <input class="input" id="imageEditPage" autocomplete="off" spellcheck="false" placeholder="https://hub.docker.com/_/mysql/tags" value="${esc(current.page || '')}" />
        <span class="help">留空时卡片上不显示「镜像页」按钮。</span>
      </label>
      <label class="field" style="margin-top:12px">说明（可选）
        <textarea class="textarea" id="imageEditDesc" rows="2" placeholder="一句话说明这个镜像的用途">${esc(current.desc || '')}</textarea>
      </label>`,
    foot: `<button class="btn ghost" data-close="1">取消</button>
           <button class="btn primary" id="imageEditSave">${icon('check')} 保存</button>`,
    onMount(box) {
      const nameInput = $('#imageEditName', box.el);
      const imageInput = $('#imageEditImage', box.el);
      const btn = $('#imageEditSave', box.el);
      const icoGrid = $('#imageEditIcoGrid', box.el);
      const toneRow = $('#imageEditToneRow', box.el);
      const toneColor = $('#imageEditToneColor', box.el);
      const tonePanel = $('#imageEditToneCustom', box.el);
      const toneHexInput = $('#imageEditToneHex', box.el);
      const toneR = $('#imageEditToneR', box.el);
      const toneG = $('#imageEditToneG', box.el);
      const toneB = $('#imageEditToneB', box.el);
      const tonePreview = $('#imageEditTonePreview', box.el);
      const toneEye = $('#imageEditToneEye', box.el);

      const renderTonePreview = () => {
        const custom = isCustomTone(pickedTone);
        const preset = IMAGE_TONE_CHOICES.find((item) => item.value === pickedTone);
        tonePreview.innerHTML = `<span class="badge ${custom ? 'custom' : esc(pickedTone)}"${custom ? ` style="--tone:${esc(pickedTone)}"` : ''}>分类</span>
          <span class="stat-ico ${toneClass(pickedTone)}"${toneStyle(pickedTone)}>${icon(pickedIco || 'box')}</span>
          <span class="tiny dim">${esc(custom ? pickedTone : (preset ? preset.label : pickedTone))}</span>`;
      };
      const paintToneSelection = () => {
        toneRow.querySelectorAll('.tone-swatch').forEach((el) => {
          const active = el.dataset.tone === pickedTone;
          el.classList.toggle('active', active);
          el.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        toneColor.classList.toggle('active', isCustomTone(pickedTone));
        tonePanel.classList.toggle('hidden', !isCustomTone(pickedTone));
        renderTonePreview();
      };
      const setCustomTone = (hex, opts = {}) => {
        const value = String(hex || '').trim().toLowerCase();
        if (!TONE_HEX_RE.test(value)) return;
        customHex = value;
        pickedTone = value;
        toneColor.value = value;
        if (opts.syncHex !== false) toneHexInput.value = value;
        if (opts.syncRgb !== false) {
          const rgb = hexToRgb(value);
          toneR.value = rgb.r;
          toneG.value = rgb.g;
          toneB.value = rgb.b;
        }
        paintToneSelection();
      };

      toneRow.querySelectorAll('.tone-swatch').forEach((el) => {
        el.addEventListener('click', () => {
          pickedTone = el.dataset.tone;
          customHex = toneHexOf(pickedTone);
          const rgb = hexToRgb(customHex);
          toneColor.value = customHex;
          toneHexInput.value = customHex;
          toneR.value = rgb.r;
          toneG.value = rgb.g;
          toneB.value = rgb.b;
          paintToneSelection();
        });
      });
      toneColor.addEventListener('input', () => setCustomTone(toneColor.value));
      toneHexInput.addEventListener('input', () => {
        const value = toneHexInput.value.trim();
        if (TONE_HEX_RE.test(value)) setCustomTone(value, { syncHex: false });
      });
      [toneR, toneG, toneB].forEach((input) => {
        input.addEventListener('input', () => {
          if (input.value === '') return;
          setCustomTone(rgbToHex(toneR.value, toneG.value, toneB.value));
        });
      });
      // 屏幕取色：EyeDropper 只在安全上下文（localhost / HTTPS）里存在
      if (!window.EyeDropper) {
        toneEye.disabled = true;
        toneEye.title = '取色笔只在 localhost 或 HTTPS 下可用，当前地址不支持';
        toneEye.classList.add('is-disabled');
      } else {
        toneEye.addEventListener('click', async () => {
          try {
            const result = await new window.EyeDropper().open();
            if (result && result.sRGBHex) setCustomTone(result.sRGBHex);
          } catch (err) {
            // 用户按 Esc 取消，不用提示
          }
        });
      }
      renderTonePreview();
      paintToneSelection();

      icoGrid.addEventListener('click', (event) => {
        const choice = event.target.closest ? event.target.closest('.icon-choice') : null;
        if (!choice) return;
        pickedIco = choice.dataset.ico;
        icoGrid.querySelectorAll('.icon-choice').forEach((el) => {
          const active = el === choice;
          el.classList.toggle('active', active);
          el.setAttribute('aria-selected', active ? 'true' : 'false');
        });
      });
      btn.addEventListener('click', async () => {
        const payload = {
          name: nameInput.value.trim(),
          image: imageInput.value.trim(),
          kind: $('#imageEditKind', box.el).value,
          versions: $('#imageEditVersions', box.el).value,
          ico: pickedIco,
          tone: pickedTone,
          page: $('#imageEditPage', box.el).value.trim(),
          desc: $('#imageEditDesc', box.el).value.trim()
        };
        if (!payload.name) { toast('请填写镜像名称', 'error'); nameInput.focus(); return; }
        if (!payload.image) { toast('请填写镜像地址', 'error'); imageInput.focus(); return; }
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> 保存中';
        try {
          await saveImageCatalog(
            editing ? `/images/catalog/images/${encodeURIComponent(image.id)}` : '/images/catalog/images',
            editing ? 'PUT' : 'POST',
            payload
          );
          closeModal();
          toast(editing ? '镜像已更新' : '镜像已新增', 'success', 2600);
          renderView();
        } catch (err) {
          toast(errorText(err), 'error', 5000);
          btn.disabled = false;
          btn.innerHTML = `${icon('check')} 保存`;
        }
      });
      setTimeout(() => nameInput.focus(), 50);
    }
  });
}

/* 镜像卡片右上角的「…」菜单：编辑 / 删除 */
let imageActionMenuEl = null;
let imageActionMenuAnchor = null;

function closeImageActionMenu() {
  if (!imageActionMenuEl) return;
  imageActionMenuEl.remove();
  imageActionMenuEl = null;
  if (imageActionMenuAnchor && imageActionMenuAnchor.isConnected) {
    imageActionMenuAnchor.setAttribute('aria-expanded', 'false');
  }
  imageActionMenuAnchor = null;
}

function openImageActionMenu(anchor, imageId) {
  const image = findBaseImage(imageId);
  if (!anchor || !image) return;
  closeImageActionMenu();
  const item = (action, iconName, label, danger = false) =>
    `<button type="button" class="ctx-item${danger ? ' danger' : ''}" role="menuitem" data-action="${action}" data-image="${esc(image.id)}">${icon(iconName)}<span>${esc(label)}</span></button>`;
  const menu = document.createElement('div');
  menu.id = 'imageActionMenu';
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', `${image.name} 操作`);
  menu.innerHTML = `${item('image-edit', 'edit', '编辑镜像')}<div class="ctx-sep"></div>${item('image-delete', 'trash', '删除镜像', true)}`;
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.appendChild(menu);
  imageActionMenuEl = menu;
  imageActionMenuAnchor = anchor;
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

  menu.addEventListener('click', () => closeImageActionMenu());
  const first = menu.querySelector('.ctx-item');
  if (first) first.focus({ preventScroll: true });
}

async function deleteBaseImage(id) {
  const image = findBaseImage(id);
  if (!image) return;
  const ok = await confirmDialog({
    title: '删除镜像',
    message: `确定从镜像清单里删除 <b>${esc(image.name)}</b>（<span class="code-inline">${esc(image.image)}</span>）吗？<br><span class="tiny dim">只删除 images.json 里的这条配置，不影响节点上已经拉取的镜像。</span>`,
    confirmText: '删除镜像',
    danger: true
  });
  if (!ok) return;
  try {
    await saveImageCatalog(`/images/catalog/images/${encodeURIComponent(id)}`, 'DELETE');
    toast('镜像已删除', 'success', 2600);
    renderView();
  } catch (err) {
    toast(errorText(err), 'error', 5000);
  }
}

// 删除分类：有镜像时二次确认，确认后连镜像配置一起删掉
async function deleteImageCategory(id) {
  const category = imageCatalogCategories().find((item) => item.id === id);
  if (!category) return;
  const images = imageCatalogImages().filter((item) => imageCategoryOf(item) === category);
  const ok = await confirmDialog({
    title: '删除分类',
    message: images.length
      ? `分类 <b>${esc(category.label)}</b> 下还有 <b>${images.length}</b> 个镜像配置。确认删除会把这个分类和这 ${images.length} 个镜像配置一起删掉（只删配置，不动仓库和节点上的镜像）。`
      : `确认删除分类 <b>${esc(category.label)}</b> 吗？`,
    confirmText: images.length ? `删除分类和 ${images.length} 个镜像` : '确认删除',
    danger: true
  });
  if (!ok) return;
  try {
    await saveImageCatalog(`/images/catalog/categories/${encodeURIComponent(id)}`, 'DELETE');
    if (S.imageCategory === id) S.imageCategory = IMAGE_ALL_CATEGORY.id;
    toast('分类已删除', 'success', 2600);
    renderView();
  } catch (err) {
    toast(errorText(err), 'error', 5000);
  }
}

// 新增分类：直接在页签栏最右边长出一个待填写的小页签，点对勾保存
let imageCategoryDraftEl = null;
let imageCategoryDraftState = null; // { text }：页面重绘后把没保存的草稿接着摆出来

// 取消就地新增分类：草稿直接收掉，把「+」按钮放回来
function closeImageCategoryDraft() {
  imageCategoryDraftState = null;
  const draft = imageCategoryDraftEl;
  imageCategoryDraftEl = null;
  if (!draft) return;
  const bar = draft.parentElement;
  if (draft.isConnected) draft.remove();
  const addBtn = bar ? bar.querySelector('[data-action="image-category-add"]') : null;
  if (addBtn) addBtn.style.display = '';
}

function openImageCategoryDraft(opts = {}) {
  const bar = document.querySelector('.panel-tabs.sub');
  if (!bar) return;
  const existed = bar.querySelector('.panel-tab-draft');
  if (existed) {
    const oldInput = existed.querySelector('.tab-draft-input');
    if (oldInput && opts.focus !== false) oldInput.focus();
    return;
  }
  const addBtn = bar.querySelector('[data-action="image-category-add"]');
  const draft = document.createElement('span');
  draft.className = 'panel-tab-draft';
  draft.innerHTML = `<input class="tab-draft-input" maxlength="24" placeholder="分类名称" autocomplete="off" spellcheck="false" />
    <button class="tab-draft-ok" type="button" title="保存分类">${icon('check')}</button>
    <button class="tab-draft-cancel" type="button" title="取消">${icon('x')}</button>`;
  bar.appendChild(draft);
  imageCategoryDraftEl = draft;
  if (addBtn) addBtn.style.display = 'none';
  const input = draft.querySelector('.tab-draft-input');
  input.value = String(opts.text || (imageCategoryDraftState && imageCategoryDraftState.text) || '');
  imageCategoryDraftState = { text: input.value };
  const okBtn = draft.querySelector('.tab-draft-ok');
  const cancelBtn = draft.querySelector('.tab-draft-cancel');
  const cancel = () => closeImageCategoryDraft();
  const save = async () => {
    const label = input.value.trim();
    if (!label) {
      toast('请填写分类名称', 'error');
      input.focus();
      return;
    }
    okBtn.disabled = true;
    try {
      const catalog = await saveImageCatalog('/images/catalog/categories', 'POST', { label });
      const created = (catalog.categories || []).find((item) => item.label === label);
      if (created) S.imageCategory = created.id;
      imageCategoryDraftEl = null;
      imageCategoryDraftState = null;
      toast('分类已新增', 'success', 2200);
      renderView();
    } catch (err) {
      toast(errorText(err), 'error', 5000);
      okBtn.disabled = false;
      input.focus();
    }
  };
  okBtn.addEventListener('click', save);
  cancelBtn.addEventListener('click', () => cancel());
  input.addEventListener('input', () => {
    imageCategoryDraftState = { text: input.value };
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      save();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      cancel();
    }
  });
  if (opts.focus !== false) setTimeout(() => input.focus(), 30);
}

// 换页签 / 刷新数据会重绘页签栏，未保存的草稿要接着显示（不抢焦点）
function restoreImageCategoryDraft() {
  const onImagesTab = S.view === 'deploy'
    && S.deployTab === 'components'
    && componentSubTabOf(S.componentsTab) === 'images';
  if (!onImagesTab) {
    imageCategoryDraftState = null;
    return;
  }
  if (!imageCategoryDraftState) return;
  if (document.querySelector('.panel-tab-draft')) return;
  openImageCategoryDraft({ text: imageCategoryDraftState.text, focus: false });
}

/* 分类页签拖动排序：拖动过程中直接移动 DOM，松手后把顺序写回清单 */
let draggingImageCategory = '';

function imageCategoryDragStart(event) {
  const tab = event.target && event.target.closest ? event.target.closest('.panel-tab[data-drag-category]') : null;
  if (!tab) return;
  if (event.target.closest('.tab-del')) {
    event.preventDefault();
    return;
  }
  draggingImageCategory = tab.dataset.dragCategory;
  tab.classList.add('dragging');
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move';
    try {
      event.dataTransfer.setData('text/plain', draggingImageCategory);
    } catch (_) { /* 个别浏览器不允许写，忽略 */ }
  }
}

function imageCategoryDragOver(event) {
  if (!draggingImageCategory) return;
  const bar = event.target.closest ? event.target.closest('.panel-tabs.sub') : null;
  if (!bar) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  const tab = event.target.closest('.panel-tab[data-drag-category]');
  bar.querySelectorAll('.drag-over-before,.drag-over-after').forEach((el) => el.classList.remove('drag-over-before', 'drag-over-after'));
  if (!tab || tab.dataset.dragCategory === draggingImageCategory) return;
  const rect = tab.getBoundingClientRect();
  tab.classList.add(event.clientX > rect.left + rect.width / 2 ? 'drag-over-after' : 'drag-over-before');
}

async function imageCategoryDrop(event) {
  const bar = event.target.closest ? event.target.closest('.panel-tabs.sub') : null;
  if (!bar || !draggingImageCategory) return;
  event.preventDefault();
  const dragged = Array.from(bar.querySelectorAll('[data-drag-category]')).find((el) => el.dataset.dragCategory === draggingImageCategory);
  const target = event.target.closest('.panel-tab[data-drag-category]');
  if (dragged && target && target !== dragged) {
    const rect = target.getBoundingClientRect();
    target.parentNode.insertBefore(dragged, event.clientX > rect.left + rect.width / 2 ? target.nextSibling : target);
  }
  const order = Array.from(bar.querySelectorAll('[data-drag-category]')).map((el) => el.dataset.dragCategory);
  const before = imageCatalogCategories().map((item) => item.id);
  if (!order.length || order.join(',') === before.join(',')) return;
  try {
    await saveImageCatalog('/images/catalog/categories', 'PUT', { order });
  } catch (err) {
    toast(errorText(err), 'error', 5000);
  }
  renderView();
}

function imageCategoryDragEnd() {
  draggingImageCategory = '';
  document.querySelectorAll('.panel-tab.dragging').forEach((el) => el.classList.remove('dragging'));
  document.querySelectorAll('.drag-over-before,.drag-over-after').forEach((el) => el.classList.remove('drag-over-before', 'drag-over-after'));
}

function openImageRepositoryConfig() {
  const current = S.imageRepository || { repository: 'docker.io', username: '', hasPassword: false, isDefault: true };
  const modal = openModal({
    title: '镜像仓库配置',
    size: 'narrow',
    body: `
      <div class="alert info" style="margin-bottom:14px">${icon('box')}<div>默认从公共仓库 <span class="code-inline">docker.io</span> 拉取。配置会保存到 <span class="code-inline">data/image-management/images-repository.json</span></div></div>
      <label class="field" style="margin-bottom:16px">仓库地址
        <input class="input" id="imageRepoUrl" autocomplete="off" spellcheck="false" placeholder="docker.io 或 harbor.example.com" value="${esc(current.repository || 'docker.io')}" />
        <span class="help">可填写域名、IP 或带端口地址；需要路径前缀时也可填写，例如 <span class="code-inline">registry.example.com/mirror</span>。</span>
      </label>
      <div class="grid two" style="gap:10px">
        <label class="field">用户名（可选）
          <input class="input" id="imageRepoUser" autocomplete="off" spellcheck="false" placeholder="私有仓库用户名" value="${esc(current.username || '')}" />
        </label>
        <label class="field">密码 / Token（可选）
          <input class="input" id="imageRepoPass" type="password" autocomplete="new-password" placeholder="${current.hasPassword ? '已保存，留空表示不修改' : '私有仓库密码'}" />
        </label>
      </div>
      <div class="tiny dim">公开仓库只填地址即可；私有仓库填写凭据后会用于后续拉取。</div>`,
    foot: `<button class="btn ghost" data-close="1">取消</button>
           <button class="btn primary" id="imageRepoSave">${icon('check')} 保存配置</button>`,
    onMount(box) {
      const url = $('#imageRepoUrl', box.el);
      const user = $('#imageRepoUser', box.el);
      const pass = $('#imageRepoPass', box.el);
      const btn = $('#imageRepoSave', box.el);
      btn.addEventListener('click', async () => {
        const repository = url.value.trim();
        const username = user.value.trim();
        const password = pass.value;
        if (!repository) { toast('请填写镜像仓库地址', 'error'); url.focus(); return; }
        if (username && username !== (current.username || '') && !password) { toast('修改用户名时请重新填写密码或 Token', 'error'); pass.focus(); return; }
        if (username && !password && !current.hasPassword) { toast('填写用户名时请同时填写密码或 Token', 'error'); pass.focus(); return; }
        if (!username && password) { toast('填写密码或 Token 时请同时填写用户名', 'error'); user.focus(); return; }
        const payload = { repository, username };
        if (password) payload.password = password;
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> 保存中';
        try {
          const data = await api('/image-repository', { method: 'PUT', body: payload });
          S.imageRepository = data.repository;
          closeModal();
          toast('镜像仓库配置已保存', 'success', 2600);
          renderView();
        } catch (err) {
          toast(errorText(err), 'error', 5000);
          btn.disabled = false;
          btn.innerHTML = `${icon('check')} 保存配置`;
        }
      });
      setTimeout(() => url.focus(), 50);
    }
  });
  return modal;
}

function communityChartYaml(component) {
  const lines = [
    'apiVersion: helm.cattle.io/v1',
    'kind: HelmChart',
    'metadata:',
    `  name: ${component.id}`,
    '  namespace: kube-system',
    'spec:',
    `  chart: ${component.chart}`,
    `  repo: ${component.repo}`,
    `  targetNamespace: ${component.namespace}`,
    '  createNamespace: true'
  ];
  if (component.values) {
    lines.push('  valuesContent: |-');
    for (const line of String(component.values).split('\n')) lines.push('    ' + line);
  }
  return lines.join('\n') + '\n';
}

function renderDeployComponents() {
  const view = $('#view');
  const tab = componentSubTabOf(S.componentsTab);
  S.componentsTab = tab;
  const body = tab === 'images'
    ? baseImagesManagerHTML()
    : tab === 'node-images'
      ? nodeImagesHTML()
      : componentsCatalogHTML();
  view.innerHTML = `${DEMO ? demoBanner() : ''}${deployCenterHead('components')}
    ${componentSubTabsHTML(tab)}
    ${body}`;
  if (tab === 'node-images') {
    const host = nodeImageHost();
    if (host && !S.hostImages[host.id]) loadNodeImages().catch(() => {});
  }
}

// 子页签一：组件管理（这里不选服务器，安装时再弹选择器）
function componentsCatalogHTML() {
  const pool = deployOperationPool();
  const installable = pool.length > 0;
  return `${!pool.length ? `<div class="alert warn">${icon('alert')}<div>还没有可用的服务器。插件安装需要通过 k3s 内置的 HelmChart 控制器完成，请先添加并部署好 k3s 节点。</div></div>` : ''}
    <div class="alert info" style="margin-bottom:16px">${icon('box')}<div>点「安装插件」后会弹出服务器列表：可以多选，同一个集群只会安装一次；插件由 k3s 内置 Helm Controller 异步安装，节点需要能访问对应 chart 仓库。</div></div>
    <div class="component-catalog">
      ${COMPONENT_GROUPS.map((group) => componentGroupHTML(group, installable)).join('')}
    </div>`;
}

// 子页签二：镜像管理（同样不选服务器，拉取时再弹选择器）
function baseImagesManagerHTML() {
  const pool = deployOperationPool();
  return `${!pool.length ? `<div class="alert warn">${icon('alert')}<div>还没有可用的服务器。镜像需要拉取到具体节点，请先添加服务器。</div></div>` : ''}
    <div class="alert info" style="margin-bottom:16px">${icon('layers')}<div>点「拉取镜像」后会弹出服务器列表，可以多选；镜像按节点独立存储，会逐台写入所选节点的本地镜像库。</div></div>
    <div class="component-catalog">${baseImagesHTML()}</div>`;
}

// 子页签三：查看服务器内镜像（单选服务器，切换后看到该节点上的镜像）
function nodeImagesHTML() {
  const pool = nodeImagePool();
  const host = nodeImageHost();
  if (!pool.length) {
    return `${nodeImageBarHTML()}<div class="alert warn">${icon('alert')}<div>还没有可操作的服务器。请先添加服务器并完成 k3s 部署。</div></div>`;
  }
  const toolbar = `<button class="btn sm" data-action="node-images-import" title="先选服务器（可多选），再上传离线 .tar 镜像包">${icon('upload')} 导入离线镜像</button>`;
  return `${nodeImageBarHTML(toolbar)}
    ${host ? `${nodeImageFilterBarHTML()}<div id="nodeImagesResult">${nodeImageCardHTML(host)}</div>` : `<div class="alert warn">${icon('alert')}<div>还没有选择服务器。用上方的服务器下拉框切换即可看到各节点上的镜像。</div></div>`}`;
}

// 本地筛选：只在已读到的镜像里过滤，不再请求节点
function nodeImageFilters() {
  const filters = S.hostImageFilters || {};
  return {
    name: String(filters.name || '').trim().toLowerCase(),
    id: String(filters.id || '').trim().toLowerCase()
  };
}

function nodeImageFilterBarHTML() {
  const { name, id } = nodeImageFilters();
  const active = !!(name || id);
  return `<div class="row node-image-filters" style="gap:10px;flex-wrap:wrap;align-items:flex-end;margin:0 0 14px">
    <label class="field">镜像名称
      <input class="input" id="nodeImageNameFilter" placeholder="按镜像名称过滤" aria-label="按镜像名称过滤" value="${esc((S.hostImageFilters || {}).name || '')}" autocomplete="off" spellcheck="false" />
    </label>
    <label class="field">镜像 ID
      <input class="input" id="nodeImageIdFilter" placeholder="按镜像id过滤" aria-label="按镜像id过滤" value="${esc((S.hostImageFilters || {}).id || '')}" autocomplete="off" spellcheck="false" />
    </label>
    <button class="btn sm" data-action="node-images-filters-reset" ${active ? '' : 'disabled'}>${icon('x')} 清空筛选</button>
  </div>`;
}

// 输入时只重绘结果区，避免输入框失焦
function refreshNodeImageResult() {
  const box = document.getElementById('nodeImagesResult');
  const host = nodeImageHost();
  if (!box || !host) return;
  box.innerHTML = nodeImageCardHTML(host);
  const reset = document.querySelector('[data-action="node-images-filters-reset"]');
  if (reset) {
    const { name, id } = nodeImageFilters();
    reset.disabled = !(name || id);
  }
}

// ---------------- 节点镜像：表格 / 卡片 / 读取

let nodeImagesLoading = false;

function nodeImageTableHTML(host, state) {
  const images = Array.isArray(state.images) ? state.images : [];
  const { name: nameQuery, id: idQuery } = nodeImageFilters();
  const visible = images.filter((item) => {
    if (nameQuery) {
      const tags = (Array.isArray(item.repoTags) ? item.repoTags : []).join(' ').toLowerCase();
      if (!tags.includes(nameQuery)) return false;
    }
    if (idQuery) {
      const rawId = String(item.id || '').toLowerCase();
      if (!rawId.includes(idQuery)) return false;
    }
    return true;
  });
  const filtering = !!(nameQuery || idQuery);
  const countText = filtering
    ? `匹配 ${visible.length} / ${images.length} 个镜像`
    : `${images.length} 个镜像`;
  const toolbar = `<div class="row" style="justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px">
    <div class="row" style="gap:8px;align-items:baseline;flex-wrap:wrap">
      <b class="mono">${esc(hostName(host))}</b>
      <span class="tiny dim">${esc(hostAddress(host))} · ${countText}</span>
    </div>
    <button class="btn sm" data-action="node-images-refresh" title="重新从这台节点读取镜像列表">${icon('refresh')} 刷新</button>
  </div>`;
  if (!images.length) {
    return `${toolbar}<div class="alert info">${icon('box')}<div>这台节点上还没有读取到镜像。可以刷新重试，或确认 k3s / containerd 已启动。</div></div>`;
  }
  if (!visible.length) {
    return `${toolbar}<div class="alert info">${icon('search')}<div>没有匹配的镜像：当前筛选条件 ${nameQuery ? `名称含 <b class="mono">${esc(nameQuery)}</b>` : ''}${nameQuery && idQuery ? '、' : ''}${idQuery ? `ID 含 <b class="mono">${esc(idQuery)}</b>` : ''}。可以改一下关键字或清空筛选。</div></div>`;
  }
  const rows = visible.map((item) => {
    const tags = Array.isArray(item.repoTags) ? item.repoTags.filter(Boolean) : [];
    const primary = tags[0] || '<none>';
    const extra = tags.slice(1);
    const shortId = String(item.id || '').replace(/^sha256:/, '').slice(0, 12) || '-';
    return `<tr>
      <td class="primary">
        <div class="image-name-row">
          <span class="mono">${esc(primary)}</span>
          ${primary !== '<none>' ? `<button class="icon-btn inline-copy-btn" data-action="node-image-copy" data-image="${esc(primary)}" title="复制镜像名" aria-label="复制镜像名">${icon('copy')}</button>` : ''}
        </div>
        ${extra.length ? `<div class="tiny dim mono" style="margin-top:2px">${extra.map((tag) => esc(tag)).join('<br>')}</div>` : ''}
      </td>
      <td class="mono" title="${esc(item.id || '')}">${esc(shortId)}</td>
      <td class="right">${esc(formatBytes(item.size))}</td>
      <td class="right">
        <div class="row-actions" style="opacity:1">
          <button class="icon-btn" data-action="node-image-download" data-host="${esc(host.id)}" data-image="${esc(primary)}" title="导出并下载镜像 tar" aria-label="导出并下载镜像 tar" ${primary === '<none>' ? 'disabled' : ''}>${icon('download')}</button>
          <button class="icon-btn danger" data-action="node-image-delete" data-host="${esc(host.id)}" data-image-id="${esc(item.id || '')}" data-image-label="${esc(primary)}" title="删除镜像（含该镜像的所有 tag）" aria-label="删除镜像" ${item.id ? '' : 'disabled'}>${icon('trash')}</button>
        </div>
      </td>
    </tr>`;
  }).join('');
  return `${toolbar}<div class="table-wrap"><table class="data">
    <thead><tr><th>镜像</th><th>镜像 ID</th><th class="right">大小</th><th class="right">操作</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}

function nodeImageCardHTML(host) {
  const state = S.hostImages[host.id];
  let body;
  if (!state) {
    body = `<div class="alert info">${icon('refresh')}<div>正在读取 ${esc(hostName(host))} 的节点镜像…</div></div>`;
  } else if (state.error) {
    body = `<div class="alert err">${icon('alert')}<div>读取 ${esc(hostName(host))} 的镜像失败：${esc(state.error)}</div>
      <button class="btn sm" data-action="node-images-refresh">${icon('refresh')} 重试</button></div>`;
  } else {
    body = nodeImageTableHTML(host, state);
  }
  return `<div class="card card-pad" style="margin-bottom:14px">${body}</div>`;
}

async function loadNodeImages(force = false) {
  const host = nodeImageHost();
  const poolIds = new Set(nodeImagePool().map((item) => item.id));
  for (const key of Object.keys(S.hostImages || {})) {
    if (!poolIds.has(key)) delete S.hostImages[key];
  }
  if (!host) { renderNodeImagesView(); return; }
  const cached = S.hostImages[host.id];
  if (!force && cached && !cached.loading && !cached.error) return;
  if (nodeImagesLoading) return;
  nodeImagesLoading = true;
  S.hostImages[host.id] = { loading: true, images: [] };
  try {
    const data = await api(`/hosts/${encodeURIComponent(host.id)}/images`);
    S.hostImages[host.id] = { images: data.images || [], total: data.total, fetchedAt: data.fetchedAt };
  } catch (err) {
    S.hostImages[host.id] = { images: [], error: errorText(err) };
  } finally {
    nodeImagesLoading = false;
  }
  renderNodeImagesView();
}

// 只在还停留在「查看服务器内镜像」时才重绘，避免打断其它页面
function renderNodeImagesView() {
  if (S.view === 'deploy' && S.deployTab === 'components' && componentSubTabOf(S.componentsTab) === 'node-images') renderView();
}

/**
 * 把镜像拉取到多台节点：镜像按节点独立存储，逐台执行，最后给出汇总。
 * input 可以是单台 host 或 host 数组。
 */
async function pullBaseImage(input, image, button) {
  const hosts = Array.isArray(input) ? input.filter(Boolean) : (input ? [input] : []);
  if (!hosts.length) { toast('请先选择要拉取的服务器', 'error'); return; }
  if (!image) return;
  const original = button ? button.innerHTML : '';
  const card = button ? button.closest('.card') : null;
  const status = card ? card.querySelector('[data-pull-status]') : null;
  const versionSelect = card ? card.querySelector('[data-image-version]') : null;
  if (versionSelect) versionSelect.disabled = true;
  const setStatus = (kind, html, title = '') => {
    if (!status) return;
    status.className = `image-pull-status show ${kind}`;
    status.innerHTML = kind === 'running'
      ? `<span class="spinner"></span><div class="image-pull-status-text">${html}</div>`
      : `${icon(kind === 'ok' ? 'check' : 'alert')}<div class="image-pull-status-text" title="${esc(title || '')}">${html}</div>`;
  };
  if (button) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.innerHTML = '<span class="spinner"></span> 拉取中…';
  }
  const failed = [];
  let done = 0;
  setStatus('running', `正在拉取 <span class="mono">${esc(image)}</span> 到 ${hosts.length} 台节点，大镜像可能需要几分钟…`);
  toast(`正在拉取 ${image}，大镜像可能需要几分钟…`, 'info', 4200);
  try {
    for (const [index, host] of hosts.entries()) {
      setStatus('running', `（${index + 1}/${hosts.length}）正在拉取到 <b>${esc(hostName(host))}</b>：<span class="mono">${esc(image)}</span>`);
      try {
        await api(`/hosts/${encodeURIComponent(host.id)}/images/pull`, {
          method: 'POST',
          body: { image }
        });
        done += 1;
      } catch (err) {
        failed.push(`${hostName(host)}：${errorText(err)}`);
      }
    }
  } finally {
    if (button && button.isConnected) {
      button.disabled = false;
      button.removeAttribute('aria-busy');
      button.innerHTML = original;
    }
    if (versionSelect && versionSelect.isConnected) versionSelect.disabled = false;
  }
  S.hostImages = {};
  if (!failed.length) {
    setStatus('ok', `已在 ${done} 台节点拉取完成：<span class="mono">${esc(image)}</span>
      <button class="btn-link" data-action="node-images-goto">查看服务器内镜像</button>`);
    toast(`镜像已拉取到 ${done} 台节点`, 'success', 3200);
  } else {
    setStatus('err', `成功 ${done} 台，失败 ${failed.length} 台：${esc(failed[0])}`, failed.join('；'));
    toast(`有 ${failed.length} 台拉取失败：${failed[0]}`, 'error', 8000);
  }
}

function importK3sImageTar(target, options = {}) {
  const hosts = (Array.isArray(target) ? target : [target]).filter(Boolean);
  if (!hosts.length) return;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.tar,application/x-tar';
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('cancel', () => input.remove());
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) { input.remove(); return; }
    if (!/\.tar$/i.test(file.name)) {
      toast('请选择 .tar 格式的镜像包', 'error');
      input.remove();
      return;
    }
    input.remove();
    const buttons = Array.from(document.querySelectorAll('[data-import-image], [data-import-image-multi], [data-action="node-images-import"]'));
    buttons.forEach((button) => {
      button.disabled = true;
      button.setAttribute('aria-busy', 'true');
    });
    const release = () => buttons.forEach((button) => {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    });
    let jobId = '';
    let uploadUrl = '';
    try {
      const created = await api('/images/import', {
        method: 'POST',
        body: { hostIds: hosts.map((host) => host.id), name: file.name, size: file.size }
      });
      jobId = created.jobId;
      uploadUrl = created.uploadUrl;
      release();
      openJobModal(jobId, { onEnd: release, onClose: options.onClose });
    } catch (err) {
      release();
      toast(errorText(err), 'error', 6000);
      return;
    }

    // 演示模式只展示跟踪窗口，不会真正上传文件
    if (DEMO) { release(); return; }

    // 跟踪窗口打开后再开始上传，上传进度会实时出现在窗口的步骤和日志里
    const headers = { 'Content-Type': 'application/octet-stream' };
    if (token()) headers['X-Access-Token'] = token();
    try {
      const res = await fetch(withToken(uploadUrl), {
        method: 'POST',
        headers,
        body: file
      });
      let data = null;
      try { data = await res.json(); } catch (_) { /* ignore */ }
      if (!res.ok || !data || data.ok === false) {
        throw new Error((data && data.error) || `导入失败（HTTP ${res.status}）`);
      }
    } catch (err) {
      // 用户主动取消时，跟踪窗口自己会提示「操作已取消」，这里不再重复报错
      const message = errorText(err);
      if (!/取消/.test(message)) toast(message, 'error', 6000);
      try { await api(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' }); } catch (_) { /* ignore */ }
    } finally {
      // 上传请求结束后按钮即可恢复，任务后续步骤在窗口里继续展示
      release();
    }
  });
  input.click();
}

// 安装插件：先弹服务器列表（可多选），同一个集群只提交一次
async function installCommunityComponent(id) {
  const component = COMMUNITY_COMPONENTS.find((c) => c.id === id);
  if (!component) return;
  const pool = deployOperationPool();
  if (!pool.length) { toast('还没有可用的服务器，请先添加并部署好 k3s 节点', 'error', 5000); return; }
  const picked = await pickHosts({
    hosts: pool,
    allowMixed: true,
    initial: pickInitialHostIds(pool),
    title: `安装 ${component.name}：选择服务器`,
    hint: '可以多选；同一个集群只会安装一次（HelmChart 是集群级资源）。插件由 k3s 内置 Helm Controller 异步安装。',
    confirmText: '选择这些服务器'
  });
  if (!picked.length) return;
  const targets = dedupeHostsByCluster(picked);
  const skipped = picked.length - targets.length;
  const targetText = targets.map((host) => `<b>${esc(hostName(host))}</b>`).join('、');
  const ok = await confirmDialog({
    title: `安装 ${component.name}`,
    message: `将通过 k3s Helm Controller 在 ${targetText} 上安装 <b>${esc(component.name)}</b> 到 <span class="code-inline">${esc(component.namespace)}</span>。
      ${targets.length > 1 ? `<br><br>共 ${targets.length} 个集群，会依次提交。` : ''}
      ${skipped ? `<br>已跳过同集群的 ${skipped} 台（HelmChart 是集群级资源，一个集群装一次即可）。` : ''}
      <br><br>插件安装是异步的，不会进入操作记录。`,
    confirmText: '安装插件',
    danger: false
  });
  if (!ok) return;
  const failed = [];
  let done = 0;
  for (const host of targets) {
    try {
      await api(`/hosts/${encodeURIComponent(host.id)}/apply`, {
        method: 'POST',
        body: { yaml: communityChartYaml(component) }
      });
      done += 1;
    } catch (err) {
      failed.push(`${hostName(host)}：${errorText(err)}`);
    }
  }
  if (!failed.length) {
    toast(`${component.name} 已提交到 ${done} 个集群，等待 Helm Controller 安装`, 'success', 3800);
  } else if (done) {
    toast(`${done} 个集群已提交，${failed.length} 个失败：${failed[0]}`, 'error', 8000);
  } else {
    toast(failed[0], 'error', 8000);
  }
}

// 拉取基础镜像：先弹服务器列表（可多选），再逐台拉取
async function pullBaseImageWithPicker(image, button) {
  if (!image) return;
  const pool = deployOperationPool();
  if (!pool.length) { toast('还没有可用的服务器，请先添加服务器', 'error', 5000); return; }
  const picked = await pickHosts({
    hosts: pool,
    allowMixed: true,
    initial: pickInitialHostIds(pool),
    title: '选择要拉取镜像的服务器',
    hint: '可以多选；镜像按节点独立存储，会逐台写入所选节点的本地镜像库。',
    confirmText: '开始拉取'
  });
  if (!picked.length) return;
  // 「查看服务器内镜像」只显示一台：取本次拉取的第一台，方便拉完直接核对
  S.hostImageTarget = picked[0].id;
  await pullBaseImage(picked, image, button);
}

function networkDefaultsFromYaml(yaml) {
  const fallback = {
    name: 'demo-app',
    namespace: 'default',
    selectorKey: 'app',
    selectorValue: 'demo-app',
    port: 80,
    targetPort: 80,
    serviceType: 'ClusterIP',
    protocol: 'TCP',
    ingressClass: 'nginx',
    host: '',
    path: '/',
    pathType: 'Prefix',
    backendService: 'demo-app',
    backendPort: 80,
    tlsSecret: '',
    policyKey: 'app',
    policyValue: 'demo-app',
    sourceNamespace: 'default',
    policyPort: 80
  };
  if (typeof jsyaml === 'undefined' || !jsyaml || typeof jsyaml.loadAll !== 'function') return fallback;
  try {
    const docs = jsyaml.loadAll(String(yaml || '')).filter((doc) => doc && typeof doc === 'object');
    const doc = docs[0];
    if (!doc) return fallback;
    const meta = doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
    const name = String(meta.name || fallback.name);
    const namespace = String(meta.namespace || fallback.namespace);
    const labels = meta.labels && typeof meta.labels === 'object' ? meta.labels : {};
    const labelKey = Object.keys(labels)[0] || fallback.selectorKey;
    const labelValue = String(labels[labelKey] || name);
    let port = fallback.port;
    const podSpec = doc.spec && doc.spec.template && doc.spec.template.spec ? doc.spec.template.spec : doc.spec;
    if (podSpec && Array.isArray(podSpec.containers) && podSpec.containers[0] && Array.isArray(podSpec.containers[0].ports) && podSpec.containers[0].ports[0]) {
      port = Number(podSpec.containers[0].ports[0].containerPort) || port;
    }
    const spec = doc.spec && typeof doc.spec === 'object' ? doc.spec : {};
    const result = {
      ...fallback,
      name,
      namespace,
      selectorKey: labelKey,
      selectorValue: labelValue,
      port,
      targetPort: port,
      backendService: name,
      backendPort: port,
      policyKey: labelKey,
      policyValue: labelValue,
      sourceNamespace: namespace
    };
    if (doc.kind === 'Service') {
      result.serviceType = spec.type || result.serviceType;
      if (spec.selector && typeof spec.selector === 'object') {
        const selectorKey = Object.keys(spec.selector)[0];
        if (selectorKey) {
          result.selectorKey = selectorKey;
          result.selectorValue = String(spec.selector[selectorKey] || '');
        }
      }
      if (Array.isArray(spec.ports) && spec.ports[0]) {
        port = Number(spec.ports[0].port) || port;
        result.port = port;
        result.protocol = spec.ports[0].protocol || result.protocol;
        result.targetPort = Number(spec.ports[0].targetPort) || port;
        result.nodePort = Number(spec.ports[0].nodePort) || null;
      }
    }
    if (doc.kind === 'NetworkPolicy') {
      const matchLabels = spec.podSelector && spec.podSelector.matchLabels && typeof spec.podSelector.matchLabels === 'object'
        ? spec.podSelector.matchLabels
        : {};
      const podKey = Object.keys(matchLabels)[0];
      if (podKey) {
        result.policyKey = podKey;
        result.policyValue = String(matchLabels[podKey] || '');
      }
      const rule = Array.isArray(spec.ingress) ? spec.ingress[0] : null;
      const from = rule && Array.isArray(rule.from) ? rule.from[0] : null;
      const namespaceLabels = from && from.namespaceSelector && from.namespaceSelector.matchLabels;
      if (namespaceLabels && typeof namespaceLabels === 'object') {
        result.sourceNamespace = String(namespaceLabels['kubernetes.io/metadata.name'] || result.sourceNamespace);
      } else {
        result.sourceNamespace = '';
      }
      if (rule && Array.isArray(rule.ports) && rule.ports[0]) {
        result.policyPort = Number(rule.ports[0].port) || null;
      }
    }
    if (doc.kind === 'Ingress') {
      result.ingressClass = spec.ingressClassName || result.ingressClass;
      const rule = Array.isArray(spec.rules) ? spec.rules[0] : null;
      const path = rule && rule.http && Array.isArray(rule.http.paths) ? rule.http.paths[0] : null;
      if (rule) result.host = rule.host || result.host;
      if (path) {
        result.path = path.path || result.path;
        result.pathType = path.pathType || result.pathType;
        const backend = path.backend && path.backend.service;
        if (backend) {
          result.backendService = backend.name || result.backendService;
          result.backendPort = Number(backend.port && backend.port.number) || result.backendPort;
        }
      }
      if (Array.isArray(spec.tls) && spec.tls[0]) result.tlsSecret = String(spec.tls[0].secretName || '');
    }
    return result;
  } catch (_) {
    return fallback;
  }
}

function networkFieldsHTML(kind, d = {}) {
  if (kind === 'ingress') {
    return `<div class="form-grid">
      <label class="field"><span class="field-label">IngressClass</span>
        <input class="input" id="netIngressClass" value="${esc(d.ingressClass || '')}" placeholder="例如 nginx；留空则不写" autocomplete="off" />
      </label>
      <label class="field"><span class="field-label">域名 Host</span>
        <input class="input" id="netHost" value="${esc(d.host || '')}" placeholder="例如 app.example.com；留空表示不限制域名" autocomplete="off" />
        <span class="help" id="netHostHint">必须是域名（不能填 IP，K8s 不接受）。留空表示不限制域名。</span>
      </label>
      <label class="field"><span class="field-label">路径</span>
        <input class="input" id="netPath" value="${esc(d.path || '/')}" placeholder="/" autocomplete="off" />
      </label>
      <label class="field"><span class="field-label">路径类型</span>
        <select class="select" id="netPathType">
          ${['Prefix', 'Exact', 'ImplementationSpecific'].map((item) => `<option value="${item}" ${item === (d.pathType || 'Prefix') ? 'selected' : ''}>${item}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span class="field-label">后端 Service 名称 <span class="req">*</span></span>
        <input class="input" id="netBackendService" value="${esc(d.backendService || '')}" autocomplete="off" />
      </label>
      <label class="field"><span class="field-label">后端 Service 端口 <span class="req">*</span></span>
        <input class="input" id="netBackendPort" type="number" min="1" max="65535" value="${esc(d.backendPort || 80)}" />
      </label>
      <label class="field full"><span class="field-label">TLS Secret（可选）</span>
        <input class="input" id="netTlsSecret" value="${esc(d.tlsSecret || '')}" placeholder="例如 app-tls；留空表示不配置 HTTPS" autocomplete="off" />
      </label>
    </div>`;
  }
  if (kind === 'networkpolicy') {
    return `<div class="form-grid">
      <label class="field"><span class="field-label">目标 Pod 标签 Key <span class="req">*</span></span>
        <input class="input" id="netPolicyKey" value="${esc(d.policyKey || 'app')}" autocomplete="off" />
      </label>
      <label class="field"><span class="field-label">目标 Pod 标签 Value <span class="req">*</span></span>
        <input class="input" id="netPolicyValue" value="${esc(d.policyValue || '')}" autocomplete="off" />
      </label>
      <label class="field"><span class="field-label">允许来源命名空间</span>
        <input class="input" id="netSourceNamespace" value="${esc(d.sourceNamespace || '')}" placeholder="例如 default；留空表示拒绝所有入站" autocomplete="off" />
        <span class="help">生成 ingress 规则，只允许该命名空间的 Pod 访问目标 Pod。</span>
      </label>
      <label class="field"><span class="field-label">允许端口（可选）</span>
        <input class="input" id="netPolicyPort" type="number" min="1" max="65535" value="${esc(d.policyPort || '')}" placeholder="例如 80；留空表示全部端口" />
      </label>
      <div class="tiny dim" style="grid-column:1/-1;line-height:1.7">这是入站策略（Ingress）；不会限制目标 Pod 主动访问外部服务。留空来源命名空间时会生成拒绝所有入站的 NetworkPolicy。</div>
    </div>`;
  }
  return `<div class="form-grid">
    <label class="field"><span class="field-label">Service 类型</span>
      <select class="select" id="netServiceType">
        ${['ClusterIP', 'NodePort', 'LoadBalancer'].map((item) => `<option value="${item}" ${item === (d.serviceType || 'ClusterIP') ? 'selected' : ''}>${item}</option>`).join('')}
      </select>
    </label>
    <label class="field"><span class="field-label">选择器 Key <span class="req">*</span></span>
      <input class="input" id="netSelectorKey" value="${esc(d.selectorKey || 'app')}" autocomplete="off" />
    </label>
    <label class="field"><span class="field-label">选择器 Value <span class="req">*</span></span>
      <input class="input" id="netSelectorValue" value="${esc(d.selectorValue || '')}" autocomplete="off" />
      <span class="help">要和目标工作负载的 labels 匹配，例如 Deployment 的 app=demo-app。</span>
    </label>
    <label class="field"><span class="field-label">Service 端口 <span class="req">*</span></span>
      <input class="input" id="netPort" type="number" min="1" max="65535" value="${esc(d.port || 80)}" />
    </label>
    <label class="field"><span class="field-label">目标端口</span>
      <input class="input" id="netTargetPort" type="number" min="1" max="65535" value="${esc(d.targetPort || d.port || 80)}" />
      <span class="help">容器实际监听的端口；留空时等于 Service 端口。</span>
    </label>
    <label class="field"><span class="field-label">协议</span>
      <select class="select" id="netProtocol">
        ${['TCP', 'UDP', 'SCTP'].map((item) => `<option value="${item}" ${item === (d.protocol || 'TCP') ? 'selected' : ''}>${item}</option>`).join('')}
      </select>
    </label>
    <label class="field"><span class="field-label">NodePort（可选）</span>
      <input class="input" id="netNodePort" type="number" min="30000" max="32767" value="${esc(d.nodePort || '')}" placeholder="30000-32767；ClusterIP 不生效" />
    </label>
  </div>`;
}

// 资源名称 / 容器名称等 DNS 标签的实时校验：返回空字符串表示合法，否则返回可直接展示的原因
function dnsLabelProblem(value, label = '名称', maxLength = 63) {
  const text = String(value || '').trim();
  if (!text) return `${label}不能为空`;
  const invalid = [...new Set(text.replace(/[a-z0-9-]/g, '').split(''))];
  if (invalid.length) {
    const shown = invalid.slice(0, 6).map((ch) => (ch === ' ' ? '空格' : ch)).join(' ');
    return `${label}不能包含「${shown}」，只能使用小写字母、数字和 -`;
  }
  if (/^-/.test(text)) return `${label}不能以 - 开头`;
  if (/-$/.test(text)) return `${label}不能以 - 结尾`;
  if (text.length > maxLength) return `${label}不能超过 ${maxLength} 个字符（当前 ${text.length}）`;
  return '';
}

function normalizeDnsLabelInput(input) {
  if (!input) return;
  const raw = input.value;
  const lower = raw.toLowerCase();
  if (lower === raw) return;
  const pos = typeof input.selectionStart === 'number' ? input.selectionStart : lower.length;
  input.value = lower;
  try { input.setSelectionRange(pos, pos); } catch (_) { /* ignore */ }
}

// 绑定实时校验：输入时自动把大写转小写，并就地显示原因
function attachDnsLabelHint(input, hint, label) {
  if (!input) return;
  const update = () => {
    normalizeDnsLabelInput(input);
    const problem = dnsLabelProblem(input.value, label);
    input.classList.toggle('bad', !!problem && input.value.trim() !== '');
    if (hint) {
      hint.textContent = input.value.trim() ? (problem || `${label}可用`) : problem;
      hint.className = `help ${problem ? 'err' : 'ok'}`;
    }
  };
  input.addEventListener('input', update);
  update();
}

function networkDnsLabel(value, label, maxLength = 63) {
  const problem = dnsLabelProblem(value, label, maxLength);
  if (problem) throw new Error(problem);
  return String(value || '').trim();
}

function networkOptionalDnsName(value, label) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (text.length > 253 || !/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/.test(text) || text.includes('..')) {
    throw new Error(`${label}格式不正确`);
  }
  return text;
}

function isIpAddress(text) {
  const value = String(text || '').trim();
  if (/^(\d{1,3})(\.\d{1,3}){3}$/.test(value) && value.split('.').every((part) => Number(part) <= 255)) return true;
  // IPv6 至少包含两个冒号且只由十六进制与冒号组成
  if (value.includes(':') && /^[0-9a-fA-F:.]+$/.test(value) && value.split(':').length >= 3) return true;
  return false;
}

// Ingress 的 host 必须是 DNS 名称（可写成 *.example.com），K8s 明确拒绝 IP；留空表示不限制域名
function ingressHostProblem(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (isIpAddress(text)) {
    return `域名不能填 IP 地址（${text}），K8s 要求 Ingress 的 host 必须是域名；想直接用节点 IP 访问请留空域名（留空即不限制域名）`;
  }
  const body = text.startsWith('*.') ? text.slice(2) : text;
  if (!body) return '域名格式不正确';
  const invalid = [...new Set(body.replace(/[a-z0-9.-]/g, '').split(''))];
  if (invalid.length) {
    const shown = invalid.slice(0, 6).map((ch) => (ch === ' ' ? '空格' : ch)).join(' ');
    return `域名不能包含「${shown}」，只能使用小写字母、数字、. 和 -`;
  }
  if (body.length > 253) return `域名不能超过 253 个字符（当前 ${body.length}）`;
  if (body.startsWith('.') || body.endsWith('.') || body.includes('..')) return '域名不能以 . 开头/结尾，也不能有连续的 .';
  for (const label of body.split('.')) {
    if (label.length > 63) return `域名的每一段不能超过 63 个字符（${label} 有 ${label.length} 个）`;
    if (/^-/.test(label)) return `域名的每一段不能以 - 开头（${label}）`;
    if (/-$/.test(label)) return `域名的每一段不能以 - 结尾（${label}）`;
  }
  return '';
}

// 统一入口：去空格、转小写后校验，通过则返回可写入 YAML 的值
function ingressHostValue(value) {
  const text = String(value || '').trim().toLowerCase();
  const problem = ingressHostProblem(text);
  if (problem) throw new Error(problem);
  return text;
}

function attachIngressHostHint(input, hint) {
  if (!input) return;
  const update = () => {
    const raw = input.value;
    const lower = raw.toLowerCase();
    if (lower !== raw) {
      const pos = typeof input.selectionStart === 'number' ? input.selectionStart : lower.length;
      input.value = lower;
      try { input.setSelectionRange(pos, pos); } catch (_) { /* ignore */ }
    }
    const problem = ingressHostProblem(input.value);
    input.classList.toggle('bad', !!problem);
    if (hint) {
      hint.textContent = problem || (input.value.trim() ? '域名格式可用' : '留空表示不限制域名（任何域名 / 节点 IP 都能访问）');
      hint.className = `help ${problem ? 'err' : 'ok'}`;
    }
  };
  input.addEventListener('input', update);
  update();
}

function networkLabelValue(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (text.length > 63 || !/^[A-Za-z0-9]([-A-Za-z0-9_.]*[A-Za-z0-9])?$/.test(text)) {
    throw new Error(`${label}必须是 63 个字符以内的字母、数字、-、_ 或 .`);
  }
  return text;
}

function networkLabelKey(value, label) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (text.length > 253 || !/^[A-Za-z0-9]([-A-Za-z0-9_.\/]*[A-Za-z0-9])?$/.test(text)) {
    throw new Error(`${label}格式不正确`);
  }
  return text;
}

function networkPort(value, label, optional = false) {
  const text = String(value || '').trim();
  if (!text) {
    if (optional) return null;
    throw new Error(`${label}不能为空`);
  }
  if (!/^\d+$/.test(text)) throw new Error(`${label}必须是数字`);
  const port = Number(text);
  if (port < 1 || port > 65535) throw new Error(`${label}必须在 1-65535 之间`);
  return port;
}

function networkInteger(value, label, min, max) {
  const text = String(value || '').trim();
  if (!text) throw new Error(`${label}不能为空`);
  if (!/^\d+$/.test(text)) throw new Error(`${label}必须是数字`);
  const number = Number(text);
  if (number < min || number > max) throw new Error(`${label}必须在 ${min}-${max} 之间`);
  return number;
}

function networkNodePort(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (!/^\d+$/.test(text)) throw new Error('NodePort 必须是数字');
  const port = Number(text);
  if (port < 30000 || port > 32767) throw new Error('NodePort 必须在 30000-32767 之间');
  return port;
}

function readNetworkForm(kind) {
  const value = (id) => {
    const el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  };
  const name = networkDnsLabel(value('netName'), '资源名称');
  const namespaceText = value('netNamespace');
  const namespace = namespaceText ? networkDnsLabel(namespaceText, '命名空间') : '';
  if (kind === 'ingress') {
    const host = ingressHostValue(value('netHost'));
    const path = value('netPath') || '/';
    if (!path.startsWith('/')) throw new Error('路径必须以 / 开头');
    const pathType = value('netPathType') || 'Prefix';
    if (!['Prefix', 'Exact', 'ImplementationSpecific'].includes(pathType)) throw new Error('路径类型不正确');
    const backendService = networkDnsLabel(value('netBackendService'), '后端 Service 名称');
    const backendPort = networkPort(value('netBackendPort'), '后端 Service 端口');
    const tlsSecret = networkOptionalDnsName(value('netTlsSecret'), 'TLS Secret');
    if (tlsSecret && !host) throw new Error('填写 TLS Secret 前请先填写域名');
    return { kind, name, namespace, host, path, pathType, backendService, backendPort, tlsSecret, ingressClass: value('netIngressClass') };
  }
  if (kind === 'networkpolicy') {
    return {
      kind,
      name,
      namespace,
      policyKey: networkLabelKey(value('netPolicyKey'), '目标 Pod 标签 Key'),
      policyValue: networkLabelValue(value('netPolicyValue'), '目标 Pod 标签 Value'),
      sourceNamespace: value('netSourceNamespace') ? networkDnsLabel(value('netSourceNamespace'), '来源命名空间') : '',
      policyPort: networkPort(value('netPolicyPort'), '允许端口', true)
    };
  }
  const serviceType = value('netServiceType') || 'ClusterIP';
  if (!['ClusterIP', 'NodePort', 'LoadBalancer'].includes(serviceType)) throw new Error('Service 类型不正确');
  return {
    kind: 'service',
    name,
    namespace,
    serviceType,
    selectorKey: networkLabelKey(value('netSelectorKey'), '选择器 Key'),
    selectorValue: networkLabelValue(value('netSelectorValue'), '选择器 Value'),
    port: networkPort(value('netPort'), 'Service 端口'),
    targetPort: networkPort(value('netTargetPort'), '目标端口', true),
    protocol: value('netProtocol') || 'TCP',
    nodePort: networkNodePort(value('netNodePort'))
  };
}

function buildNetworkObject(form) {
  const metadata = { name: form.name };
  if (form.namespace) metadata.namespace = form.namespace;
  if (form.kind === 'service') {
    const port = {
      name: form.protocol === 'UDP' ? 'udp' : form.protocol === 'SCTP' ? 'sctp' : 'http',
      port: form.port,
      targetPort: form.targetPort || form.port,
      protocol: form.protocol
    };
    if (form.nodePort && form.serviceType !== 'ClusterIP') port.nodePort = form.nodePort;
    return {
      apiVersion: 'v1',
      kind: 'Service',
      metadata,
      spec: {
        selector: { [form.selectorKey]: form.selectorValue },
        ports: [port],
        type: form.serviceType
      }
    };
  }
  if (form.kind === 'ingress') {
    const rule = {
      http: {
        paths: [{
          path: form.path,
          pathType: form.pathType,
          backend: { service: { name: form.backendService, port: { number: form.backendPort } } }
        }]
      }
    };
    if (form.host) rule.host = form.host;
    const spec = { rules: [rule] };
    if (form.ingressClass) spec.ingressClassName = form.ingressClass;
    if (form.tlsSecret && form.host) spec.tls = [{ hosts: [form.host], secretName: form.tlsSecret }];
    return { apiVersion: 'networking.k8s.io/v1', kind: 'Ingress', metadata, spec };
  }
  const spec = {
    podSelector: { matchLabels: { [form.policyKey]: form.policyValue } },
    policyTypes: ['Ingress']
  };
  if (form.sourceNamespace) {
    const rule = {
      from: [{
        namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': form.sourceNamespace } }
      }]
    };
    if (form.policyPort) rule.ports = [{ protocol: 'TCP', port: form.policyPort }];
    spec.ingress = [rule];
  }
  return { apiVersion: 'networking.k8s.io/v1', kind: 'NetworkPolicy', metadata, spec };
}

function dumpYamlObjects(objects) {
  if (typeof jsyaml === 'undefined' || !jsyaml || typeof jsyaml.dump !== 'function') {
    throw new Error('YAML 解析器未加载，无法生成 YAML');
  }
  return objects
    .map((object) => String(jsyaml.dump(object, { noRefs: true, lineWidth: -1 })).replace(/\s+$/, ''))
    .join('\n---\n') + '\n';
}

// 工作负载表单里的即时反馈：容器名称实时校验、IngressClass 手动改过就不再自动覆盖
function bindWorkloadFieldHints(fields, host) {
  if (!fields) return;
  attachDnsLabelHint($('#wlContainerName', fields), $('#wlContainerNameHint', fields), '容器名称');
  attachIngressHostHint($('#wlIngressHost', fields), $('#wlIngressHostHint', fields));
  const ingressClassInput = $('#wlIngressClass', fields);
  if (ingressClassInput) {
    ingressClassInput.addEventListener('input', () => { ingressClassInput.dataset.dirty = '1'; });
    ingressClassInput.addEventListener('change', () => { ingressClassInput.dataset.dirty = '1'; });
    const hint = $('#wlIngressClassHint', fields);
    if (hint && host) hint.textContent = ingressClassHintText(host);
  }
}

function workloadFieldsHTML(kind, d = {}) {

  const showReplicas = ['deployment', 'statefulset', 'replicaset'].includes(kind);
  const showSchedule = kind === 'cronjob';
  const showCommand = kind === 'job' || kind === 'cronjob';
  const showExpose = kind === 'deployment';
  return `<div class="form-grid">
    ${showReplicas ? `<label class="field"><span class="field-label">副本数 <span class="req">*</span></span>
      <input class="input" id="wlReplicas" type="number" min="1" max="100" value="${esc(d.replicas || 2)}" />
    </label>` : ''}
    <label class="field"><span class="field-label">容器名称 <span class="req">*</span></span>
      <input class="input" id="wlContainerName" value="${esc(d.containerName || 'app')}" autocomplete="off" />
      <span class="help" id="wlContainerNameHint">Pod 内该容器的名字，用于 kubectl logs -c / exec -c，保持 app 即可。</span>
    </label>
    <label class="field full"><span class="field-label">镜像 <span class="req">*</span></span>
      <input class="input" id="wlImage" value="${esc(d.image || '')}" placeholder="必填，例如 nginx:1.27-alpine 或 harbor.example.com/app/web:v1" autocomplete="off" />
    </label>
    ${kind === 'statefulset' ? `<label class="field"><span class="field-label">Headless Service 名称 <span class="req">*</span></span>
      <input class="input" id="wlServiceName" value="${esc(d.serviceName || '')}" placeholder="留空时使用 <资源名>-headless" autocomplete="off" />
    </label>` : ''}
    ${showSchedule ? `<label class="field"><span class="field-label">Cron 调度 <span class="req">*</span></span>
      <input class="input" id="wlSchedule" value="${esc(d.schedule || '0 3 * * *')}" placeholder="例如 0 3 * * *" autocomplete="off" />
    </label>` : ''}
    <label class="field"><span class="field-label">容器端口 <span class="req">*</span></span>
      <input class="input" id="wlContainerPort" type="number" min="1" max="65535" value="${esc(d.containerPort || 80)}" />
    </label>
    <label class="field"><span class="field-label">镜像拉取策略</span>
      <select class="select" id="wlImagePullPolicy">
        ${['IfNotPresent', 'Always', 'Never'].map((item) => `<option value="${item}" ${item === (d.imagePullPolicy || 'IfNotPresent') ? 'selected' : ''}>${item}</option>`).join('')}
      </select>
    </label>
    ${showCommand ? `<label class="field full"><span class="field-label">启动命令（可选）</span>
      <input class="input" id="wlCommand" value="${esc(d.command || '')}" placeholder="例如 /bin/sh -c 'echo hello'；留空使用镜像默认命令" autocomplete="off" />
    </label>` : ''}
    <label class="field full"><span class="field-label">环境变量</span>
      <textarea class="input" id="wlEnv" rows="4" style="min-height:82px;font-family:var(--mono)" placeholder="每行一个 KEY=VALUE，例如：&#10;APP_ENV=production&#10;LOG_LEVEL=info">${esc(d.env || '')}</textarea>
      <span class="help">支持注释行 #；值可以为空。</span>
    </label>
    <label class="field"><span class="field-label">CPU 请求</span>
      <input class="input" id="wlCpuRequest" value="${esc(d.cpuRequest || '50m')}" placeholder="例如 50m" autocomplete="off" />
    </label>
    <label class="field"><span class="field-label">内存请求</span>
      <input class="input" id="wlMemRequest" value="${esc(d.memRequest || '64Mi')}" placeholder="例如 64Mi" autocomplete="off" />
    </label>
    <label class="field"><span class="field-label">CPU 限制</span>
      <input class="input" id="wlCpuLimit" value="${esc(d.cpuLimit || '500m')}" placeholder="例如 500m" autocomplete="off" />
    </label>
    <label class="field"><span class="field-label">内存限制</span>
      <input class="input" id="wlMemLimit" value="${esc(d.memLimit || '256Mi')}" placeholder="例如 256Mi" autocomplete="off" />
    </label>
    ${showExpose ? `
    <div class="full" style="border-top:1px solid var(--line);padding-top:12px;margin-top:2px">
      <label class="check"><input type="checkbox" id="wlExposeService" ${d.exposeService ? 'checked' : ''} /> 同时创建 Service，并通过 <span class="code-inline">app</span> 标签选中该 Deployment</label>
    </div>
    <div class="full hidden" id="wlServiceFields">
      <div class="form-grid">
        <label class="field"><span class="field-label">Service 类型</span>
          <select class="select" id="wlServiceType">
            ${['ClusterIP', 'NodePort', 'LoadBalancer'].map((item) => `<option value="${item}" ${item === (d.serviceType || 'ClusterIP') ? 'selected' : ''}>${item}</option>`).join('')}
          </select>
        </label>
        <label class="field"><span class="field-label">Service 端口</span>
          <input class="input" id="wlServicePort" type="number" min="1" max="65535" value="${esc(d.servicePort || d.containerPort || 80)}" />
        </label>
      </div>
    </div>
    <div class="full" style="border-top:1px solid var(--line);padding-top:12px;margin-top:2px">
      <label class="check"><input type="checkbox" id="wlExposeIngress" ${d.exposeIngress ? 'checked' : ''} /> 同时创建 Ingress（会自动创建上面的 Service）</label>
    </div>
    <div class="full hidden" id="wlIngressFields">
      <div class="form-grid">
        <label class="field"><span class="field-label">域名 Host（可留空）</span>
          <input class="input" id="wlIngressHost" value="${esc(d.ingressHost || '')}" placeholder="例如 app.example.com；留空表示不限制域名" autocomplete="off" />
          <span class="help" id="wlIngressHostHint">必须是域名（不能填 IP）。留空时不写 host 规则，任何域名 / 节点 IP 都能访问。</span>
        </label>
        <label class="field"><span class="field-label">IngressClass</span>
          <input class="input" id="wlIngressClass" value="${esc(d.ingressClass || '')}" placeholder="留空则用集群默认" list="wlIngressClassList" autocomplete="off" />
          <datalist id="wlIngressClassList">${(Array.isArray(d.ingressClassOptions) ? d.ingressClassOptions : []).map((name) => `<option value="${esc(name)}"></option>`).join('')}</datalist>
          <span class="help" id="wlIngressClassHint">留空则使用集群默认 IngressClass；也可手动填写（例如 traefik / nginx）。</span>
        </label>
        <label class="field"><span class="field-label">路径</span>
          <input class="input" id="wlIngressPath" value="${esc(d.ingressPath || '/')}" autocomplete="off" />
        </label>
        <label class="field"><span class="field-label">TLS Secret（可选）</span>
          <input class="input" id="wlIngressTls" value="${esc(d.ingressTls || '')}" placeholder="例如 app-tls" autocomplete="off" />
          <span class="help">填 TLS 时必须同时填域名。</span>
        </label>
      </div>
    </div>` : ''}
  </div>`;
}

// ===== IngressClass 自动识别 =====
function ingressClassCache(host) {
  if (!host) return null;
  const cached = S.ingressClasses && S.ingressClasses[host.id];
  return Array.isArray(cached) ? cached : null;
}

async function loadIngressClasses(host, force = false) {
  if (!host) return [];
  if (!force && ingressClassCache(host)) return ingressClassCache(host);
  S.ingressClassesLoading = S.ingressClassesLoading || {};
  if (S.ingressClassesLoading[host.id]) return [];
  S.ingressClassesLoading[host.id] = true;
  try {
    const data = await api(`/hosts/${encodeURIComponent(host.id)}/resources?kind=ingressclasses`);
    const items = Array.isArray(data && data.items) ? data.items : [];
    S.ingressClasses[host.id] = items.map((item) => ({
      name: String(item.name || ''),
      controller: String(item.controller || ''),
      isDefault: !!item.default
    })).filter((item) => item.name);
    return S.ingressClasses[host.id];
  } catch (_) {
    S.ingressClasses[host.id] = [];
    return [];
  } finally {
    delete S.ingressClassesLoading[host.id];
  }
}

// 有默认 class 用默认的；只有一个就用它；多个时优先 nginx / traefik；都没有则留空（走集群默认）
function defaultIngressClass(host) {
  const list = ingressClassCache(host) || [];
  if (!list.length) return '';
  const preferred = list.find((item) => item.isDefault);
  if (preferred) return preferred.name;
  if (list.length === 1) return list[0].name;
  const nginx = list.find((item) => item.name === 'nginx');
  if (nginx) return nginx.name;
  const traefik = list.find((item) => item.name === 'traefik');
  if (traefik) return traefik.name;
  return list[0].name;
}

function ingressClassHintText(host) {
  const list = ingressClassCache(host);
  if (!list) return '留空则使用集群默认 IngressClass；也可手动填写（例如 traefik / nginx）。';
  if (!list.length) return '当前集群没有可用的 IngressClass，留空时会不写该字段。';
  const names = list.map((item) => `${item.name}${item.isDefault ? '（默认）' : ''}`).join('、');
  if (list.some((item) => item.isDefault)) {
    return `当前集群可用：${names}；留空则使用默认 IngressClass。`;
  }
  return `当前集群可用：${names}（没有标记默认 class）；请明确指定，留空可能没有控制器接管。`;
}

function namespaceNameList(host, extra) {
  const seen = new Set();
  const names = [];
  const push = (value) => {
    const name = String(value || '').trim();
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  };
  push(extra);
  const cached = (host && S.namespaces[host.id]) || [];
  for (const item of cached) push(typeof item === 'string' ? item : (item && item.name));
  if (!names.length) push('default');
  // 与工作负载页的命名空间筛选保持一致，按名称排序
  return names.sort((a, b) => a.localeCompare(b));
}

function namespaceSelectOptionsHTML(selected, host) {
  const value = String(selected || '').trim();
  return namespaceNameList(host, value)
    .map((name) => `<option value="${esc(name)}" ${name === value ? 'selected' : ''}>${esc(name)}</option>`)
    .join('');
}

function parseWorkloadEnv(text) {
  const env = [];
  const lines = String(text || '').split('\n');
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) throw new Error('环境变量每行格式必须是 KEY=VALUE');
    const name = line.slice(0, index).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`环境变量名 ${name} 格式不正确`);
    env.push({ name, value: line.slice(index + 1) });
  }
  return env;
}

function readWorkloadForm(kind) {
  const value = (id) => {
    const el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  };
  const checked = (id) => {
    const el = document.getElementById(id);
    return !!(el && el.checked);
  };
  const name = networkDnsLabel(value('netName'), '资源名称');
  const namespaceText = value('netNamespace');
  const namespace = namespaceText ? networkDnsLabel(namespaceText, '命名空间') : '';
  const image = value('wlImage');
  if (!image) throw new Error('镜像不能为空');
  const containerName = networkDnsLabel(value('wlContainerName'), '容器名称');
  const replicas = ['deployment', 'statefulset', 'replicaset'].includes(kind)
    ? networkInteger(value('wlReplicas'), '副本数', 1, 100)
    : 1;
  const serviceName = kind === 'statefulset'
    ? networkDnsLabel(value('wlServiceName') || `${name}-headless`, 'Headless Service 名称')
    : '';
  const schedule = kind === 'cronjob' ? value('wlSchedule') : '';
  if (kind === 'cronjob') {
    if (!schedule) throw new Error('Cron 调度不能为空');
    if (schedule.split(/\s+/).length !== 5) throw new Error('Cron 调度需要 5 个字段，例如 0 3 * * *');
  }
  const command = ['job', 'cronjob'].includes(kind) ? value('wlCommand') : '';
  const containerPort = networkPort(value('wlContainerPort'), '容器端口');
  const imagePullPolicy = value('wlImagePullPolicy') || 'IfNotPresent';
  if (!['IfNotPresent', 'Always', 'Never'].includes(imagePullPolicy)) throw new Error('镜像拉取策略不正确');
  const env = parseWorkloadEnv(value('wlEnv'));
  const cpuRequest = value('wlCpuRequest');
  const memRequest = value('wlMemRequest');
  const cpuLimit = value('wlCpuLimit');
  const memLimit = value('wlMemLimit');
  const exposeIngress = kind === 'deployment' && checked('wlExposeIngress');
  const exposeService = kind === 'deployment' && (checked('wlExposeService') || exposeIngress);
  const serviceType = value('wlServiceType') || 'ClusterIP';
  if (exposeService && !['ClusterIP', 'NodePort', 'LoadBalancer'].includes(serviceType)) throw new Error('Service 类型不正确');
  const servicePort = exposeService ? networkPort(value('wlServicePort'), 'Service 端口') : null;
  const ingressHost = exposeIngress ? ingressHostValue(value('wlIngressHost')) : '';
  const ingressPath = value('wlIngressPath') || '/';
  if (exposeIngress && !ingressPath.startsWith('/')) throw new Error('Ingress 路径必须以 / 开头');
  const ingressClass = value('wlIngressClass');
  const ingressTls = exposeIngress ? networkOptionalDnsName(value('wlIngressTls'), 'TLS Secret') : '';
  if (ingressTls && !ingressHost) throw new Error('填写 TLS Secret 时必须填写域名；域名留空时请清空 TLS Secret');
  return {
    kind,
    name,
    namespace,
    image,
    containerName,
    replicas,
    serviceName,
    schedule,
    command,
    containerPort,
    imagePullPolicy,
    env,
    cpuRequest,
    memRequest,
    cpuLimit,
    memLimit,
    exposeService,
    exposeIngress,
    serviceType,
    servicePort,
    ingressHost,
    ingressPath,
    ingressClass,
    ingressTls
  };
}

function buildWorkloadObjects(form) {
  const labels = { app: form.name };
  const metadata = { name: form.name, labels };
  if (form.namespace) metadata.namespace = form.namespace;
  const container = {
    name: form.containerName,
    image: form.image,
    imagePullPolicy: form.imagePullPolicy,
    ports: [{ name: 'http', containerPort: form.containerPort, protocol: 'TCP' }]
  };
  if (form.command) container.command = ['/bin/sh', '-c', form.command];
  if (form.env.length) container.env = form.env;
  const requests = {};
  if (form.cpuRequest) requests.cpu = form.cpuRequest;
  if (form.memRequest) requests.memory = form.memRequest;
  const limits = {};
  if (form.cpuLimit) limits.cpu = form.cpuLimit;
  if (form.memLimit) limits.memory = form.memLimit;
  if (Object.keys(requests).length || Object.keys(limits).length) {
    container.resources = {};
    if (Object.keys(requests).length) container.resources.requests = requests;
    if (Object.keys(limits).length) container.resources.limits = limits;
  }
  const podSpec = { containers: [container] };
  const template = { metadata: { labels }, spec: podSpec };
  const selector = { matchLabels: labels };
  const objects = [];
  switch (form.kind) {
    case 'pod':
      objects.push({ apiVersion: 'v1', kind: 'Pod', metadata, spec: podSpec });
      break;
    case 'statefulset':
      objects.push({
        apiVersion: 'apps/v1',
        kind: 'StatefulSet',
        metadata,
        spec: {
          serviceName: form.serviceName,
          replicas: form.replicas,
          selector,
          template
        }
      });
      objects.push({
        apiVersion: 'v1',
        kind: 'Service',
        metadata: { name: form.serviceName, ...(form.namespace ? { namespace: form.namespace } : {}), labels },
        spec: {
          clusterIP: 'None',
          selector: labels,
          ports: [{ name: 'http', port: form.containerPort, targetPort: form.containerPort, protocol: 'TCP' }]
        }
      });
      break;
    case 'daemonset':
      objects.push({ apiVersion: 'apps/v1', kind: 'DaemonSet', metadata, spec: { selector, template } });
      break;
    case 'replicaset':
      objects.push({ apiVersion: 'apps/v1', kind: 'ReplicaSet', metadata, spec: { replicas: form.replicas, selector, template } });
      break;
    case 'job':
      objects.push({
        apiVersion: 'batch/v1',
        kind: 'Job',
        metadata,
        spec: { template: { metadata: { labels }, spec: { ...podSpec, restartPolicy: 'Never' } } }
      });
      break;
    case 'cronjob':
      objects.push({
        apiVersion: 'batch/v1',
        kind: 'CronJob',
        metadata,
        spec: {
          schedule: form.schedule,
          concurrencyPolicy: 'Forbid',
          jobTemplate: {
            spec: {
              template: {
                metadata: { labels },
                spec: { ...podSpec, restartPolicy: 'OnFailure' }
              }
            }
          }
        }
      });
      break;
    default:
      objects.push({
        apiVersion: 'apps/v1',
        kind: 'Deployment',
        metadata,
        spec: { replicas: form.replicas, selector, template }
      });
      break;
  }
  if (form.exposeService) {
    objects.push({
      apiVersion: 'v1',
      kind: 'Service',
      metadata: { name: form.name, ...(form.namespace ? { namespace: form.namespace } : {}), labels },
      spec: {
        selector: labels,
        ports: [{ name: 'http', port: form.servicePort, targetPort: form.containerPort, protocol: 'TCP' }],
        type: form.serviceType
      }
    });
  }
  if (form.exposeIngress) {
    // 域名留空时不写 host 字段：这条规则对所有域名 / IP 生效（catch-all）
    const rule = {
      http: {
        paths: [{
          path: form.ingressPath,
          pathType: 'Prefix',
          backend: { service: { name: form.name, port: { number: form.servicePort } } }
        }]
      }
    };
    if (form.ingressHost) rule.host = form.ingressHost;
    const spec = { rules: [rule] };
    if (form.ingressClass) spec.ingressClassName = form.ingressClass;
    if (form.ingressTls && form.ingressHost) spec.tls = [{ hosts: [form.ingressHost], secretName: form.ingressTls }];
    objects.push({
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: { name: form.name, ...(form.namespace ? { namespace: form.namespace } : {}), labels },
      spec
    });
  }
  return objects;
}

function podConfigDefaultBase(label, name, namespace) {
  const ns = String(namespace || '').trim() || 'default';
  const resourceName = String(name || '').trim() || 'config';
  return `新增-${String(label || 'Config').trim() || 'Config'}-${ns}-${resourceName}`;
}

function normalizeTemplateFileName(name) {
  let fileName = String(name || '').trim();
  if (!fileName) return '';
  if (!/\.ya?ml$/i.test(fileName)) fileName += '.yaml';
  return fileName;
}

function templateFileNameConflict(name, ignoreId = '') {
  const fileName = normalizeTemplateFileName(name);
  if (!fileName) return null;
  const ignore = String(ignoreId || '').toLowerCase();
  return (S.deploymentTemplates || []).find((item) => {
    if (!item || typeof item.id !== 'string') return false;
    if (ignore && item.id.toLowerCase() === ignore) return false;
    return item.id.toLowerCase() === fileName.toLowerCase();
  }) || null;
}

function promptTemplateOverwrite(modal, fileName, hint = '') {
  return new Promise((resolve) => {
    const body = $('.modal-body', modal.el);
    if (!body) {
      resolve(false);
      return;
    }
    const old = $('#wlOverwriteNotice', modal.el);
    if (old) old.remove();
    const notice = document.createElement('div');
    notice.id = 'wlOverwriteNotice';
    notice.className = 'alert warn';
    notice.style.marginBottom = '14px';
    notice.innerHTML = `${icon('alert')}<div>配置文件「${esc(fileName)}」已存在，是否覆盖？${hint ? `<br><span class="tiny">${esc(hint)}</span>` : ''}
      <div class="row" style="margin-top:10px;gap:8px">
        <button type="button" class="btn sm" id="wlOverwriteCancel">取消</button>
        <button type="button" class="btn sm danger" id="wlOverwriteConfirm">覆盖</button>
      </div></div>`;
    body.prepend(notice);
    body.scrollTop = 0;
    const finish = (ok) => {
      notice.remove();
      resolve(ok);
    };
    $('#wlOverwriteCancel', notice).addEventListener('click', () => finish(false));
    $('#wlOverwriteConfirm', notice).addEventListener('click', () => finish(true));
    setTimeout(() => {
      const confirm = $('#wlOverwriteConfirm', notice);
      if (confirm) confirm.focus();
    }, 30);
  });
}

async function saveAddTemplate(data) {
  const name = podConfigDefaultBase(data.label, data.name, data.namespace);
  const result = await api('/templates', { method: 'POST', body: { name, yaml: data.yaml } });
  if (result && result.template) {
    S.deploymentTemplates = S.deploymentTemplates || [];
    const index = S.deploymentTemplates.findIndex((item) => item.id === result.template.id);
    if (index >= 0) S.deploymentTemplates[index] = result.template;
    else S.deploymentTemplates.push(result.template);
    S.deploymentTemplates.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
    if ($('#yamlTemplate')) refreshYamlTemplateOptions(`custom:${result.template.id}`);
  }
  return result.template;
}

const ADD_RESOURCE_META = {
  pods: { form: 'pod', label: 'Pod' },
  deployments: { form: 'deployment', label: 'Deployment' },
  statefulsets: { form: 'statefulset', label: 'StatefulSet' },
  daemonsets: { form: 'daemonset', label: 'DaemonSet' },
  replicasets: { form: 'replicaset', label: 'ReplicaSet' },
  jobs: { form: 'job', label: 'Job' },
  cronjobs: { form: 'cronjob', label: 'CronJob' },
  services: { form: 'service', label: 'Service' },
  ingresses: { form: 'ingress', label: 'Ingress' },
  networkpolicies: { form: 'networkpolicy', label: 'NetworkPolicy' },
  configmaps: { form: 'configmap', label: 'ConfigMap' },
  namespaces: { form: 'namespace', label: 'Namespace' }
};

const ADD_NAME_DEFAULTS = {
  pods: 'demo-pod',
  deployments: 'demo-app',
  statefulsets: 'demo-app',
  daemonsets: 'demo-agent',
  replicasets: 'demo-app',
  jobs: 'demo-job',
  cronjobs: 'demo-backup',
  services: 'demo-app',
  ingresses: 'demo-app',
  networkpolicies: 'demo-app-allow',
  configmaps: 'demo-config',
  namespaces: 'demo'
};

const WORKLOAD_FORM_KINDS = new Set(['pod', 'deployment', 'statefulset', 'daemonset', 'replicaset', 'job', 'cronjob']);

function addKindKeyForLabel(kind) {
  return Object.keys(ADD_RESOURCE_META).find((key) => ADD_RESOURCE_META[key].label === String(kind || '')) || '';
}

function addKindKeyForYaml(yaml) {
  if (typeof jsyaml === 'undefined' || !jsyaml || typeof jsyaml.loadAll !== 'function') return '';
  try {
    const doc = jsyaml.loadAll(String(yaml || '')).find((item) => item && typeof item === 'object');
    return doc ? addKindKeyForLabel(doc.kind) : '';
  } catch (_) {
    return '';
  }
}

function workloadDefaultsFromDoc(kind, doc) {
  const meta = doc && doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
  const spec = doc && doc.spec && typeof doc.spec === 'object' ? doc.spec : {};
  const podSpec = kind === 'pod'
    ? spec
    : kind === 'cronjob'
      ? (spec.jobTemplate && spec.jobTemplate.spec && spec.jobTemplate.spec.template && spec.jobTemplate.spec.template.spec) || {}
      : (spec.template && spec.template.spec) || {};
  const container = Array.isArray(podSpec.containers) && podSpec.containers[0] ? podSpec.containers[0] : {};
  const port = Array.isArray(container.ports) && container.ports[0] ? Number(container.ports[0].containerPort) || 80 : 80;
  const resources = container.resources && typeof container.resources === 'object' ? container.resources : {};
  const requests = resources.requests && typeof resources.requests === 'object' ? resources.requests : {};
  const limits = resources.limits && typeof resources.limits === 'object' ? resources.limits : {};
  const env = Array.isArray(container.env)
    ? container.env
      .filter((item) => item && item.name && Object.prototype.hasOwnProperty.call(item, 'value'))
      .map((item) => `${item.name}=${item.value}`)
      .join('\n')
    : '';
  const command = Array.isArray(container.command)
    ? (container.command[0] === '/bin/sh' && container.command[1] === '-c'
      ? String(container.command[2] || '')
      : container.command.join(' '))
    : '';
  return {
    name: String(meta.name || ''),
    namespace: String(meta.namespace || ''),
    replicas: Number(spec.replicas) || 2,
    containerName: String(container.name || 'app'),
    image: String(container.image || ''),
    serviceName: kind === 'statefulset' ? String(spec.serviceName || '') : '',
    schedule: kind === 'cronjob' ? String(spec.schedule || '') : '',
    command,
    containerPort: port,
    imagePullPolicy: ['IfNotPresent', 'Always', 'Never'].includes(container.imagePullPolicy) ? container.imagePullPolicy : 'IfNotPresent',
    env,
    cpuRequest: String(requests.cpu || ''),
    memRequest: String(requests.memory || ''),
    cpuLimit: String(limits.cpu || ''),
    memLimit: String(limits.memory || '')
  };
}

function graphicalDefaultsForKind(kindKey, yaml) {
  const meta = ADD_RESOURCE_META[kindKey];
  if (!meta) return { ok: false, reason: '该配置类型暂不支持图形化编辑' };
  const syntax = checkYamlSyntax(yaml);
  if (!syntax.ok) return { ok: false, reason: `YAML 语法错误：${syntax.message}` };
  if (typeof jsyaml === 'undefined' || !jsyaml || typeof jsyaml.loadAll !== 'function') {
    return { ok: false, reason: 'YAML 解析器未加载' };
  }
  let docs = [];
  try {
    docs = jsyaml.loadAll(String(yaml || '')).filter((doc) => doc && typeof doc === 'object');
  } catch (err) {
    return { ok: false, reason: `YAML 解析失败：${err.message}` };
  }
  if (!docs.length) return { ok: false, reason: 'YAML 没有可解析的文档' };
  const doc = docs[0];
  if (String(doc.kind || '') !== meta.label) {
    return { ok: false, reason: `YAML 类型是 ${doc.kind || '未知'}，与当前配置类型 ${meta.label} 不一致` };
  }
  const extraYaml = docs.length > 1
    ? docs.slice(1).map((item) => String(jsyaml.dump(item, { noRefs: true, lineWidth: -1 })).replace(/\s+$/, '')).join('\n---\n') + '\n'
    : '';
  const metadata = doc.metadata && typeof doc.metadata === 'object' ? doc.metadata : {};
  const base = {
    ok: true,
    name: String(metadata.name || ''),
    namespace: String(metadata.namespace || ''),
    extraYaml,
    extraDocs: Math.max(0, docs.length - 1)
  };
  if (WORKLOAD_FORM_KINDS.has(meta.form)) return { ...base, workload: workloadDefaultsFromDoc(meta.form, doc) };
  if (meta.form === 'configmap') {
    const data = doc.data && typeof doc.data === 'object' ? doc.data : {};
    return {
      ...base,
      configMap: Object.keys(data).map((key) => `${key}=${typeof data[key] === 'string' ? data[key] : JSON.stringify(data[key])}`).join('\n')
    };
  }
  if (meta.form === 'namespace') return { ...base, namespace: '' };
  return { ...base, network: networkDefaultsFromYaml(yaml) };
}

function configMapFieldsHTML(d = {}) {
  return `<div class="form-grid">
    <label class="field full"><span class="field-label">数据</span>
      <textarea class="input" id="wlConfigData" rows="8" style="min-height:150px;font-family:var(--mono)" placeholder="每行一个 KEY=VALUE，例如：&#10;APP_ENV=production&#10;LOG_LEVEL=info">${esc(d.data || '')}</textarea>
      <span class="help">支持注释行 #；值会按字符串写入 ConfigMap 的 data。</span>
    </label>
  </div>`;
}

function parseConfigMapData(text) {
  const data = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const index = line.indexOf('=');
    if (index <= 0) throw new Error('ConfigMap 数据每行格式必须是 KEY=VALUE');
    const key = line.slice(0, index).trim();
    if (!/^[A-Za-z0-9._-]+$/.test(key)) throw new Error(`ConfigMap 键 ${key} 格式不正确`);
    data[key] = line.slice(index + 1);
  }
  return data;
}

function readConfigMapForm() {
  const value = (id) => {
    const el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  };
  const name = networkDnsLabel(value('netName'), '资源名称');
  const namespaceText = value('netNamespace');
  const namespace = namespaceText ? networkDnsLabel(namespaceText, '命名空间') : '';
  const data = parseConfigMapData(value('wlConfigData'));
  if (!Object.keys(data).length) throw new Error('ConfigMap 至少需要一条数据');
  return { name, namespace, data };
}

function buildConfigMapObject(form) {
  const metadata = { name: form.name };
  if (form.namespace) metadata.namespace = form.namespace;
  return { apiVersion: 'v1', kind: 'ConfigMap', metadata, data: form.data };
}

function readNamespaceForm() {
  const name = networkDnsLabel(document.getElementById('netName') ? document.getElementById('netName').value.trim() : '', '资源名称');
  return { name };
}

function buildNamespaceObject(form) {
  return { apiVersion: 'v1', kind: 'Namespace', metadata: { name: form.name } };
}

let yamlPreviewOverlay = null;
let yamlPreviewEsc = null;

function closeYamlPreview() {
  if (yamlPreviewEsc) {
    document.removeEventListener('keydown', yamlPreviewEsc, true);
    yamlPreviewEsc = null;
  }
  if (yamlPreviewOverlay) {
    yamlPreviewOverlay.remove();
    yamlPreviewOverlay = null;
  }
}

function openYamlPreview(title, text) {
  closeYamlPreview();
  const wrap = document.createElement('div');
  wrap.id = 'yamlPreviewOverlay';
  wrap.style.cssText = 'position:fixed;inset:0;z-index:160;background:rgba(2,6,15,.72);display:flex;align-items:center;justify-content:center;padding:24px';
  wrap.innerHTML = `<div class="modal show" role="dialog" aria-modal="true" style="position:relative;left:auto;top:auto;transform:none;width:min(920px,96vw);max-height:90vh;margin:0">
    <div class="modal-head"><h3>${esc(title)}</h3><button class="icon-btn" type="button" data-preview-close="1" title="关闭">${icon('x')}</button></div>
    <div class="modal-body" style="padding:16px 20px"><pre class="logbox" style="max-height:62vh;margin:0">${esc(text)}</pre></div>
    <div class="modal-foot"><button class="btn" type="button" data-preview-close="1">关闭</button></div>
  </div>`;
  document.body.appendChild(wrap);
  wrap.querySelectorAll('[data-preview-close]').forEach((button) => button.addEventListener('click', closeYamlPreview));
  wrap.addEventListener('click', (event) => { if (event.target === wrap) closeYamlPreview(); });
  yamlPreviewEsc = (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeYamlPreview();
    }
  };
  document.addEventListener('keydown', yamlPreviewEsc, true);
  yamlPreviewOverlay = wrap;
}

function openAddResource(kindOverride = '', options = {}) {
  const saveOnly = options.origin === 'pod-deploy';
  const editingTemplate = saveOnly && options.template && typeof options.template.yaml === 'string' ? options.template : null;
  const editing = !!editingTemplate;
  const editYaml = editing ? editingTemplate.yaml : '';
  const host = activeHost();
  if (!saveOnly && (!host || !clusterCapable(host))) {
    toast('当前没有可用的 Kubernetes 集群', 'error');
    return;
  }
  const currentKind = kindOverride || (editing ? addKindKeyForYaml(editYaml) : '') || S.page.kind || 'pods';
  const meta = ADD_RESOURCE_META[currentKind];
  if (!meta) {
    toast(`当前类型「${kindMeta(currentKind).label}」暂不支持表单新增，请使用「应用 YAML」`, 'info');
    return;
  }
  const parsedDefaults = editing ? graphicalDefaultsForKind(currentKind, editYaml) : null;
  const graphAvailable = !editing || !!(parsedDefaults && parsedDefaults.ok);
  const graphUnavailableReason = editing && parsedDefaults && !parsedDefaults.ok ? parsedDefaults.reason : '';
  let graphExtraYaml = parsedDefaults && parsedDefaults.ok ? (parsedDefaults.extraYaml || '') : '';
  const graphExtraDocs = parsedDefaults && parsedDefaults.ok ? (parsedDefaults.extraDocs || 0) : 0;
  let defaultNamespace = S.page.namespace || 'default';
  let defaultName = ADD_NAME_DEFAULTS[currentKind] || 'demo-app';
  if (editing && parsedDefaults && parsedDefaults.ok) {
    defaultName = parsedDefaults.name || defaultName;
    defaultNamespace = parsedDefaults.namespace || defaultNamespace;
  }
  const initialFileName = editing
    ? editingTemplate.id
    : `${podConfigDefaultBase(meta.label, defaultName, defaultNamespace)}.yaml`;
  let netDefaults = {
    ...networkDefaultsFromYaml(editing ? editYaml : ''),
    namespace: defaultNamespace,
    name: defaultName,
    selectorValue: defaultName,
    policyValue: defaultName,
    sourceNamespace: defaultNamespace,
    backendService: defaultName
  };
  let workloadDefaults = {
    replicas: 2,
    containerName: 'app',
    image: '',
    containerPort: 80,
    imagePullPolicy: 'IfNotPresent',
    cpuRequest: '50m',
    memRequest: '64Mi',
    cpuLimit: '500m',
    memLimit: '256Mi',
    schedule: '0 3 * * *',
    serviceName: `${defaultName}-headless`,
    // IngressClass 默认值按当前集群实际存在的 class 自动选择，留空表示走集群默认
    ingressClass: defaultIngressClass(host),
    ingressClassOptions: (ingressClassCache(host) || []).map((item) => item.name)
  };
  let configMapDefaults = '';
  if (editing && parsedDefaults && parsedDefaults.ok) {
    if (parsedDefaults.network) netDefaults = { ...netDefaults, ...parsedDefaults.network };
    if (parsedDefaults.workload) workloadDefaults = { ...workloadDefaults, ...parsedDefaults.workload };
    if (typeof parsedDefaults.configMap === 'string') configMapDefaults = parsedDefaults.configMap;
  }
  const showNamespace = currentKind !== 'namespaces';
  const initialYamlMode = editing && !graphAvailable;
  openModal({
    title: editing ? `编辑 ${meta.label}` : `新增 ${meta.label}`,
    size: 'wide',
    body: `
      <div class="alert ${graphAvailable ? 'info' : 'warn'}" style="margin-bottom:14px">${icon(editing ? 'edit' : 'plus')}<div>${saveOnly
        ? (editing
          ? `编辑 <b>${esc(meta.label)}</b> 配置「${esc(editingTemplate.name)}」；图形化与查看 YAML 可来回切换。`
          : `新增 <b>${esc(meta.label)}</b> 配置，保存后会出现在 Pod 部署页的本地配置列表；图形化与查看 YAML 可来回切换。`)
        : `当前列表类型是 <b>${esc(meta.label)}</b>，新增后会回到当前列表并刷新。`}${!graphAvailable && graphUnavailableReason ? `<br><span class="tiny">${esc(graphUnavailableReason)}</span>` : ''}${graphExtraDocs ? `<br><span class="tiny">图形化编辑只修改第一个文档，其余 ${graphExtraDocs} 个文档会原样保留；切换查看 YAML 可编辑全部。</span>` : ''}</div></div>
      ${saveOnly ? `<div class="row" id="wlEditMode" style="gap:8px;align-items:center;margin-bottom:12px">
        <span class="tiny dim" style="letter-spacing:.6px">编辑方式</span>
        <button type="button" class="chip ${initialYamlMode ? '' : 'active'}" id="wlModeForm" ${graphAvailable ? '' : 'title="' + esc(graphUnavailableReason || '当前配置不支持图形化编辑') + '"'}>图形化</button>
        <button type="button" class="chip ${initialYamlMode ? 'active' : ''}" id="wlModeYaml">查看 YAML</button>
      </div>` : ''}
      ${saveOnly ? `<label class="field" style="margin-bottom:12px"><span class="field-label">配置文件名 <span class="req">*</span></span>
        <input class="input" id="wlFileName" value="${esc(initialFileName)}" autocomplete="off" spellcheck="false" />
        <span class="help">保存到 data/deployment-templates；已存在同名文件时会提示是否覆盖${editing ? '，修改文件名会重命名原文件' : ''}。</span>
      </label>` : ''}
      <div id="wlFormWrap" class="${initialYamlMode ? 'hidden' : ''}">
        <div class="form-grid">
          <label class="field"><span class="field-label">类型</span>
            <select class="select" id="wlKind" disabled title="由当前配置类型决定，不可修改">
              <option>${esc(meta.label)}</option>
            </select>
          </label>
          <label class="field"><span class="field-label">资源名称 <span class="req">*</span></span>
            <input class="input" id="netName" value="${esc(defaultName)}" maxlength="63" autocomplete="off" />
            <span class="help" id="netNameHint">只能用小写字母、数字和 -，用于 Deployment / Service / Ingress 的名字。</span>
          </label>
          ${showNamespace ? `<label class="field"><span class="field-label">命名空间</span>
            <select class="select" id="netNamespace" title="从集群现有命名空间中选择">
              ${namespaceSelectOptionsHTML(defaultNamespace, host)}
            </select>
          </label>` : ''}
        </div>
        <div id="wlFields" style="margin-top:14px"></div>
      </div>
      ${saveOnly ? `<div id="wlYamlWrap" class="${initialYamlMode ? '' : 'hidden'}">
        <label class="field"><span class="field-label">YAML</span>
          <textarea class="editor" id="wlYamlEditor" spellcheck="false" style="min-height:360px">${esc(editYaml)}</textarea>
          <div class="tiny dim" id="wlYamlStatus" style="margin-top:6px"></div>
        </label>
      </div>` : ''}
      ${saveOnly ? '' : `<div class="row" style="margin-top:12px">
        <label class="check"><input type="checkbox" id="wlDryRun" /> 服务端试运行（不写入集群）</label>
        <label class="check"><input type="checkbox" id="wlSaveTemplate" checked /> 应用成功后保存 YAML 到 data/deployment-templates</label>
      </div>`}`,
    foot: saveOnly
      ? `<button class="btn" data-close="1">取消</button><button class="btn primary" id="wlSaveTemplateBtn" title="保存到 data/deployment-templates；同名文件会提示是否覆盖">${editing ? '保存修改' : '保存'}</button>`
      : `<button class="btn" data-close="1">取消</button><button class="btn" id="wlSaveTemplateBtn" title="保存到 data/deployment-templates；同名模板会覆盖">保存</button><button class="btn" id="wlPreviewBtn">预览 YAML</button><button class="btn primary" id="wlApplyBtn">${icon('check')} 应用</button>`,
    onClose: saveOnly ? () => { if (S.view === 'deploy' && S.deployTab === 'custom') renderView(); } : null,
    onMount(m) {
      const fields = $('#wlFields', m.el);
      const yamlEditor = saveOnly ? $('#wlYamlEditor', m.el) : null;
      const yamlWrap = saveOnly ? $('#wlYamlWrap', m.el) : null;
      const formWrap = saveOnly ? $('#wlFormWrap', m.el) : null;
      const fileNameInput = saveOnly ? $('#wlFileName', m.el) : null;
      let fileNameTouched = editing;
      const syncDefaultFileName = () => {
        if (!fileNameInput || fileNameTouched) return;
        const nameInput = $('#netName', m.el);
        const nsInput = $('#netNamespace', m.el);
        const nameValue = nameInput ? String(nameInput.value || '').trim() : '';
        if (!nameValue) return;
        const nsValue = nsInput ? String(nsInput.value || '').trim() : '';
        fileNameInput.value = `${podConfigDefaultBase(meta.label, nameValue, nsValue)}.yaml`;
      };
      let yamlMode = initialYamlMode;
      let graphEnabled = graphAvailable;
      let graphReason = graphUnavailableReason;
      let formDirty = false;
      let yamlGenerated = false;
      const appendExtra = (yaml) => {
        const base = String(yaml || '').replace(/\s+$/, '');
        return graphExtraYaml ? `${base}\n---\n${graphExtraYaml}` : `${base}\n`;
      };
      const refreshMode = () => {
        if (!saveOnly) return;
        if (formWrap) formWrap.classList.toggle('hidden', yamlMode);
        if (yamlWrap) yamlWrap.classList.toggle('hidden', !yamlMode);
        const formButton = $('#wlModeForm', m.el);
        const yamlButton = $('#wlModeYaml', m.el);
        if (formButton) {
          formButton.classList.toggle('active', !yamlMode);
          formButton.title = graphEnabled ? '' : (graphReason || '当前配置不支持图形化编辑');
        }
        if (yamlButton) yamlButton.classList.toggle('active', yamlMode);
      };
      const paint = () => {
        if (WORKLOAD_FORM_KINDS.has(meta.form)) {
          fields.innerHTML = workloadFieldsHTML(meta.form, workloadDefaults);
          bindWorkloadFieldHints(fields, host);
          if (meta.form === 'deployment') {
            const serviceCheck = $('#wlExposeService', fields);
            const ingressCheck = $('#wlExposeIngress', fields);
            const serviceFields = $('#wlServiceFields', fields);
            const ingressFields = $('#wlIngressFields', fields);
            const sync = () => {
              if (ingressCheck.checked) serviceCheck.checked = true;
              serviceFields.classList.toggle('hidden', !(serviceCheck.checked || ingressCheck.checked));
              ingressFields.classList.toggle('hidden', !ingressCheck.checked);
            };
            serviceCheck.addEventListener('change', sync);
            ingressCheck.addEventListener('change', sync);
            sync();
            // 首次打开时异步读取集群的 IngressClass，回填默认值（用户已改过则不覆盖）
            if (host && !ingressClassCache(host)) {
              loadIngressClasses(host).then(() => {
                if (!fields.isConnected) return;
                const input = $('#wlIngressClass', fields);
                const list = $('#wlIngressClassList', fields);
                const hint = $('#wlIngressClassHint', fields);
                const classes = ingressClassCache(host) || [];
                if (list) list.innerHTML = classes.map((item) => `<option value="${esc(item.name)}"></option>`).join('');
                if (hint) hint.textContent = ingressClassHintText(host);
                workloadDefaults.ingressClassOptions = classes.map((item) => item.name);
                const detected = defaultIngressClass(host);
                if (input && !input.dataset.dirty && !input.value.trim() && detected) {
                  input.value = detected;
                  workloadDefaults.ingressClass = detected;
                }
              }).catch(() => {});
            } else if (host) {
              const hint = $('#wlIngressClassHint', fields);
              if (hint) hint.textContent = ingressClassHintText(host);
            }
          }
          return;
        }
        if (meta.form === 'configmap') {
          fields.innerHTML = configMapFieldsHTML({ data: configMapDefaults });
          return;
        }
        if (meta.form === 'namespace') {
          fields.innerHTML = '<div class="tiny dim" style="line-height:1.8">Namespace 是集群级资源，不需要命名空间字段。新增后会切换回 Namespace 列表。</div>';
          return;
        }
        const currentName = String($('#netName', m.el).value || '').trim() || defaultName;
        const currentNs = String($('#netNamespace', m.el) ? $('#netNamespace', m.el).value : '').trim() || defaultNamespace;
        fields.innerHTML = networkFieldsHTML(meta.form, {
          ...netDefaults,
          namespace: currentNs,
          sourceNamespace: netDefaults.sourceNamespace,
          selectorValue: netDefaults.selectorValue || currentName,
          policyValue: netDefaults.policyValue || currentName,
          backendService: netDefaults.backendService || currentName
        });
        attachIngressHostHint($('#netHost', fields), $('#netHostHint', fields));
      };
      const nameInput = $('#netName', m.el);
      const nsInput = $('#netNamespace', m.el);
      // 先注册实时校验（顺手把大写转小写），保证后面的字段联动拿到的是规范化后的名字
      attachDnsLabelHint(nameInput, $('#netNameHint', m.el), '资源名称');
      let lastName = nameInput.value;
      let lastNs = nsInput ? nsInput.value : '';
      nameInput.addEventListener('input', () => {
        formDirty = true;
        const next = nameInput.value;
        for (const id of ['netSelectorValue', 'netPolicyValue', 'netBackendService']) {
          const el = document.getElementById(id);
          if (el && el.value === lastName) el.value = next;
        }
        const serviceName = document.getElementById('wlServiceName');
        if (serviceName && serviceName.value === `${lastName}-headless`) serviceName.value = `${next}-headless`;
        lastName = next;
      });
      if (nsInput) {
        // 命名空间改成下拉选择，change 与 input 都监听，兼容不同浏览器
        const onNsChange = () => {
          formDirty = true;
          const next = nsInput.value;
          const source = document.getElementById('netSourceNamespace');
          if (source && source.value === lastNs) source.value = next;
          lastNs = next;
        };
        nsInput.addEventListener('input', onNsChange);
        nsInput.addEventListener('change', onNsChange);
        // 缓存里没有命名空间时再拉一次，拉到后保持当前选中项不变
        if (host && !S.namespaces[host.id]) {
          loadNamespaces(host.id).then(() => {
            if (!nsInput.isConnected) return;
            const keep = String(nsInput.value || '').trim() || defaultNamespace;
            nsInput.innerHTML = namespaceSelectOptionsHTML(keep, host);
            nsInput.value = keep;
            lastNs = keep;
          }).catch(() => {});
        }
      }
      const buildFormData = () => {
        if (WORKLOAD_FORM_KINDS.has(meta.form)) {
          const form = readWorkloadForm(meta.form);
          return {
            yaml: appendExtra(dumpYamlObjects(buildWorkloadObjects(form))),
            label: meta.label,
            targetKind: currentKind,
            name: form.name,
            namespace: form.namespace
          };
        }
        if (meta.form === 'configmap') {
          const form = readConfigMapForm();
          return {
            yaml: appendExtra(dumpYamlObjects([buildConfigMapObject(form)])),
            label: meta.label,
            targetKind: currentKind,
            name: form.name,
            namespace: form.namespace
          };
        }
        if (meta.form === 'namespace') {
          const form = readNamespaceForm();
          return {
            yaml: appendExtra(dumpYamlObjects([buildNamespaceObject(form)])),
            label: meta.label,
            targetKind: currentKind,
            name: form.name,
            namespace: ''
          };
        }
        const form = readNetworkForm(meta.form);
        return {
          yaml: appendExtra(dumpYamlObjects([buildNetworkObject(form)])),
          label: meta.label,
          targetKind: currentKind,
          name: form.name,
          namespace: form.namespace
        };
      };
      const buildManualYamlData = () => {
        const yaml = String(yamlEditor ? yamlEditor.value : '');
        const syntax = checkYamlSyntax(yaml);
        paintYamlSyntaxStatus(syntax, '#wlYamlStatus');
        if (!syntax.ok) throw new Error(`YAML 语法错误：${syntax.message}`);
        let first = {};
        try {
          if (typeof jsyaml !== 'undefined' && jsyaml && typeof jsyaml.loadAll === 'function') {
            first = jsyaml.loadAll(yaml).find((doc) => doc && typeof doc === 'object') || {};
          }
        } catch (_) { /* checkYamlSyntax 已给出错误 */ }
        const metadata = first.metadata && typeof first.metadata === 'object' ? first.metadata : {};
        const label = String(first.kind || meta.label || '').trim() || meta.label;
        const name = String(metadata.name || defaultName).trim() || defaultName;
        const namespace = String(metadata.namespace || '').trim();
        return { yaml, label, targetKind: currentKind, name, namespace };
      };
      const buildData = () => {
        if (saveOnly && yamlMode) return buildManualYamlData();
        if (editing && !formDirty && !yamlGenerated) return buildManualYamlData();
        return buildFormData();
      };
      const applyYamlToForm = () => {
        if (!yamlEditor) return false;
        const yaml = String(yamlEditor.value || '');
        const syntax = checkYamlSyntax(yaml);
        paintYamlSyntaxStatus(syntax, '#wlYamlStatus');
        if (!syntax.ok) {
          toast(`YAML 语法错误：${syntax.message}`, 'error');
          return false;
        }
        const parsed = graphicalDefaultsForKind(currentKind, yaml);
        if (!parsed.ok) {
          graphEnabled = false;
          graphReason = parsed.reason;
          refreshMode();
          toast(`无法切换图形化：${parsed.reason}`, 'error');
          return false;
        }
        graphEnabled = true;
        graphReason = '';
        defaultName = parsed.name || defaultName;
        defaultNamespace = parsed.namespace || defaultNamespace;
        if (parsed.workload) workloadDefaults = { ...workloadDefaults, ...parsed.workload };
        if (parsed.network) netDefaults = {
          ...netDefaults,
          ...parsed.network,
          name: defaultName,
          namespace: defaultNamespace
        };
        if (typeof parsed.configMap === 'string') configMapDefaults = parsed.configMap;
        graphExtraYaml = parsed.extraYaml || '';
        if (nameInput) nameInput.value = defaultName;
        if (nsInput) nsInput.value = defaultNamespace;
        paint();
        syncDefaultFileName();
        formDirty = false;
        yamlGenerated = false;
        refreshMode();
        return true;
      };
      const setEditMode = (mode) => {
        if (!saveOnly || !yamlWrap || !formWrap) return;
        const nextYaml = mode === 'yaml';
        if (nextYaml && !yamlMode) {
          const shouldGenerate = !editing || formDirty || yamlGenerated || !String(yamlEditor.value || '').trim();
          if (shouldGenerate) {
            try {
              const generated = buildFormData();
              if (yamlEditor) {
                yamlEditor.value = generated.yaml;
                paintYamlSyntaxStatus(checkYamlSyntax(generated.yaml), '#wlYamlStatus');
                yamlGenerated = true;
                formDirty = false;
              }
            } catch (err) {
              toast(`生成 YAML 失败：${errorText(err)}`, 'error');
              return;
            }
          }
        }
        if (!nextYaml && yamlMode) {
          if (!applyYamlToForm()) return;
        }
        yamlMode = nextYaml;
        refreshMode();
      };
      if (saveOnly) {
        $('#wlModeForm', m.el).addEventListener('click', () => setEditMode('form'));
        $('#wlModeYaml', m.el).addEventListener('click', () => setEditMode('yaml'));
        if (fileNameInput) {
          fileNameInput.addEventListener('input', () => { fileNameTouched = true; });
        }
        if (yamlEditor) {
          let yamlStatusTimer = null;
          yamlEditor.addEventListener('input', () => {
            if (yamlStatusTimer) clearTimeout(yamlStatusTimer);
            yamlStatusTimer = setTimeout(() => {
              if (!yamlEditor.isConnected) return;
              paintYamlSyntaxStatus(checkYamlSyntax(yamlEditor.value), '#wlYamlStatus');
            }, 500);
          });
        }
        if (formWrap) {
          formWrap.addEventListener('input', () => {
            formDirty = true;
            syncDefaultFileName();
          });
          formWrap.addEventListener('change', () => { formDirty = true; });
        }
      }
      paint();
      refreshMode();
      const previewButton = $('#wlPreviewBtn', m.el);
      if (previewButton) previewButton.addEventListener('click', () => {
        try {
          const data = buildData();
          openYamlPreview(`${meta.label} YAML 预览`, data.yaml);
        } catch (err) {
          toast(`生成失败：${errorText(err)}`, 'error');
        }
      });
      $('#wlSaveTemplateBtn', m.el).addEventListener('click', async () => {
        const button = $('#wlSaveTemplateBtn', m.el);
        let data;
        let fileName = '';
        let conflict = null;
        try {
          data = buildData();
          if (saveOnly) {
            fileName = normalizeTemplateFileName(fileNameInput ? fileNameInput.value : '');
            if (!fileName) throw new Error('配置文件名不能为空');
            conflict = templateFileNameConflict(fileName, editing ? editingTemplate.id : '');
          }
        } catch (err) {
          toast(`保存失败：${errorText(err)}`, 'error');
          return;
        }
        const renamingToExisting = !!(editing && conflict && editingTemplate.id.toLowerCase() !== fileName.toLowerCase());
        let overwrite = false;
        if (conflict) {
          button.disabled = true;
          overwrite = await promptTemplateOverwrite(
            m,
            fileName,
            renamingToExisting
              ? '覆盖后当前配置会合并到该文件，原文件将被删除。'
              : '覆盖会替换该文件中的 YAML 内容。'
          );
          if (!overwrite) {
            button.disabled = false;
            return;
          }
        }
        button.disabled = true;
        try {
          if (editing) {
            const result = await api('/templates', {
              method: 'POST',
              body: { name: fileName, yaml: data.yaml, originalName: editingTemplate.id, overwrite }
            });
            S.deploymentTemplates = (S.deploymentTemplates || []).filter((item) => item.id !== editingTemplate.id);
            const index = S.deploymentTemplates.findIndex((item) => item.id === result.template.id);
            if (index >= 0) S.deploymentTemplates[index] = result.template;
            else S.deploymentTemplates.push(result.template);
            S.deploymentTemplates.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
            S.podConfigTypeFilter = 'all';
            m.close();
            renderView();
            toast(`已保存配置「${result.template.name}」`, 'success');
            return;
          }
          if (saveOnly) {
            const result = await api('/templates', {
              method: 'POST',
              body: { name: fileName, yaml: data.yaml, createOnly: !overwrite, overwrite }
            });
            S.deploymentTemplates = S.deploymentTemplates || [];
            const index = S.deploymentTemplates.findIndex((item) => item.id === result.template.id);
            if (index >= 0) S.deploymentTemplates[index] = result.template;
            else S.deploymentTemplates.push(result.template);
            S.deploymentTemplates.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
            S.podConfigTypeFilter = 'all';
            m.close();
            toast(`已保存配置「${result.template.name}」`, 'success');
            return;
          }
          const template = await saveAddTemplate(data);
          openYamlPreview('已保存', `${data.yaml}\n# 已保存到 data/deployment-templates/${template.name}.yaml`);
          toast(`已保存模板「${template.name}」`, 'success');
        } catch (err) {
          toast(`保存失败：${errorText(err)}`, 'error');
        } finally {
          button.disabled = false;
        }
      });
      const applyButton = $('#wlApplyBtn', m.el);
      if (applyButton) applyButton.addEventListener('click', async () => {
        const button = $('#wlApplyBtn', m.el);
        let data;
        try {
          data = buildData();
        } catch (err) {
          toast(`生成失败：${errorText(err)}`, 'error');
          return;
        }
        const dryRun = $('#wlDryRun', m.el).checked;
        button.disabled = true;
        button.innerHTML = '<span class="spinner"></span> 应用中';
        try {
          const result = await api(`/hosts/${encodeURIComponent(host.id)}/apply`, {
            method: 'POST',
            body: { yaml: data.yaml, namespace: data.namespace, dryRun }
          });
          if (dryRun) {
            openYamlPreview('服务端试运行结果', `${data.yaml}\n# 服务端试运行结果\n${result.output || '通过'}`);
            toast('服务端试运行通过，未写入集群', 'success');
            return;
          }
          let templateSaved = false;
          if ($('#wlSaveTemplate', m.el).checked) {
            try {
              await saveAddTemplate(data);
              templateSaved = true;
            } catch (saveErr) {
              toast(`已应用，但保存模板失败：${errorText(saveErr)}`, 'error');
            }
          }
          m.close();
          toast(templateSaved ? `${data.label} 已创建，YAML 已保存到 data/deployment-templates` : `${data.label} 已创建`, 'success');
          S.page.kind = data.targetKind;
          S.page.namespace = data.namespace || '';
          S.page.search = '';
          S.page.page = 1;
          S.workloadData = null;
          S.detail = null;
          renderView();
          // 可能刚新建了命名空间，强制刷新下拉缓存后再渲染一次，避免筛选下拉漏掉新增项
          loadNamespaces(host.id, true)
            .then(() => { if (S.view === 'workloads') renderView(); })
            .catch(() => {});
        } catch (err) {
          openYamlPreview('应用失败', `${data.yaml}\n# 应用失败\n${errorText(err)}`);
          toast(`应用失败：${errorText(err)}`, 'error');
        } finally {
          button.disabled = false;
          button.innerHTML = `${icon('check')} 应用`;
        }
      });
    }
  });
}

function hostHasK3s(host) {
  const info = S.detected[host.id];
  const k8s = info && info.k8s;
  if (!info || !info.reachable || !k8s || !k8s.installed) return false;
  return k8s.flavor === 'k3s' || /k3s/i.test(String(k8s.version || ''));
}

function podDeployHosts() {
  return S.hosts.filter(hostHasK3s);
}

function podConfigInfo(template) {
  let docs = [];
  try {
    if (typeof jsyaml !== 'undefined' && jsyaml && typeof jsyaml.loadAll === 'function') {
      docs = jsyaml.loadAll(template.yaml).filter((doc) => doc && typeof doc === 'object');
    }
  } catch (_) { /* 保底用文本解析类型 */ }
  if (!docs.length) {
    docs = [...String(template.yaml || '').matchAll(/^kind:\s*["']?([A-Za-z][A-Za-z0-9.-]*)/gm)].map((match) => ({ kind: match[1] }));
  }
  const kinds = [...new Set(docs.map((doc) => doc.kind).filter(Boolean))];
  const namespaces = [...new Set(docs.map((doc) => doc.metadata && doc.metadata.namespace).filter(Boolean))];
  return { kinds, namespaces, docs: docs.length };
}

function podConfigKinds(templates) {
  const kinds = new Set();
  for (const template of templates || []) {
    for (const kind of podConfigInfo(template).kinds) kinds.add(kind);
  }
  return [...kinds].sort((a, b) => a.localeCompare(b, 'en'));
}

function podConfigCardHTML(template) {
  const info = podConfigInfo(template);
  const kinds = info.kinds.length
    ? info.kinds.map((kind) => badge(kind, 'neutral')).join('')
    : badge('无法解析', 'warn');
  const namespaceText = info.namespaces.length ? info.namespaces.join('、') : '随 YAML';
  const canApply = podDeployHosts().length > 0;
  return `<div class="pod-config-item">
    <div class="pod-config-main">
      <div class="pod-config-name">${esc(template.name)}</div>
      <div class="pod-config-meta">
        ${kinds}
        <span class="tiny dim">命名空间：${esc(namespaceText)} · ${info.docs || 0} 个文档</span>
      </div>
    </div>
    <div class="pod-config-actions">
      <button class="btn sm primary" data-action="pod-config-apply" data-template-id="${esc(template.id)}" ${canApply ? '' : 'disabled'} title="${canApply ? '选择服务器并应用' : '请先读取到已安装 k3s 的服务器'}">${icon('rocket')} 应用</button>
      <button class="btn sm" data-action="pod-config-view" data-template-id="${esc(template.id)}">${icon('eye')} 查看</button>
      <button class="btn sm" data-action="pod-config-edit" data-template-id="${esc(template.id)}">${icon('edit')} 编辑</button>
      <button class="btn sm danger" data-action="pod-config-delete" data-template-id="${esc(template.id)}">${icon('trash')} 删除</button>
    </div>
  </div>`;
}

function openPodConfigTypePicker() {
  const entries = Object.entries(ADD_RESOURCE_META);
  openModal({
    title: '新增配置',
    size: 'narrow',
    body: `<div class="alert info" style="margin-bottom:14px">${icon('plus')}<div>配置会保存到 data/deployment-templates，稍后可在本页直接应用到 k3s 服务器。</div></div>
      <label class="field"><span class="field-label">配置类型</span>
        <select class="select" id="podAddType">
          ${entries.map(([kind, meta]) => `<option value="${esc(kind)}" ${kind === 'pods' ? 'selected' : ''}>${esc(meta.label)}</option>`).join('')}
        </select>
        <span class="help">选择类型后会打开对应表单，也可以切换为查看 YAML；保存后出现在本地配置列表。</span>
      </label>`,
    foot: `<button class="btn" data-close="1">取消</button><button class="btn primary" id="podAddTypeNext">${icon('plus')} 下一步</button>`,
    onMount(modal) {
      $('#podAddTypeNext', modal.el).addEventListener('click', () => {
        const kind = $('#podAddType', modal.el).value;
        closeModal();
        setTimeout(() => openAddResource(kind, { origin: 'pod-deploy' }), 180);
      });
    }
  });
}

function viewPodConfig(id) {
  const template = (S.deploymentTemplates || []).find((item) => item.id === id);
  if (!template) {
    toast('配置不存在，请刷新列表', 'error');
    return;
  }
  openYamlPreview(template.name, template.yaml);
}

function editPodConfig(id) {
  const template = (S.deploymentTemplates || []).find((item) => item.id === id);
  if (!template) {
    toast('配置不存在，请刷新列表', 'error');
    return;
  }
  const kindKey = addKindKeyForYaml(template.yaml);
  if (kindKey && ADD_RESOURCE_META[kindKey]) {
    openAddResource(kindKey, { origin: 'pod-deploy', template });
    return;
  }
  openRawPodConfigEditor(template);
}

function openRawPodConfigEditor(template) {
  openModal({
    title: `编辑配置 · ${template.name}`,
    size: 'wide',
    body: `<div class="alert warn" style="margin-bottom:12px">${icon('alert')}<div>该 YAML 不是内置资源类型，暂不支持图形化编辑，请直接修改 YAML。</div></div>
      <label class="field" style="margin-bottom:10px"><span class="field-label">配置文件名 <span class="req">*</span></span>
        <input class="input" id="podConfigFileName" value="${esc(template.id)}" autocomplete="off" spellcheck="false" />
        <span class="help">保存到 data/deployment-templates；已存在同名文件时会提示是否覆盖，修改文件名会重命名原文件。</span>
      </label>
      <label class="field"><span class="field-label">YAML</span>
      <textarea class="editor" id="podConfigEditor" spellcheck="false" style="min-height:420px">${esc(template.yaml)}</textarea>
      <div class="tiny dim" id="podConfigEditorError" style="margin-top:6px"></div>
    </label>`,
    foot: `<button class="btn" data-close="1">取消</button><button class="btn primary" id="podConfigSave">${icon('check')} 保存</button>`,
    onMount(modal) {
      const editor = $('#podConfigEditor', modal.el);
      const fileName = $('#podConfigFileName', modal.el);
      const error = $('#podConfigEditorError', modal.el);
      const button = $('#podConfigSave', modal.el);
      button.addEventListener('click', async () => {
        const yaml = editor.value;
        const fileNameValue = normalizeTemplateFileName(fileName.value);
        if (!fileNameValue) {
          error.textContent = '配置文件名不能为空';
          return;
        }
        const conflict = templateFileNameConflict(fileNameValue, template.id);
        const syntax = checkYamlSyntax(yaml);
        if (!syntax.ok) {
          error.textContent = `YAML 语法错误：${syntax.message}`;
          return;
        }
        const renamingToExisting = !!(conflict && template.id.toLowerCase() !== fileNameValue.toLowerCase());
        let overwrite = false;
        if (conflict) {
          button.disabled = true;
          overwrite = await promptTemplateOverwrite(
            modal,
            fileNameValue,
            renamingToExisting
              ? '覆盖后当前配置会合并到该文件，原文件将被删除。'
              : '覆盖会替换该文件中的 YAML 内容。'
          );
          if (!overwrite) {
            button.disabled = false;
            return;
          }
        }
        button.disabled = true;
        try {
          const data = await api('/templates', {
            method: 'POST',
            body: { name: fileNameValue, yaml, originalName: template.id, overwrite }
          });
          S.deploymentTemplates = S.deploymentTemplates.filter((item) => item.id !== template.id);
          const index = S.deploymentTemplates.findIndex((item) => item.id === data.template.id);
          if (index >= 0) S.deploymentTemplates[index] = data.template;
          else S.deploymentTemplates.push(data.template);
          S.deploymentTemplates.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
          modal.close();
          renderView();
          toast(`已保存配置「${data.template.name}」`, 'success');
        } catch (err) {
          error.textContent = `保存失败：${errorText(err)}`;
          button.disabled = false;
        }
      });
      requestAnimationFrame(() => editor.focus());
    }
  });
}

async function deletePodConfig(id) {
  const template = (S.deploymentTemplates || []).find((item) => item.id === id);
  if (!template) {
    toast('配置不存在，请刷新列表', 'error');
    return;
  }
  const confirmed = await confirmDialog({
    title: '删除配置',
    message: `确定删除「<b>${esc(template.name)}</b>」吗？<br><span class="tiny dim">对应文件会从 data/deployment-templates 中删除，且无法恢复。</span>`,
    confirmText: '删除',
    danger: true
  });
  if (!confirmed) return;
  try {
    await api(`/templates/${encodeURIComponent(id)}`, { method: 'DELETE' });
    S.deploymentTemplates = S.deploymentTemplates.filter((item) => item.id !== id);
    renderView();
    toast(`已删除配置「${template.name}」`, 'success');
  } catch (err) {
    toast(`删除失败：${errorText(err)}`, 'error');
  }
}

async function refreshPodConfigs() {
  try {
    await loadDeploymentTemplates();
    renderView();
    toast('本地配置已刷新', 'success', 1500);
  } catch (err) {
    toast(`刷新失败：${errorText(err)}`, 'error');
  }
}

function ensurePodConfigImportInput() {
  let input = $('#podConfigImportInput');
  if (input) return input;
  input = document.createElement('input');
  input.type = 'file';
  input.id = 'podConfigImportInput';
  input.className = 'hidden';
  input.accept = '.yaml,.yml,text/yaml,application/x-yaml,text/plain';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('文件超过 5 MB');
      const text = await file.text();
      if (!text.trim()) throw new Error('文件内容为空');
      openPodConfigImportModal(file.name, text);
    } catch (err) {
      toast(`导入配置文件失败：${errorText(err)}`, 'error');
    }
  });
  document.body.appendChild(input);
  return input;
}

function openPodConfigImport() {
  const input = ensurePodConfigImportInput();
  input.value = '';
  input.click();
}

function openPodConfigImportModal(fileName, yamlText) {
  const initialName = normalizeTemplateFileName(fileName);
  openModal({
    title: '导入配置文件',
    size: 'wide',
    body: `<div class="alert info" style="margin-bottom:12px">${icon('download')}<div>从本地导入 YAML 并保存到 data/deployment-templates；不会直接应用到集群。</div></div>
      <label class="field" style="margin-bottom:10px"><span class="field-label">配置文件名 <span class="req">*</span></span>
        <input class="input" id="podImportFileName" value="${esc(initialName)}" autocomplete="off" spellcheck="false" />
        <span class="help">默认使用所选文件名，可修改；已存在同名文件时会提示是否覆盖。</span>
      </label>
      <label class="field"><span class="field-label">YAML</span>
        <textarea class="editor" id="podImportYaml" spellcheck="false" style="min-height:420px">${esc(yamlText)}</textarea>
        <div class="tiny dim" id="podImportStatus" style="margin-top:6px"></div>
      </label>
      <div class="alert err hidden" id="podImportError" style="margin-top:10px"></div>`,
    foot: `<button class="btn" data-close="1">取消</button><button class="btn primary" id="podImportSave">${icon('download')} 导入并保存</button>`,
    onMount(modal) {
      const fileNameInput = $('#podImportFileName', modal.el);
      const yamlEditor = $('#podImportYaml', modal.el);
      const error = $('#podImportError', modal.el);
      const button = $('#podImportSave', modal.el);
      const showError = (message) => {
        error.textContent = message;
        error.classList.remove('hidden');
      };
      const clearError = () => {
        error.textContent = '';
        error.classList.add('hidden');
      };
      const refreshSyntax = () => paintYamlSyntaxStatus(checkYamlSyntax(yamlEditor.value), '#podImportStatus');
      refreshSyntax();
      fileNameInput.addEventListener('input', clearError);
      let syntaxTimer = null;
      yamlEditor.addEventListener('input', () => {
        clearError();
        if (syntaxTimer) clearTimeout(syntaxTimer);
        syntaxTimer = setTimeout(() => {
          if (yamlEditor.isConnected) refreshSyntax();
        }, 500);
      });
      button.addEventListener('click', async () => {
        const fileNameValue = normalizeTemplateFileName(fileNameInput.value);
        if (!fileNameValue) {
          showError('配置文件名不能为空');
          return;
        }
        const syntax = checkYamlSyntax(yamlEditor.value);
        if (!syntax.ok) {
          showError(`YAML 语法错误：${syntax.message}`);
          return;
        }
        const conflict = templateFileNameConflict(fileNameValue);
        let overwrite = false;
        if (conflict) {
          button.disabled = true;
          overwrite = await promptTemplateOverwrite(modal, fileNameValue, '覆盖会替换该文件中的 YAML 内容。');
          if (!overwrite) {
            button.disabled = false;
            return;
          }
        }
        clearError();
        const originalHTML = button.innerHTML;
        button.disabled = true;
        button.innerHTML = '<span class="spinner"></span> 导入中';
        try {
          const result = await api('/templates', {
            method: 'POST',
            body: { name: fileNameValue, yaml: yamlEditor.value, createOnly: !overwrite, overwrite }
          });
          S.deploymentTemplates = S.deploymentTemplates || [];
          const index = S.deploymentTemplates.findIndex((item) => item.id === result.template.id);
          if (index >= 0) S.deploymentTemplates[index] = result.template;
          else S.deploymentTemplates.push(result.template);
          S.deploymentTemplates.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
          S.podConfigTypeFilter = 'all';
          modal.close();
          renderView();
          toast(`已导入配置「${result.template.name}」`, 'success');
        } catch (err) {
          button.disabled = false;
          button.innerHTML = originalHTML;
          showError(`导入失败：${errorText(err)}`);
        }
      });
      requestAnimationFrame(() => fileNameInput.focus());
    }
  });
}

function applyPodConfig(id) {
  const template = (S.deploymentTemplates || []).find((item) => item.id === id);
  if (!template) {
    toast('配置不存在，请刷新列表', 'error');
    return;
  }
  const syntax = checkYamlSyntax(template.yaml);
  if (!syntax.ok) {
    toast(`YAML 语法错误：${syntax.message}`, 'error');
    return;
  }
  const pool = podDeployHosts();
  if (!pool.length) {
    toast('没有可选的 k3s 服务器，请先安装 k3s', 'error');
    return;
  }
  openHostPicker({
    title: `应用配置 · ${template.name}`,
    allowMixed: true,
    hint: '只显示已安装 k3s 的服务器；请选择要应用的目标，可单选或多选。',
    hosts: pool,
    initial: [],
    confirmText: '下一步',
    onConfirm(hosts) {
      openPodApplyConfirm(template, hosts);
    }
  });
}

function openPodApplyConfirm(template, hosts) {
  const targetNames = hosts.map((host) => `<span class="badge neutral">${esc(hostName(host))}</span>`).join('');
  openModal({
    title: '确认应用配置',
    size: 'narrow',
    body: `<div class="alert info" style="margin-bottom:12px">${icon('rocket')}<div>配置：<b>${esc(template.name)}</b><br>目标服务器（${hosts.length} 台）：${targetNames}</div></div>
      <label class="check"><input type="checkbox" id="podApplyDryRun" /> 服务端试运行（不写入集群）</label>
      <div class="tiny dim" style="margin-top:8px;line-height:1.65">不勾选试运行会直接把配置写入这些 k3s 集群；同一集群多选多台会重复 apply 同一个资源，通常只需选择一台。</div>`,
    foot: `<button class="btn" data-close="1">取消</button><button class="btn primary" id="podApplyConfirmBtn">${icon('check')} 应用</button>`,
    onMount(box) {
      $('#podApplyConfirmBtn', box.el).addEventListener('click', () => {
        const dryRun = !!($('#podApplyDryRun', box.el) && $('#podApplyDryRun', box.el).checked);
        box.close();
        runPodConfigApply(template, hosts, dryRun);
      });
    }
  });
}

async function runPodConfigApply(template, targets, dryRun) {
  if (!targets.length) {
    toast('请先选择服务器', 'error');
    return;
  }
  const modal = openModal({
    title: dryRun ? '服务端试运行' : '应用到服务器',
    size: 'wide',
    closable: false,
    body: `<div class="row" style="padding:18px 0"><span class="spinner"></span><span class="muted">正在准备应用…</span></div>`,
    foot: '<span class="tiny dim">请稍候…</span>'
  });
  const results = [];
  for (let index = 0; index < targets.length; index++) {
    const host = targets[index];
    modal.setBody(`<div class="row" style="padding:18px 0"><span class="spinner"></span><span class="muted">正在${dryRun ? '试运行' : '应用'} ${esc(hostName(host))}（${index + 1}/${targets.length}）…</span></div>`);
    try {
      const data = await api(`/hosts/${encodeURIComponent(host.id)}/apply`, {
        method: 'POST',
        body: { yaml: template.yaml, namespace: '', dryRun: dryRun ? 'server' : false }
      });
      results.push({ host, ok: true, output: data.output || (dryRun ? '试运行通过' : '已应用') });
    } catch (err) {
      results.push({ host, ok: false, output: errorText(err) });
    }
  }
  const successCount = results.filter((item) => item.ok).length;
  modal.setBody(`<div style="display:flex;flex-direction:column;gap:10px">
    <div class="tiny dim">${dryRun ? '试运行结果' : '应用结果'}：成功 ${successCount} 台，失败 ${results.length - successCount} 台</div>
    ${results.map((item) => `<div class="pod-config-item">
      <div class="pod-config-main">
        <div class="row"><b>${esc(hostName(item.host))}</b><span class="spacer"></span>${badge(item.ok ? '成功' : '失败', item.ok ? 'ok' : 'err')}</div>
        <pre class="logbox" style="max-height:160px;margin:8px 0 0;white-space:pre-wrap">${esc(String(item.output || '').slice(0, 4000))}</pre>
      </div>
    </div>`).join('')}
  </div>`);
  const foot = $('.modal-foot', modal.el);
  if (foot) foot.innerHTML = '<button class="btn" data-close="1">关闭</button>';
  S.workloadData = null;
  if (successCount) toast(dryRun ? '服务端试运行完成' : `已应用到 ${successCount} 台服务器`, 'success');
  else toast(dryRun ? '试运行全部失败' : '应用全部失败', 'error');
}

function renderDeployCustom() {
  const view = $('#view');
  const allTemplates = S.deploymentTemplates || [];
  const kinds = podConfigKinds(allTemplates);
  let filter = S.podConfigTypeFilter || 'all';
  if (filter !== 'all' && !kinds.includes(filter)) filter = 'all';
  S.podConfigTypeFilter = filter;
  const templates = filter === 'all' ? allTemplates : allTemplates.filter((template) => podConfigInfo(template).kinds.includes(filter));
  const loaded = S.deploymentTemplatesLoaded;
  const empty = `<div class="empty" style="padding:30px 16px">
    ${icon('layers', 'eico')}
    <p style="margin-top:8px">还没有本地配置</p>
    <div class="tiny dim" style="margin-bottom:14px">新增 Pod、Deployment、Service 等配置，或导入本地 YAML 文件后，会显示在这里。</div>
    <div class="row" style="justify-content:center;gap:8px;flex-wrap:wrap">
      <button class="btn" data-action="pod-config-import">${icon('download')} 导入配置文件</button>
      <button class="btn primary" data-action="pod-config-add">${icon('plus')} 新增配置</button>
    </div>
  </div>`;
  const filteredEmpty = `<div class="empty" style="padding:30px 16px">
    ${icon('layers', 'eico')}
    <p style="margin-top:8px">「${esc(filter)}」类型下没有配置</p>
    <div class="tiny dim" style="margin-bottom:14px">可以切换类型，或显示全部本地配置。</div>
    <button class="btn" data-action="pod-config-filter-clear">显示全部</button>
  </div>`;
  view.innerHTML = `${DEMO ? demoBanner() : ''}${deployCenterHead('custom')}
    <div class="card">
      <div class="card-head">
        <h3>${icon('layers')} 本地配置</h3>
        <div class="row">
          <span class="hint">${allTemplates.length ? (filter === 'all' ? `${allTemplates.length} 个配置` : `${templates.length} / ${allTemplates.length} 个配置`) : '保存在 data/deployment-templates'}</span>
          <button class="btn sm" data-action="pod-config-refresh" title="重新读取本地配置目录">${icon('refresh')} 刷新</button>
          <button class="btn sm" data-action="pod-config-import" title="从本地 YAML 文件导入配置">${icon('download')} 导入配置文件</button>
          <button class="btn sm primary" data-action="pod-config-add">${icon('plus')} 新增配置</button>
        </div>
      </div>
      <div class="card-body">
        ${allTemplates.length ? `<div class="row" style="gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:10px">
          <span class="tiny dim" style="letter-spacing:.6px">按类型过滤</span>
          <select class="select" id="podConfigTypeFilter" style="width:auto;min-width:130px">
            <option value="all" ${filter === 'all' ? 'selected' : ''}>全部类型</option>
            ${kinds.map((kind) => `<option value="${esc(kind)}" ${filter === kind ? 'selected' : ''}>${esc(kind)}</option>`).join('')}
          </select>
          <span class="tiny dim">类型从 YAML 的 kind 字段读取，多文档配置会归入所有包含的类型。</span>
        </div>` : ''}
        ${!loaded ? `<div class="row" style="padding:18px 0"><span class="spinner"></span><span class="muted">正在读取本地配置…</span></div>`
          : !allTemplates.length ? empty
          : !templates.length ? filteredEmpty
          : `<div class="pod-config-list">${templates.map(podConfigCardHTML).join('')}</div>`}
      </div>
    </div>
    <details class="card deploy-guide" style="margin-top:16px">
      <summary class="card-head">
        <h3>${icon('scroll')} 部署指导</h3>
        <span class="hint">点击展开 / 收起</span>
      </summary>
      <div class="card-body small muted" style="line-height:1.85">
        <div class="guide-lead">本地配置来自 data/deployment-templates/。先新增、导入或编辑配置，再点配置卡片的「应用」选择目标服务器；只会显示已安装 k3s 的服务器，支持单选和多选。列表顶部可按 YAML 中的 kind 过滤配置类型。</div>
        <div class="guide-types">
          <div><b>Deployment</b>：长期运行、多副本、滚动更新，业务应用优先选这个。</div>
          <div><b>Pod（单实例）</b>：临时调试或单实例验证；换镜像不能原地改，需要删除 Pod 重建。</div>
          <div><b>Service / Ingress</b>：分别提供固定访问入口和域名入口；Service 的 selector 要和负载 labels 对应。</div>
          <div><b>CronJob / ConfigMap / Namespace</b>：分别用于定时任务、配置数据和命名空间。</div>
        </div>
        <div class="guide-section">
          <h4>应用步骤</h4>
          <ol class="guide-steps">
            <li><b>新增 / 导入 / 编辑：</b>点「新增配置」或已有配置的「编辑」，可在「图形化」和「查看 YAML」之间来回切换；在查看 YAML 中修改后通过语法检测才能保存，配置会写入 data/deployment-templates/。列表顶部的「导入配置文件」可以选择本地 YAML，确认文件名和语法后导入；配置文件名可直接修改，保存时会检查重名。</li>
            <li><b>选择服务器：</b>点配置卡片的「应用」，在弹窗中只显示已安装 k3s 的机器；可选一台或多台，选择后进入确认弹窗。</li>
            <li><b>先试运行：</b>建议在确认弹窗勾选「服务端试运行」，确认 YAML、权限和准入规则通过后再正式应用。</li>
            <li><b>正式应用：</b>确认后会对选中的每台服务器依次执行 apply；结果会逐台列出。</li>
          </ol>
        </div>
        <div class="guide-note">同一集群多选多台入口会重复 apply 同一个资源，通常只需选择其中一台；不同集群可以分别选择。</div>
      </div>
    </details>`;
  if (!loaded) toast('本地配置尚未加载，请稍候或点刷新', 'info', 1800);
}

function deployOptionsFromForm() {
  const disable = componentsToDisable($('#deployOptions') || document);
  const installMode = ($('input[name="depInstallMode"]:checked') || {}).value || 'online';
  const pkg = installMode === 'offline' ? offlinePackageById(($('#depOfflinePackage') || {}).value || '') : null;
  return {
    version: installMode === 'offline' ? (pkg ? pkg.version : '') : (($('#depVersion') || {}).value || ''),
    channel: ($('#depChannel') || {}).value || 'stable',
    token: ($('#depToken') || {}).value || '',
    flags: (($('#depFlags') || {}).value || '').split('\n').map((s) => s.trim()).filter(Boolean),
    disable,
    installMode,
    offlinePackageId: pkg ? pkg.id : '',
    mirror: $('#depMirror') && $('#depMirror').checked ? 'cn' : '',
    force: !!($('#depForce') && $('#depForce').checked)
  };
}

async function startClusterDeploy() {
  const form = ensureDeployForm();
  const serverIds = $$('[data-deploy-server]').filter((el) => el.checked).map((el) => el.value);
  const agentIds = $$('[data-deploy-agent]').filter((el) => el.checked).map((el) => el.value);
  if (![1, 3, 5].includes(serverIds.length)) { toast('控制平面数量必须是 1 台（单机）、3 台或 5 台（高可用）', 'error'); return; }
  const installedTargets = installedDeployTargets([...serverIds, ...agentIds]);
  if (installedTargets.length && !form.force) {
    toast(`所选节点中 ${installedTargets.length} 台已安装 Kubernetes（${installedTargets.map(hostName).join('、')}），不能用于新建集群；请重新读取服务器信息或到服务器页重装`, 'error');
    renderView();
    return;
  }
  form.serverIds = serverIds;
  form.agentIds = agentIds;
  const single = serverIds.length === 1;
  const serverNames = serverIds.map((id) => hostName(findHost(id))).join('、');
  const options = deployOptionsFromForm();
  const offlinePkg = offlinePackageById(options.offlinePackageId);
  if (options.installMode === 'offline' && !offlinePkg) {
    toast('请选择离线安装包', 'error');
    return;
  }
  const ok = await confirmDialog({
    title: single ? '开始部署 k3s 单机集群' : '开始部署 k3s 高可用集群',
    message: `即将部署 k3s 集群：<b>${serverIds.length} 台控制平面${single ? '（单机）' : ''}</b>（${esc(serverNames)}），工作节点 ${agentIds.length} 台。<br><br>安装方式：<b>${options.installMode === 'offline' ? `离线（${esc(offlinePkg.version)} · ${esc(offlinePkg.archLabel)}）` : '在线下载'}</b>${options.force ? '<br><b>已勾选强制重装</b>，已有安装会被覆盖。' : ''}<br><br>部署过程会修改目标服务器，确定继续？`,
    confirmText: '开始部署',
    danger: true
  });
  if (!ok) return;
  try {
    const data = await api('/deploy/cluster', { method: 'POST', body: { serverIds, agentIds, options } });
    openJobModal(data.jobId);
    refreshJobs();
    toast('部署操作已启动', 'success');
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

async function deployPreflight() {
  const form = ensureDeployForm();
  const serverIds = $$('[data-deploy-server]').filter((el) => el.checked).map((el) => el.value);
  const agentIds = $$('[data-deploy-agent]').filter((el) => el.checked).map((el) => el.value);
  if (![1, 3, 5].includes(serverIds.length)) { toast('控制平面数量必须是 1 台（单机）、3 台或 5 台（高可用）', 'error'); return; }
  const installedTargets = installedDeployTargets([...serverIds, ...agentIds]);
  if (installedTargets.length && !form.force) {
    toast(`所选节点中 ${installedTargets.length} 台已安装 Kubernetes（${installedTargets.map(hostName).join('、')}），不能用于新建集群；请重新读取服务器信息或到服务器页重装`, 'error');
    renderView();
    return;
  }
  const ids = [...serverIds, ...agentIds];
  const modal = openModal({
    title: '部署前预检',
    size: 'wide',
    body: '<div class="row" style="padding:20px 0"><span class="spinner"></span><span class="muted">正在并发检查 ' + ids.length + ' 个节点…</span></div>',
    foot: '<button class="btn ghost" data-close="1">关闭</button>'
  });
  const results = await Promise.allSettled(ids.map(async (id) => {
    const host = findHost(id);
    const mode = serverIds.includes(id) ? 'k3s-server' : 'k3s-agent';
    const res = await api(`/hosts/${encodeURIComponent(id)}/preflight`, { method: 'POST', body: { mode, installMode: (S.deployForm && S.deployForm.installMode) || 'online' } });
    return { host, res };
  }));
  const body = $('#modalRoot .modal-body');
  if (!body) return;
  body.innerHTML = `<div style="display:flex;flex-direction:column;gap:10px">
    ${results.map((r, i) => {
      const host = findHost(ids[i]);
      if (r.status === 'rejected') {
        return `<div class="preflight-card"><div class="row"><b>${esc(hostName(host))}</b><span class="spacer"></span>${badge('预检失败', 'err')}</div><div class="tiny dim" style="margin-top:5px">${esc(errorText(r.reason))}</div></div>`;
      }
      const res = r.value.res || {};
      const checks = res.checks || [];
      const fail = checks.filter((c) => c.status === 'fail');
      const warn = checks.filter((c) => c.status === 'warn');
      return `<div class="preflight-card">
        <div class="row"><b>${esc(hostName(host))}</b><span class="spacer"></span>${res.ok ? badge('可以部署', 'ok') : badge('存在阻塞项', 'err')}</div>
        <div class="tiny dim" style="margin-top:4px">${checks.length} 项检查 · ${fail.length} 失败 · ${warn.length} 警告</div>
        ${fail.length ? `<div style="margin-top:8px">${fail.map((c) => `<div class="tiny" style="color:var(--err);margin-top:3px">✕ ${esc(c.label)}：${esc(c.detail)}</div>`).join('')}</div>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

async function applyYamlFromDeploy() {
  const host = deployTargetHost();
  if (!host || !clusterCapable(host)) { toast('没有可用的集群', 'error'); return; }
  const yaml = $('#deployYaml').value;
  if (!yaml.trim()) { toast('YAML 内容为空', 'error'); return; }
  const syntax = checkYamlSyntax(yaml);
  if (!syntax.ok) {
    paintYamlSyntaxStatus(syntax);
    const output = $('#yamlOutput');
    if (output) {
      output.classList.remove('hidden');
      output.textContent = `YAML 语法错误：${syntax.message}`;
    }
    toast(`YAML 语法错误：${syntax.message}`, 'error');
    return;
  }
  const namespace = $('#yamlNamespace').value.trim();
  const dryRun = $('#yamlDryRun').checked ? 'server' : false;
  const btn = $('[data-action="yaml-apply"]');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> 应用中'; }
  const output = $('#yamlOutput');
  output.classList.remove('hidden');
  output.textContent = dryRun ? '正在服务端试运行…' : '正在应用…';
  try {
    const data = await api(`/hosts/${encodeURIComponent(host.id)}/apply`, { method: 'POST', body: { yaml, namespace, dryRun } });
    output.textContent = data.output || '已应用';
    toast(dryRun ? '试运行通过（未写入）' : 'YAML 已应用', 'success');
    if (!dryRun) { S.workloadData = null; }
  } catch (err) {
    output.innerHTML = '';
    output.textContent = errorText(err) + (err.detail ? '\n\n' + err.detail : '');
    toast(errorText(err), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = icon('check') + ' 应用 YAML'; }
  }
}

/* ============================================================
 * 操作记录
 * ============================================================ */
function renderJobs() {
  const view = $('#view');
  view.innerHTML = `
    ${DEMO ? demoBanner() : ''}
    <div class="view-head">
      <div><h2>操作记录</h2><p>安装、部署、升级、卸载等操作记录，已持久化到项目 log/operations 目录，服务重启后仍可查看；在记录上右键可删除单条或全部记录</p></div>
      <div class="toolbar">
        <button class="btn" data-action="jobs-refresh">${icon('refresh')} 刷新</button>
      </div>
    </div>
    <div class="card">
      <div class="table-wrap" style="border:none;border-radius:14px">
        <table class="data" style="min-width:960px">
          <thead><tr><th>状态</th><th>操作</th><th>服务器</th><th>类型</th><th>开始时间</th><th>耗时</th><th class="right">详情</th></tr></thead>
          <tbody id="jobsTbody">${jobsRowsHTML()}</tbody>
        </table>
      </div>
    </div>`;
  const tbody = $('#jobsTbody');
  if (tbody) tbody.oncontextmenu = onJobsContextMenu;
}

// 记录里只存 hostId / hostIds 之类的引用，这里还原成「名称 (IP)」；
// 服务器配置被删掉时退回到 id（形如 172-16-26-240 的还能还原出 IP）
function ipFromHostId(id) {
  const match = /^(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/.exec(String(id || ''));
  return match ? match.slice(1, 5).join('.') : '';
}

function jobHostIds(job) {
  const meta = (job && job.meta) || {};
  const raw = [];
  if (meta.hostId) raw.push(meta.hostId);
  for (const key of ['hostIds', 'serverIds', 'agentIds']) {
    if (Array.isArray(meta[key])) raw.push(...meta[key]);
  }
  return Array.from(new Set(raw.filter(Boolean)));
}

function jobHostInfo(id) {
  const host = (S.hosts || []).find((item) => String(item.id) === String(id));
  if (!host) {
    const ip = ipFromHostId(id);
    return { id: String(id), ip, name: '', label: ip || String(id) };
  }
  const ip = String(host.host || '').trim();
  const name = String(host.name || '').trim();
  const label = name && ip && name !== ip ? `${name} (${ip})` : (ip || name || String(id));
  return { id: String(id), ip, name, label };
}

// 本次操作涉及的全部服务器，一台一行
function jobMachineLines(job) {
  return jobHostIds(job).map((id) => jobHostInfo(id).label);
}

function jobsRowsHTML() {
  if (!S.jobs.length) {
    return `<tr><td colspan="7"><div class="empty">${icon('activity', 'eico')}<h4>暂无操作记录</h4><p>安装、部署、升级或卸载操作会在这里留下记录。</p></div></td></tr>`;
  }
  return S.jobs.map((job) => {
    const machines = jobMachineLines(job);
    return `
    <tr data-action="job-open" data-job="${esc(job.id)}">
      <td><span class="badge ${jobTone(job.status)}"><i class="dot ${job.status === 'running' ? 'info pulse' : job.status === 'success' ? 'ok' : job.status === 'failed' ? 'err' : ''}"></i>${esc(jobStatusText(job.status))}</span></td>
      <td class="primary">${esc(job.title)}</td>
      <td class="machine" title="${esc(machines.join(' / '))}">${machines.length ? machines.map((line) => `<div>${esc(line)}</div>`).join('') : '<span class="dim">—</span>'}</td>
      <td>${badge(job.type || 'task', 'neutral')}</td>
      <td class="mono">${esc(fmtTime(job.createdAt))}</td>
      <td class="mono">${esc(duration(job.startedAt, job.finishedAt))}</td>
      <td>
        <div class="row-actions">
          <button class="btn sm" data-action="job-open" data-job="${esc(job.id)}">${icon('terminal')} 日志</button>
          ${job.status === 'running' ? `<button class="btn sm danger" data-action="job-cancel" data-job="${esc(job.id)}">${icon('stop')} 取消</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function renderJobsList() {
  const tbody = $('#jobsTbody');
  if (tbody) tbody.innerHTML = jobsRowsHTML();
}

/* ---------------- 操作记录右键菜单：删除当前 / 删除全部 ---------------- */
let jobContextMenuEl = null;

function closeJobContextMenu() {
  if (!jobContextMenuEl) return;
  jobContextMenuEl.remove();
  jobContextMenuEl = null;
}

function openJobContextMenu(x, y, job) {
  closeJobContextMenu();
  const menu = document.createElement('div');
  menu.id = 'jobContextMenu';
  menu.className = 'ctx-menu';
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', '操作记录');
  menu.innerHTML = `
    <button type="button" class="ctx-item danger" role="menuitem" data-job-action="delete-one">${icon('trash')}<span>删除当前记录</span></button>
    <div class="ctx-sep"></div>
    <button type="button" class="ctx-item danger" role="menuitem" data-job-action="delete-all">${icon('trash')}<span>删除所有记录</span></button>`;
  menu.style.visibility = 'hidden';
  menu.style.left = '0px';
  menu.style.top = '0px';
  document.body.appendChild(menu);
  jobContextMenuEl = menu;

  const rect = menu.getBoundingClientRect();
  const gap = 8;
  const left = Math.max(gap, Math.min(x, window.innerWidth - rect.width - gap));
  let top = y + 4;
  if (top + rect.height > window.innerHeight - gap) top = Math.max(gap, y - rect.height - 4);
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = '';

  menu.addEventListener('click', async (event) => {
    const btn = event.target.closest('[data-job-action]');
    if (!btn) return;
    const action = btn.dataset.jobAction;
    closeJobContextMenu();
    if (action === 'delete-one') await deleteJobRecord(job);
    else if (action === 'delete-all') await deleteAllJobRecords();
  });
  const first = menu.querySelector('.ctx-item');
  if (first) first.focus({ preventScroll: true });
}

function onJobsContextMenu(event) {
  const row = event.target.closest('tr[data-job]');
  if (!row) return;
  event.preventDefault();
  const job = (S.jobs || []).find((item) => item.id === row.dataset.job) || null;
  if (!job) return;
  openJobContextMenu(event.clientX, event.clientY, job);
}

async function deleteJobRecord(job) {
  if (!job) return;
  const ok = await confirmDialog({
    title: '删除操作记录',
    message: `确定删除这条操作记录吗？<br><b>${esc(job.title)}</b><div class="tiny dim" style="margin-top:4px">${esc(jobMachineLines(job).join(' / ') || '未记录服务器')}</div><div class="tiny dim" style="margin-top:8px">记录文件会从 logs/operations 删除，导出未下载的 tar 缓存也会一并清理，删除后无法恢复。</div>`,
    confirmText: '确认'
  });
  if (!ok) return;
  try {
    await api(`/jobs/${encodeURIComponent(job.id)}`, { method: 'DELETE' });
    await refreshJobs(false);
    renderJobsList();
    toast('操作记录已删除', 'success');
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

async function deleteAllJobRecords() {
  const total = (S.jobs || []).length;
  if (!total) {
    toast('暂无操作记录', 'info');
    return;
  }
  const ok = await confirmDialog({
    title: '删除所有操作记录',
    message: `确定删除全部 <b>${total}</b> 条操作记录吗？<div class="tiny dim" style="margin-top:8px">logs/operations 下的记录文件会被全部删除，导出未下载的 tar 缓存也会一并清理，删除后无法恢复。</div>`,
    confirmText: '确认'
  });
  if (!ok) return;
  try {
    await api('/jobs', { method: 'DELETE' });
    await refreshJobs(false);
    renderJobsList();
    toast(`已删除 ${total} 条操作记录`, 'success');
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

async function cancelJob(id) {
  try {
    await api(`/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST' });
    toast('已请求取消操作', 'info');
    setTimeout(() => refreshJobs(), 600);
  } catch (err) {
    toast(errorText(err), 'error');
  }
}

