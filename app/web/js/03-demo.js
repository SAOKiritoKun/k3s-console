'use strict';

/* ============================================================
 * 演示数据（?demo=1，仅用于无集群环境预览界面）
 * ============================================================ */
const demoTemplates = [];
const demoGroups = ['默认分组', '生产环境'];
// 演示模式下被“删除”的操作记录（右键菜单），刷新列表时保持删除结果
const demoDeletedJobIds = new Set();
let demoAllJobsDeleted = false;
// 提到模块作用域，删除分组时才能真正删掉组内演示服务器
const demoHosts = [
  { id: 'demo-master', name: '生产主节点', group: '生产环境', transport: 'ssh', host: '10.0.0.11', port: 22, user: 'root', role: 'server', notes: '' },
  { id: 'demo-agent-1', name: '生产工作节点 1', group: '生产环境', transport: 'ssh', host: '10.0.0.12', port: 22, user: 'root', role: 'agent', notes: '' },
  { id: 'demo-agent-2', name: '生产工作节点 2', group: '生产环境', transport: 'ssh', host: '10.0.0.13', port: 22, user: 'root', role: 'agent', notes: '' },
  { id: 'demo-agent-3', name: '测试节点', group: '默认分组', transport: 'ssh', host: '10.0.0.21', port: 22, user: 'root', role: 'agent', notes: '' }
];

async function demoApi(path, options) {
  const method = options.method || 'GET';
  const now = Date.now();
  const iso = (minutesAgo) => new Date(now - minutesAgo * 60000).toISOString();
  if (path === '/health') {
    return { name: 'k3s 集群管家', version: '1.0.0', node: 'v22', platform: 'win32 x64', hasSsh2: true, uptimeSeconds: 1200, hosts: demoHosts.length };
  }
  const demoDetected = {
    'demo-master': {
      id: 'demo-master', reachable: true, hostname: 'prod-master-1', ip: '10.0.0.11', user: 'root', isRoot: true, sudo: 'root',
      os: { id: 'ubuntu', pretty: 'Ubuntu 22.04.4 LTS', kernel: '5.15.0-105-generic', arch: 'x86_64' },
      resources: { cpu: 8, memMB: 16384, swapMB: 0, diskFreeMB: 184320, uptimeSeconds: 864000 },
      components: { k3s: { installed: true, version: 'k3s version v1.30.4+k3s1', service: 'active', agentService: 'inactive' }, kubectl: { installed: true }, containerd: { installed: true }, docker: { installed: false } },
      kubeconfig: { path: '/etc/rancher/k3s/k3s.yaml', exists: true },
      k8s: { installed: true, flavor: 'k3s', version: 'v1.30.4+k3s1', role: 'server', managed: true },
      cluster: { reachable: true, version: 'v1.30.4+k3s1', nodeCount: 3, readyNodes: 3, error: null },
      portsInUse: [], cgroup: 'cgroup2fs', init: 'systemd', checkedAt: iso(2)
    },
    'demo-agent-1': {
      id: 'demo-agent-1', reachable: true, hostname: 'prod-worker-1', ip: '10.0.0.12', user: 'root', isRoot: true, sudo: 'root',
      os: { id: 'ubuntu', pretty: 'Ubuntu 22.04.4 LTS', kernel: '5.15.0-105-generic', arch: 'x86_64' },
      resources: { cpu: 16, memMB: 65536, swapMB: 0, diskFreeMB: 512000, uptimeSeconds: 864000 },
      components: { k3s: { installed: true, version: 'k3s version v1.30.4+k3s1', service: 'inactive', agentService: 'active' }, kubectl: { installed: false }, containerd: { installed: true }, docker: { installed: false } },
      kubeconfig: { path: '', exists: false },
      k8s: { installed: true, flavor: 'k3s', version: 'v1.30.4+k3s1', role: 'agent', managed: true },
      cluster: { reachable: true, version: 'v1.30.4+k3s1', nodeCount: 3, readyNodes: 3, error: null },
      portsInUse: [], cgroup: 'cgroup2fs', init: 'systemd', checkedAt: iso(2)
    },
    'demo-agent-2': {
      id: 'demo-agent-2', reachable: true, hostname: 'prod-worker-2', ip: '10.0.0.13', user: 'root', isRoot: true, sudo: 'root',
      os: { id: 'debian', pretty: 'Debian GNU/Linux 12 (bookworm)', kernel: '6.1.0-18-amd64', arch: 'x86_64' },
      resources: { cpu: 8, memMB: 32768, swapMB: 2048, diskFreeMB: 240000, uptimeSeconds: 864000 },
      components: { k3s: { installed: true, version: 'k3s version v1.30.4+k3s1', service: 'active', agentService: 'active' }, kubectl: { installed: false }, containerd: { installed: true }, docker: { installed: false } },
      kubeconfig: { path: '', exists: false },
      k8s: { installed: true, flavor: 'k3s', version: 'v1.30.4+k3s1', role: 'agent', managed: true },
      cluster: { reachable: true, version: 'v1.30.4+k3s1', nodeCount: 3, readyNodes: 3, error: null },
      portsInUse: [], cgroup: 'cgroup2fs', init: 'systemd', checkedAt: iso(2)
    }
  };
  for (const d of Object.values(demoDetected)) {
    if (d.cluster && d.cluster.reachable) d.nodes = demoNodes();
  }
  if (path === '/templates') {
    if (method === 'POST') {
      const body = options.body || {};
      const name = String(body.name || '').trim().replace(/\.ya?ml$/i, '');
      if (!name) throw new Error('模板名称不能为空');
      const id = `${name}.yaml`;
      const template = { id, name, yaml: String(body.yaml || '') };
      const index = demoTemplates.findIndex((item) => item.id === id);
      if (index >= 0) demoTemplates[index] = template;
      else demoTemplates.push(template);
      return { template };
    }
    return { templates: demoTemplates.slice() };
  }
  if (/^\/templates\/[^/]+$/.test(path) && method === 'DELETE') {
    const id = decodeURIComponent(path.split('/')[2]);
    const index = demoTemplates.findIndex((item) => item.id === id);
    if (index < 0) throw new Error('模板不存在');
    demoTemplates.splice(index, 1);
    return { deleted: true };
  }
  if (path === '/config') {
    return { config: { app: { title: 'k3s 集群管家', host: '127.0.0.1', port: 8964, accessToken: '', autoDetect: true }, ssh: { defaultUser: 'root', defaultPort: 22, hostKeyPolicy: 'accept-new' }, k3s: { channel: 'stable', apiPort: 6443, clusterToken: '__UNCHANGED__' } } };
  }
  if (path === '/hosts') return { hosts: demoHosts.map((h) => ({ ...h, auth: { type: 'password', password: '__UNCHANGED__' }, detected: demoDetected[h.id] })), groups: demoGroups.map((name) => ({ name, count: demoHosts.filter((h) => h.group === name).length, builtin: name === '默认分组' })) };
  if (path === '/groups') {
    if (method === 'POST') {
      const name = String((options.body || {}).name || '').trim();
      if (!name) throw new Error('分组名称不能为空');
      if (demoGroups.includes(name)) throw new Error('分组已存在');
      demoGroups.push(name);
      return { name, groups: demoGroups.slice() };
    }
    return { groups: demoGroups.map((name) => ({ name, count: demoHosts.filter((h) => h.group === name).length, builtin: name === '默认分组' })) };
  }
  if (/^\/hosts\/[^/]+\/group$/.test(path) && method === 'PUT') {
    const id = decodeURIComponent(path.split('/')[2]);
    const group = String((options.body || {}).group || '').trim();
    if (!group || !demoGroups.includes(group)) throw new Error('分组不存在：' + group);
    const host = demoHosts.find((h) => h.id === id);
    if (!host) throw new Error('找不到主机：' + id);
    host.group = group;
    return { host: { ...host, auth: { type: 'password', password: '__UNCHANGED__' } } };
  }
  if (/^\/groups\/[^/]+$/.test(path) && method === 'PUT') {
    const from = decodeURIComponent(path.split('/')[2]);
    const name = String((options.body || {}).name || '').trim();
    if (from === '默认分组') throw new Error('默认分组是内置分组，不能重命名');
    const index = demoGroups.indexOf(from);
    if (index < 0) throw new Error('找不到分组：' + from);
    if (demoGroups.includes(name)) throw new Error('分组已存在：' + name);
    demoGroups[index] = name;
    for (const h of demoHosts) if (h.group === from) h.group = name;
    return { name };
  }
  if (/^\/groups\/[^/]+$/.test(path) && method === 'DELETE') {
    const name = decodeURIComponent(path.split('/')[2]);
    if (name === '默认分组') throw new Error('默认分组是内置分组，不能删除');
    const index = demoGroups.indexOf(name);
    if (index < 0) throw new Error('找不到分组：' + name);
    const removed = demoHosts.filter((h) => h.group === name).map((h) => ({ id: h.id, name: h.name }));
    demoGroups.splice(index, 1);
    for (let i = demoHosts.length - 1; i >= 0; i -= 1) {
      if (demoHosts[i].group === name) demoHosts.splice(i, 1);
    }
    return { name, removed };
  }
  if (/^\/hosts\/[^/]+\/password$/.test(path)) return { password: 'demo-ssh-password' };
  if (/^\/hosts\/[^/]+\/images$/.test(path)) {
    if (method === 'DELETE') return { deleted: true };
    return { images: demoImages(), total: demoImages().length, fetchedAt: new Date().toISOString() };
  }
  if (/^\/hosts\/[^/]+\/images\/export$/.test(path)) return { jobId: 'job_demo_export' };
  if (/^\/images\/import$/.test(path)) {
    return { jobId: 'job_demo_import', uploadUrl: '/api/demo/upload', total: 0 };
  }
  if (/^\/hosts\/[^/]+\/images\/pull$/.test(path)) return { output: '演示模式：镜像拉取已模拟', pulledAt: new Date().toISOString() };
  if (/^\/hosts\/[^/]+\/detect$/.test(path)) {
    const id = decodeURIComponent(path.split('/')[2]);
    return demoDetected[id] || { id, reachable: false, error: '演示主机不可达' };
  }
  if (path === '/meta') return null;
  if (/\/overview$/.test(path)) {
    const pods = demoPods();
    return {
      serverVersion: 'v1.30.4+k3s1', clientVersion: 'v1.30.4',
      nodes: demoNodes(), nodeStats: { total: 3, ready: 3, controlPlane: 1 },
      podStats: {
        total: pods.length, running: pods.filter((p) => p.status === 'Running').length,
        pending: 1, failed: 1, succeeded: 12, unhealthy: pods.filter((p) => !p.healthy).length,
        restarts: pods.reduce((s, p) => s + p.restarts, 0)
      },
      pods: pods.filter((p) => !p.healthy).slice(0, 6),
      deploymentStats: { total: 8, ready: 7 }, serviceCount: 11, namespaceCount: 6,
      fetchedAt: new Date().toISOString()
    };
  }
  if (/\/nodes$/.test(path)) return { nodes: demoNodes() };
  if (/\/namespaces$/.test(path)) {
    return { namespaces: ['default', 'kube-system', 'monitoring', 'ingress-nginx', 'apps', 'dev'].map((name) => ({ name, status: 'Active', createdAt: iso(10000) })) };
  }
  if (/\/resources\?/.test(path)) {
    const params = new URLSearchParams(path.split('?')[1]);
    const kind = params.get('kind') || 'pods';
    const ns = params.get('namespace') || '';
    if (kind === 'ingressclasses') {
      return {
        kind: 'ingressclasses',
        label: 'IngressClass',
        namespaced: false,
        columns: [
          { key: 'name', label: '名称', primary: true },
          { key: 'controller', label: '控制器' },
          { key: 'default', label: '默认', type: 'bool' }
        ],
        items: [
          { name: 'traefik', controller: 'traefik.io/ingress-controller', default: true },
          { name: 'nginx', controller: 'k8s.io/ingress-nginx', default: false }
        ]
      };
    }
    return demoResources(kind, ns);
  }
  if (/\/top$/.test(path)) {
    return {
      available: true,
      nodes: demoNodes().map((n, i) => ({ name: n.name, cpu: [2.1, 1.2, 0.8][i] + ' cores', cpuPercent: [26, 15, 10][i] + '%', memory: [7.2, 9.4, 5.1][i] + ' GB', memoryPercent: [44, 28, 16][i] + '%' })),
      pods: []
    };
  }
  if (/\/events\?/.test(path)) return { items: demoEvents(), columns: [] };
  if (/\/logs\?/.test(path)) return { logs: demoLogs() };
  if (/\/resource\?/.test(path)) {
    const params = new URLSearchParams(path.split('?')[1]);
    const kind = params.get('kind');
    const name = params.get('name');
    return { yaml: demoYaml(kind, name), kind, name, namespace: params.get('namespace') || '' };
  }
  if (path === '/jobs' && method === 'DELETE') {
    demoAllJobsDeleted = true;
    demoDeletedJobIds.clear();
    return { deleted: true };
  }
  if (/^\/jobs\/[^/]+$/.test(path) && method === 'DELETE') {
    demoDeletedJobIds.add(decodeURIComponent(path.split('/')[2]));
    return { deleted: true };
  }
  if (path === '/jobs') return { jobs: demoJobs() };
  if (/^\/jobs\/[^/]+$/.test(path)) {
    const id = decodeURIComponent(path.split('/')[2]);
    return { job: demoJobs().find((job) => job.id === id) || demoJobs()[0] };
  }
  if (/^\/jobs\/[^/]+\/stream$/.test(path)) throw new Error('演示模式不支持实时日志');
  if (/\/apply$/.test(path)) return { output: 'deployment.apps/demo-app configured（演示模式）' };
  if (/\/scale$/.test(path) || /\/restart$/.test(path) || /\/node-action$/.test(path)) return { output: '演示模式：操作已模拟' };
  if (/\/deploy\/cluster$/.test(path)) return { jobId: 'demo-job' };
  if (/\/uninstall$/.test(path) || path === '/uninstall') return { jobId: 'job_demo_uninstall', hostIds: [] };
  throw new Error('演示模式未实现接口：' + path);
}

function demoImages() {
  return [
    { id: 'sha256:9f8c1b2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b', repoTags: ['nginx:1.25', 'nginx:latest'], repoDigests: ['nginx@sha256:1a2b3c4d5e6f'], size: 75916902, createdAt: new Date(Date.now() - 5 * 86400000).toISOString() },
    { id: 'sha256:1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b', repoTags: ['rancher/mirrored-pause:3.6'], repoDigests: [], size: 782336, createdAt: new Date(Date.now() - 5 * 86400000).toISOString() },
    { id: 'sha256:2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c', repoTags: ['ghcr.io/example/app:1.8.2'], repoDigests: ['ghcr.io/example/app@sha256:9f8e7d6c'], size: 245366784, createdAt: new Date(Date.now() - 2 * 86400000).toISOString() },
    { id: 'sha256:3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d', repoTags: ['<none>'], repoDigests: [], size: 52428800, createdAt: new Date(Date.now() - 86400000).toISOString() }
  ];
}

function demoNodes() {
  return [
    { name: 'prod-master-1', status: 'Ready', ready: true, schedulable: true, roles: 'control-plane, master', roleList: ['control-plane', 'master'], version: 'v1.30.4+k3s1', internalIP: '10.0.0.11', os: 'Ubuntu 22.04.4 LTS', kernel: '5.15.0-105-generic', runtime: 'containerd://1.7.16-k3s1', cpu: '8', memory: '15.6 GiB', pods: '110', createdAt: new Date(Date.now() - 864000000).toISOString() },
    { name: 'prod-worker-1', status: 'Ready', ready: true, schedulable: true, roles: 'worker', roleList: ['worker'], version: 'v1.30.4+k3s1', internalIP: '10.0.0.12', os: 'Ubuntu 22.04.4 LTS', kernel: '5.15.0-105-generic', runtime: 'containerd://1.7.16-k3s1', cpu: '16', memory: '64.0 GiB', pods: '110', createdAt: new Date(Date.now() - 864000000).toISOString() },
    { name: 'prod-worker-2', status: 'Ready', ready: true, schedulable: true, roles: 'worker', roleList: ['worker'], version: 'v1.30.4+k3s1', internalIP: '10.0.0.13', os: 'Debian GNU/Linux 12', kernel: '6.1.0-18-amd64', runtime: 'containerd://1.7.16-k3s1', cpu: '8', memory: '31.0 GiB', pods: '110', createdAt: new Date(Date.now() - 864000000).toISOString() }
  ];
}

function demoPods() {
  const defs = [
    ['nginx-ingress-controller-7d8c9f6b9-2xk4p', 'ingress-nginx', 'Running', '1/1', 0, 'prod-worker-1', 100],
    ['cert-manager-5f7f9d9b6c-9q2vn', 'cert-manager', 'Running', '1/1', 0, 'prod-worker-2', 100],
    ['prometheus-server-0', 'monitoring', 'Running', '1/1', 1, 'prod-worker-1', 100],
    ['grafana-7f9b5c8d4f-lm2xq', 'monitoring', 'Running', '1/1', 0, 'prod-worker-2', 100],
    ['demo-app-6d9f8c7b5d-4kt2m', 'apps', 'Running', '1/1', 0, 'prod-worker-1', 30],
    ['demo-app-6d9f8c7b5d-8vq7z', 'apps', 'Running', '1/1', 0, 'prod-worker-2', 30],
    ['worker-queue-5b6d7c8f9-2jklm', 'apps', 'CrashLoopBackOff', '0/1', 14, 'prod-worker-2', 60],
    ['batch-import-28394750-x7k2p', 'apps', 'Completed', '0/1', 0, 'prod-worker-1', 200],
    ['redis-master-0', 'apps', 'Running', '1/1', 0, 'prod-worker-2', 500],
    ['api-gateway-7c8d9e6f5-9x2mn', 'apps', 'Pending', '0/1', 0, '-', 2]
  ];
  return defs.map((d) => ({
    name: d[0], namespace: d[1], status: d[2], ready: d[3], restarts: d[4], node: d[5],
    createdAt: new Date(Date.now() - d[6] * 86400000).toISOString(),
    healthy: d[2] === 'Running' || d[2] === 'Completed',
    images: ['ghcr.io/example/app:1.8.2'], containers: [{ name: 'main', image: 'ghcr.io/example/app:1.8.2' }],
    labels: { app: d[0].split('-')[0], tier: 'backend' }, ip: '10.42.1.' + (10 + d[4]), qos: 'Burstable', owner: d[1] === 'apps' ? 'ReplicaSet' : 'StatefulSet'
  }));
}

function demoResources(kind, ns) {
  const filterNs = (items) => (ns ? items.filter((i) => i.namespace === ns) : items);
  const map = {
    pods: () => demoPods().map((p) => ({ ...p, namespace: p.namespace })),
    deployments: () => [
      ['demo-app', 'apps', 3, 3, 'RollingUpdate', 80], ['api-gateway', 'apps', 1, 1, 'RollingUpdate', 120],
      ['worker-queue', 'apps', 2, 1, 'RollingUpdate', 40], ['grafana', 'monitoring', 1, 1, 'Recreate', 300],
      ['prometheus', 'monitoring', 1, 1, 'Recreate', 300], ['cert-manager', 'cert-manager', 1, 1, 'RollingUpdate', 400],
      ['nginx-ingress-controller', 'ingress-nginx', 1, 1, 'RollingUpdate', 500], ['coredns', 'kube-system', 2, 2, 'RollingUpdate', 500]
    ].map((d) => ({
      name: d[0], namespace: d[1], replicas: `${d[3]}/${d[2]}`, desired: d[2], readyNum: d[3], available: d[3],
      updated: d[2], unavailable: d[2] - d[3], healthy: d[2] === d[3], strategy: d[4], createdAt: new Date(Date.now() - d[5] * 86400000).toISOString()
    })),
    services: () => [
      ['demo-app', 'apps', 'ClusterIP', '10.43.12.8', '-', '80→8080/TCP', 60],
      ['api-gateway', 'apps', 'LoadBalancer', '10.43.88.2', '10.0.0.100', '443→8443/TCP', 120],
      ['redis-master', 'apps', 'ClusterIP', 'None', '-', '6379→6379/TCP', 300],
      ['grafana', 'monitoring', 'ClusterIP', '10.43.44.9', '-', '3000→3000/TCP', 300],
      ['nginx-ingress', 'ingress-nginx', 'LoadBalancer', '10.43.0.15', '10.0.0.101', '80→80/TCP, 443→443/TCP', 500]
    ].map((s) => ({
      name: s[0], namespace: s[1], type: s[2], clusterIP: s[3], externalIP: s[4], ports: s[5],
      createdAt: new Date(Date.now() - s[6] * 86400000).toISOString(), selector: 'app=' + s[0], healthy: true
    })),
    nodes: () => demoNodes(),
    namespaces: () => ['default', 'kube-system', 'monitoring', 'ingress-nginx', 'apps', 'dev', 'cert-manager'].map((name) => ({
      name, namespace: '', status: 'Active', healthy: true, createdAt: new Date(Date.now() - 400 * 86400000).toISOString()
    })),
    events: () => demoEvents(),
    configmaps: () => [
      ['demo-app-config', 'apps', 6], ['coredns', 'kube-system', 2], ['grafana-datasources', 'monitoring', 1], ['app-config', 'dev', 3]
    ].map((c) => ({ name: c[0], namespace: c[1], keys: c[2], keyList: 'config.yaml, application.properties', createdAt: new Date(Date.now() - 200 * 86400000).toISOString() })),
    secrets: () => [
      ['demo-app-secret', 'apps', 'Opaque', 3], ['registry-credentials', 'apps', 'kubernetes.io/dockerconfigjson', 1], ['grafana-admin', 'monitoring', 'Opaque', 2]
    ].map((c) => ({ name: c[0], namespace: c[1], type: c[2], keys: c[3], keyList: 'username, password, token', createdAt: new Date(Date.now() - 200 * 86400000).toISOString() })),
    persistentvolumeclaims: () => [
      ['prometheus-data', 'monitoring', 'Bound', '50Gi', 'local-path'], ['redis-data', 'apps', 'Bound', '10Gi', 'local-path']
    ].map((p) => ({ name: p[0], namespace: p[1], status: p[2], capacity: p[3], storageClass: p[4], accessModes: 'ReadWriteOnce', createdAt: new Date(Date.now() - 300 * 86400000).toISOString(), healthy: true })),
    ingresses: () => [
      ['demo-app', 'apps', 'nginx', 'demo.example.com', true], ['grafana', 'monitoring', 'nginx', 'grafana.example.com', true], ['api', 'apps', 'nginx', 'api.example.com', true]
    ].map((i) => ({ name: i[0], namespace: i[1], class: i[2], hosts: i[3], tls: i[4], rules: 1, createdAt: new Date(Date.now() - 100 * 86400000).toISOString() })),
    cronjobs: () => [
      ['db-backup', 'apps', '0 3 * * *', false, 0, 2], ['report-export', 'apps', '0 8 * * 1', false, 0, 24]
    ].map((c) => ({ name: c[0], namespace: c[1], schedule: c[2], suspend: c[3], active: c[4], status: c[3] ? 'Suspended' : 'Active', lastSchedule: new Date(Date.now() - c[5] * 3600000).toISOString(), createdAt: new Date(Date.now() - 100 * 86400000).toISOString(), healthy: true })),
    jobs: () => [
      ['db-backup-28934000', 'apps', 'Complete', '1/1', '42s'], ['report-export-28933200', 'apps', 'Complete', '1/1', '2m18s'], ['migrate-db-28473200', 'apps', 'Failed', '0/1', '3m04s']
    ].map((j) => ({ name: j[0], namespace: j[1], status: j[2], completions: j[3], duration: j[4], healthy: j[2] === 'Complete', createdAt: new Date(Date.now() - 20 * 3600000).toISOString() })),
    statefulsets: () => [
      ['prometheus', 'monitoring', 1, 1], ['redis-master', 'apps', 1, 1]
    ].map((s) => ({ name: s[0], namespace: s[1], replicas: `${s[3]}/${s[2]}`, desired: s[2], current: s[3], serviceName: s[0], healthy: true, createdAt: new Date(Date.now() - 300 * 86400000).toISOString() })),
    daemonsets: () => [
      ['svclb-nginx-ingress', 'ingress-nginx', 3, 3], ['node-exporter', 'monitoring', 3, 3]
    ].map((d) => ({ name: d[0], namespace: d[1], replicas: `${d[3]}/${d[2]}`, desired: d[2], misscheduled: 0, healthy: true, createdAt: new Date(Date.now() - 300 * 86400000).toISOString() })),
    replicasets: () => [
      ['demo-app-6d9f8c7b5d', 'apps', 2, 2], ['demo-app-5c8b7d6f4a', 'apps', 0, 0]
    ].map((r) => ({ name: r[0], namespace: r[1], replicas: `${r[3]}/${r[2]}`, desired: r[2], healthy: true, createdAt: new Date(Date.now() - 2 * 86400000).toISOString() })),
    persistentvolumes: () => [
      ['pvc-1a2b3c', '50Gi', 'local-path', 'Bound', 'monitoring/prometheus-data'],
      ['pvc-4d5e6f', '10Gi', 'local-path', 'Bound', 'apps/redis-data']
    ].map((p) => ({ name: p[0], namespace: '', status: p[3], capacity: p[1], storageClass: p[2], claim: p[4], accessModes: 'ReadWriteOnce', reclaimPolicy: 'Delete', healthy: true, createdAt: new Date(Date.now() - 300 * 86400000).toISOString() })),
    storageclasses: () => [
      ['local-path', 'rancher.io/local-path', 'Delete', 'WaitForFirstConsumer', true]
    ].map((s) => ({ name: s[0], namespace: '', provisioner: s[1], reclaimPolicy: s[2], bindingMode: s[3], default: s[4], createdAt: new Date(Date.now() - 400 * 86400000).toISOString() })),
    serviceaccounts: () => [
      ['default', 'default', 0], ['demo-app', 'apps', 1], ['prometheus', 'monitoring', 1]
    ].map((s) => ({ name: s[0], namespace: s[1], secrets: s[2], createdAt: new Date(Date.now() - 400 * 86400000).toISOString() })),
    networkpolicies: () => [
      ['allow-ingress', 'apps', 'app=demo-app', 'Ingress', 1, 0]
    ].map((n) => ({ name: n[0], namespace: n[1], podSelector: n[2], policyTypes: n[3], ingressRules: n[4], egressRules: n[5], createdAt: new Date(Date.now() - 100 * 86400000).toISOString() })),
    horizontalpodautoscalers: () => [
      ['demo-app', 'apps', 'Deployment/demo-app', 2, 2, 4], ['api-gateway', 'apps', 'Deployment/api-gateway', 1, 1, 6]
    ].map((h) => ({ name: h[0], namespace: h[1], target: h[2], current: h[3], desired: h[3], min: h[4], max: h[5], metrics: 'cpu:52%', createdAt: new Date(Date.now() - 20 * 86400000).toISOString() }))
  };
  const builder = map[kind];
  if (!builder) {
    return { kind, label: kind, namespaced: true, columns: [], items: [], fetchedAt: new Date().toISOString() };
  }
  const def = (S.meta && S.meta.resources && S.meta.resources[kind]) || { label: kind, namespaced: true, columns: [] };
  return { kind, label: def.label, namespaced: def.namespaced, columns: def.columns, items: filterNs(builder()), fetchedAt: new Date().toISOString() };
}

function demoEvents() {
  const defs = [
    ['Warning', 'BackOff', 'Pod/worker-queue-5b6d7c8f9-2jklm', 'Back-off restarting failed container main in pod worker-queue-5b6d7c8f9-2jklm', 14, 2],
    ['Normal', 'Scheduled', 'Pod/api-gateway-7c8d9e6f5-9x2mn', 'Successfully assigned apps/api-gateway to prod-worker-1', 1, 3],
    ['Warning', 'FailedScheduling', 'Pod/api-gateway-7c8d9e6f5-9x2mn', '0/3 nodes are available: 3 Insufficient cpu.', 6, 4],
    ['Normal', 'Pulled', 'Pod/demo-app-6d9f8c7b5d-4kt2m', 'Container image already present on machine', 1, 30],
    ['Normal', 'Created', 'Pod/db-backup-28934000-x7k2p', 'Created container backup', 1, 44]
  ];
  return defs.map((d) => ({
    type: d[0], reason: d[1], object: d[2], message: d[3], count: d[4],
    lastSeen: new Date(Date.now() - d[5] * 60000).toISOString(), namespace: 'apps', name: d[2].split('/')[1], healthy: d[0] !== 'Warning'
  }));
}

function demoLogs() {
  return [
    '2026-11-05T10:21:03.112Z  info  server  starting demo-app v1.8.2 (node 22.11.0)',
    '2026-11-05T10:21:03.214Z  info  config  loaded 14 keys from /etc/demo/config.yaml',
    '2026-11-05T10:21:03.512Z  info  db      connected to postgres://db:5432/app (pool=12)',
    '2026-11-05T10:21:03.733Z  info  cache   redis ready at redis-master:6379',
    '2026-11-05T10:21:04.002Z  info  http    listening on 0.0.0.0:8080',
    '2026-11-05T10:21:14.091Z  info  http    GET /healthz 200 2ms',
    '2026-11-05T10:21:29.770Z  info  http    GET /api/orders?limit=20 200 18ms',
    '2026-11-05T10:21:41.230Z  warn  queue   retry 1/3 for job 88213 (timeout)',
    '2026-11-05T10:21:46.008Z  info  queue   job 88213 completed in 4.7s',
    '2026-11-05T10:22:02.512Z  info  http    POST /api/orders 201 34ms'
  ].join('\n');
}

function demoYaml(kind, name) {
  if (kind === 'pods') {
    return `apiVersion: v1
kind: Pod
metadata:
  name: ${name}
  namespace: apps
  labels:
    app: demo-app
spec:
  containers:
    - name: main
      image: ghcr.io/example/app:1.8.2
      ports:
        - containerPort: 8080
      resources:
        requests:
          cpu: 100m
          memory: 128Mi
        limits:
          cpu: "1"
          memory: 512Mi
      readinessProbe:
        httpGet:
          path: /healthz
          port: 8080
        initialDelaySeconds: 5
`;
  }
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name || 'demo-app'}
  namespace: apps
  labels:
    app: ${name || 'demo-app'}
spec:
  replicas: 2
  selector:
    matchLabels:
      app: ${name || 'demo-app'}
  template:
    metadata:
      labels:
        app: ${name || 'demo-app'}
    spec:
      containers:
        - name: main
          image: ghcr.io/example/app:1.8.2
          ports:
            - containerPort: 8080
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
`;
}

function demoJobs() {
  const now = Date.now();
  const list = [
    {
      id: 'job_demo_export', type: 'image-export', title: '导出镜像 tar', status: 'success', meta: { hostId: 'demo-master' },
      steps: [
        { id: 1, title: '在节点上导出镜像 tar', status: 'success', detail: 'nginx-1.25.tar（72.4 MB）', startedAt: new Date(now - 90000).toISOString(), finishedAt: new Date(now - 60000).toISOString() },
        { id: 2, title: '下载 tar 到控制端', status: 'success', detail: 'tar 已保存到控制端，可在窗口内下载', startedAt: new Date(now - 60000).toISOString(), finishedAt: new Date(now - 30000).toISOString() },
        { id: 3, title: '清理节点临时文件', status: 'success', detail: '已删除 /tmp/nginx-1.25.tar', startedAt: new Date(now - 30000).toISOString(), finishedAt: new Date(now - 29000).toISOString() }
      ],
      logs: [
        { ts: new Date(now - 90000).toISOString(), level: 'info', text: '镜像：nginx:1.25' },
        { ts: new Date(now - 85000).toISOString(), level: 'info', text: '执行 k3s ctr -n k8s.io images export …' },
        { ts: new Date(now - 60000).toISOString(), level: 'info', text: '  下载进度 50%（36.2 MB / 72.4 MB）' },
        { ts: new Date(now - 30000).toISOString(), level: 'ok', text: '  下载进度 100%（72.4 MB / 72.4 MB）' }
      ],
      result: { file: 'C:/tmp/nginx-1.25.tar', name: 'nginx-1.25.tar', size: 75916902, downloadUrl: '/api/jobs/job_demo_export/download' },
      error: null,
      createdAt: new Date(now - 95000).toISOString(), startedAt: new Date(now - 95000).toISOString(), finishedAt: new Date(now - 29000).toISOString()
    },
    {
      id: 'job_demo_uninstall', type: 'uninstall', title: '批量卸载 Kubernetes', status: 'success', meta: { hostIds: ['demo-master', 'demo-agent-1'] },
      steps: [
        { id: 1, title: '卸载 生产工作节点 1', status: 'success', detail: '卸载完成', startedAt: new Date(now - 50000).toISOString(), finishedAt: new Date(now - 32000).toISOString() },
        { id: 2, title: '卸载 生产主节点', status: 'success', detail: '卸载完成', startedAt: new Date(now - 32000).toISOString(), finishedAt: new Date(now - 8000).toISOString() }
      ],
      logs: [
        { ts: new Date(now - 51000).toISOString(), level: 'info', text: '本次卸载 2 台服务器，按顺序逐个执行' },
        { ts: new Date(now - 50000).toISOString(), level: 'warn', text: '卸载模式：官方卸载 + 深度清理' },
        { ts: new Date(now - 50000).toISOString(), level: 'info', text: '[1/2] 开始卸载 生产工作节点 1' },
        { ts: new Date(now - 32000).toISOString(), level: 'ok', text: '[1/2] 生产工作节点 1 卸载完成' },
        { ts: new Date(now - 32000).toISOString(), level: 'info', text: '[2/2] 开始卸载 生产主节点' },
        { ts: new Date(now - 8000).toISOString(), level: 'ok', text: '[2/2] 生产主节点 卸载完成' }
      ],
      result: { hosts: [{ host: 'demo-agent-1', ok: true }, { host: 'demo-master', ok: true }] }, error: null,
      createdAt: new Date(now - 51000).toISOString(), startedAt: new Date(now - 51000).toISOString(), finishedAt: new Date(now - 8000).toISOString()
    },
    {
      id: 'job_demo_import', type: 'image-import', title: '导入镜像', status: 'success', meta: { hostId: 'demo-agent-1' },
      steps: [
        { id: 1, title: '上传镜像 tar 到节点', status: 'success', detail: '120.0 MB → /tmp/k3s-import-demo.tar', startedAt: new Date(now - 60000).toISOString(), finishedAt: new Date(now - 18000).toISOString() },
        { id: 2, title: '导入到 k3s 镜像库', status: 'success', detail: '镜像已写入节点镜像库', startedAt: new Date(now - 18000).toISOString(), finishedAt: new Date(now - 12000).toISOString() },
        { id: 3, title: '清理节点临时文件', status: 'success', detail: '已删除 /tmp/k3s-import-demo.tar', startedAt: new Date(now - 12000).toISOString(), finishedAt: new Date(now - 11000).toISOString() }
      ],
      logs: [
        { ts: new Date(now - 62000).toISOString(), level: 'info', text: '目标服务器：生产工作节点 1（10.0.0.12）' },
        { ts: new Date(now - 60000).toISOString(), level: 'info', text: '镜像包：my-app-v1.0.tar（120.0 MB）' },
        { ts: new Date(now - 40000).toISOString(), level: 'info', text: '  上传进度 50%（60.0 MB / 120.0 MB）' },
        { ts: new Date(now - 18000).toISOString(), level: 'info', text: '  上传进度 100%（120.0 MB / 120.0 MB）' },
        { ts: new Date(now - 17000).toISOString(), level: 'info', text: '执行 k3s ctr -n k8s.io images import …' },
        { ts: new Date(now - 12000).toISOString(), level: 'info', text: 'docker.io/library/my-app:v1.0\tsaved' },
        { ts: new Date(now - 11000).toISOString(), level: 'ok', text: '已删除节点临时文件 /tmp/k3s-import-demo.tar' }
      ],
      result: { importedAt: new Date(now - 12000).toISOString(), size: 125829120 }, error: null,
      createdAt: new Date(now - 62000).toISOString(), startedAt: new Date(now - 62000).toISOString(), finishedAt: new Date(now - 11000).toISOString()
    },
    {
      id: 'job_demo_1', type: 'deploy', title: '部署 k3s 单机集群', status: 'success', meta: { serverIds: ['demo-master'], agentIds: ['demo-agent-1', 'demo-agent-2'] },
      steps: [
        { id: 1, title: '预检 生产主节点', status: 'success', detail: '通过', startedAt: new Date(now - 300000).toISOString(), finishedAt: new Date(now - 290000).toISOString() },
        { id: 2, title: '下载并安装 k3s server', status: 'success', detail: '安装脚本执行完成', startedAt: new Date(now - 290000).toISOString(), finishedAt: new Date(now - 240000).toISOString() },
        { id: 3, title: '等待主节点就绪', status: 'success', detail: '1/1 节点就绪', startedAt: new Date(now - 240000).toISOString(), finishedAt: new Date(now - 200000).toISOString() }
      ],
      logs: [
        { ts: new Date(now - 300000).toISOString(), level: 'info', text: '部署引擎：k3s；主节点 生产主节点；工作节点 2 台' },
        { ts: new Date(now - 290000).toISOString(), level: 'info', text: '[PASS] SSH 连通性：已连接 10.0.0.11:22' },
        { ts: new Date(now - 280000).toISOString(), level: 'info', text: '正在下载 k3s 安装脚本…' },
        { ts: new Date(now - 260000).toISOString(), level: 'info', text: '[INFO]  Using stable channel for k3s' },
        { ts: new Date(now - 250000).toISOString(), level: 'ok', text: 'k3s server 安装完成，服务状态 active' },
        { ts: new Date(now - 210000).toISOString(), level: 'info', text: '节点已就绪：prod-master-1(Ready), prod-worker-1(Ready), prod-worker-2(Ready)' }
      ],
      result: { engine: 'k3s', nodes: demoNodes() }, error: null,
      createdAt: new Date(now - 310000).toISOString(), startedAt: new Date(now - 310000).toISOString(), finishedAt: new Date(now - 200000).toISOString()
    },
    {
      id: 'job_demo_2', type: 'install', title: '安装 k3s', status: 'running', meta: { hostId: 'demo-agent-2' },
      steps: [
        { id: 1, title: '预检 生产工作节点 2', status: 'success', detail: '通过', startedAt: new Date(now - 60000).toISOString(), finishedAt: new Date(now - 55000).toISOString() },
        { id: 2, title: '下载并安装 k3s agent', status: 'running', detail: '', startedAt: new Date(now - 55000).toISOString(), finishedAt: null }
      ],
      logs: [
        { ts: new Date(now - 60000).toISOString(), level: 'info', text: '安装目标：生产工作节点 2 (10.0.0.13)，加入 https://10.0.0.11:6443' },
        { ts: new Date(now - 50000).toISOString(), level: 'info', text: '[INFO]  Downloading k3s agent…' }
      ],
      result: null, error: null,
      createdAt: new Date(now - 60000).toISOString(), startedAt: new Date(now - 60000).toISOString(), finishedAt: null
    },
    {
      id: 'job_demo_3', type: 'uninstall', title: '卸载 k3s', status: 'failed', meta: { hostId: 'demo-agent-3' },
      steps: [{ id: 1, title: '执行 k3s 卸载', status: 'failed', detail: 'sudo: a password is required', startedAt: new Date(now - 86400000).toISOString(), finishedAt: new Date(now - 86390000).toISOString() }],
      logs: [{ ts: new Date(now - 86400000).toISOString(), level: 'error', text: '远程命令失败（退出码 1）' }, { ts: new Date(now - 86390000).toISOString(), level: 'error', text: 'sudo: a password is required' }],
      result: null, error: '远程命令失败（退出码 1）',
      createdAt: new Date(now - 86400000).toISOString(), startedAt: new Date(now - 86400000).toISOString(), finishedAt: new Date(now - 86390000).toISOString()
    }
  ];
  if (demoAllJobsDeleted) return [];
  return list.filter((job) => !demoDeletedJobIds.has(job.id));
}
