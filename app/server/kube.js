'use strict';

const { spawn } = require('child_process');
const { HttpError, expandHome, truncate, sleep, parseSections, sq } = require('./util');

const KUBE_CACHE_TTL_MS = 60000;
const kubeCache = new Map();
const kubePending = new Map();
let kubeEpoch = 0;

function clearKubeCache() {
  kubeCache.clear();
  kubePending.clear();
  kubeEpoch += 1;
}

function meta(item) {
  const m = (item && item.metadata) || {};
  return {
    name: m.name || '',
    namespace: m.namespace || '',
    createdAt: m.creationTimestamp || '',
    labels: m.labels || {},
    annotations: m.annotations || {}
  };
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isReadyCondition(conditions, type = 'Ready') {
  return (conditions || []).some((c) => c.type === type && c.status === 'True');
}

function formatMemory(quantity) {
  if (!quantity) return '-';
  const match = String(quantity).match(/^([\d.]+)([KMGTPE]i?)?$/i);
  if (!match) return String(quantity);
  let value = Number(match[1]);
  const unit = (match[2] || '').replace(/i$/i, '').toUpperCase();
  const powers = { '': 0, K: 1, M: 2, G: 3, T: 4, P: 5, E: 6 };
  const power = powers[unit] || 0;
  value *= Math.pow(1024, power);
  const gib = value / Math.pow(1024, 3);
  if (gib >= 1024) return `${(gib / 1024).toFixed(1)} TiB`;
  if (gib >= 10) return `${gib.toFixed(0)} GiB`;
  return `${gib.toFixed(1)} GiB`;
}

function podStatus(pod) {
  const m = pod.metadata || {};
  if (m.deletionTimestamp) return 'Terminating';
  const status = pod.status || {};
  if (status.reason) return status.reason;
  const containers = status.containerStatuses || [];
  const waiting = containers.find((c) => c.state && c.state.waiting);
  if (waiting) return waiting.state.waiting.reason || 'Waiting';
  const terminated = containers.find((c) => c.state && c.state.terminated);
  if (terminated && status.phase !== 'Succeeded') {
    return terminated.state.terminated.reason || 'Terminated';
  }
  if (status.phase === 'Running' && containers.some((c) => !c.ready)) return 'NotReady';
  return status.phase || 'Unknown';
}

function isPodHealthy(pod) {
  const m = pod.metadata || {};
  const status = pod.status || {};
  if (m.deletionTimestamp) return false;
  if (status.phase === 'Succeeded') return true;
  if (status.phase !== 'Running') return false;
  const containers = status.containerStatuses || [];
  if (!containers.length) return true;
  return containers.every((c) => c.ready);
}

function summarizePod(item) {
  const base = meta(item);
  const spec = item.spec || {};
  const status = item.status || {};
  const containers = status.containerStatuses || [];
  const readyCount = containers.filter((c) => c.ready).length;
  const total = (spec.containers || []).length || containers.length;
  return {
    ...base,
    ready: `${readyCount}/${total}`,
    readyNum: readyCount,
    totalNum: total,
    status: podStatus(item),
    healthy: isPodHealthy(item),
    restarts: containers.reduce((sum, c) => sum + num(c.restartCount), 0),
    node: spec.nodeName || '-',
    ip: status.podIP || '-',
    qos: status.qosClass || '-',
    containers: (spec.containers || []).map((c) => ({ name: c.name, image: c.image })),
    images: (spec.containers || []).map((c) => c.image).filter(Boolean),
    owner: (item.metadata && item.metadata.ownerReferences && item.metadata.ownerReferences[0] && item.metadata.ownerReferences[0].kind) || '-'
  };
}

function summarizeDeployment(item) {
  const base = meta(item);
  const spec = item.spec || {};
  const status = item.status || {};
  const desired = num(spec.replicas);
  const ready = num(status.readyReplicas);
  return {
    ...base,
    replicas: `${ready}/${desired}`,
    desired,
    readyNum: ready,
    updated: num(status.updatedReplicas),
    available: num(status.availableReplicas),
    unavailable: num(status.unavailableReplicas),
    healthy: desired === ready && desired > 0,
    strategy: (spec.strategy && spec.strategy.type) || '-',
    images: ((spec.template && spec.template.spec && spec.template.spec.containers) || []).map((c) => c.image)
  };
}

function summarizeStatefulSet(item) {
  const base = meta(item);
  const spec = item.spec || {};
  const status = item.status || {};
  const desired = num(spec.replicas);
  const ready = num(status.readyReplicas);
  return {
    ...base,
    replicas: `${ready}/${desired}`,
    desired,
    readyNum: ready,
    updated: num(status.updatedReplicas),
    current: num(status.currentReplicas),
    healthy: desired === ready,
    serviceName: spec.serviceName || '-',
    images: ((spec.template && spec.template.spec && spec.template.spec.containers) || []).map((c) => c.image)
  };
}

function summarizeDaemonSet(item) {
  const base = meta(item);
  const status = item.status || {};
  const desired = num(status.desiredNumberScheduled);
  const ready = num(status.numberReady);
  return {
    ...base,
    replicas: `${ready}/${desired}`,
    desired,
    readyNum: ready,
    available: num(status.numberAvailable),
    updated: num(status.updatedNumberScheduled),
    misscheduled: num(status.numberMisscheduled),
    healthy: desired === ready,
    images: ((item.spec && item.spec.template && item.spec.template.spec && item.spec.template.spec.containers) || []).map((c) => c.image)
  };
}

function summarizeReplicaSet(item) {
  const base = meta(item);
  const spec = item.spec || {};
  const status = item.status || {};
  return {
    ...base,
    replicas: `${num(status.readyReplicas)}/${num(spec.replicas)}`,
    desired: num(spec.replicas),
    readyNum: num(status.readyReplicas),
    healthy: num(status.readyReplicas) === num(spec.replicas)
  };
}

function summarizeJob(item) {
  const base = meta(item);
  const spec = item.spec || {};
  const status = item.status || {};
  const completions = num(spec.completions) || 1;
  const succeeded = num(status.succeeded);
  let state = 'Running';
  if (status.failed && !status.succeeded) state = 'Failed';
  else if (succeeded >= completions) state = 'Complete';
  if (status.conditions) {
    const failed = status.conditions.find((c) => c.type === 'Failed' && c.status === 'True');
    if (failed) state = 'Failed';
  }
  const start = status.startTime ? new Date(status.startTime).getTime() : 0;
  const end = status.completionTime ? new Date(status.completionTime).getTime() : Date.now();
  return {
    ...base,
    completions: `${succeeded}/${completions}`,
    succeeded,
    failed: num(status.failed),
    active: num(status.active),
    status: state,
    healthy: state === 'Complete' || (state === 'Running' && num(status.active) > 0),
    duration: start ? `${Math.max(1, Math.round((end - start) / 1000))}s` : '-'
  };
}

function summarizeCronJob(item) {
  const base = meta(item);
  const spec = item.spec || {};
  const status = item.status || {};
  const active = (status.active || []).length;
  return {
    ...base,
    schedule: spec.schedule || '-',
    suspend: !!spec.suspend,
    active,
    lastSchedule: status.lastScheduleTime || status.lastSuccessfulTime || '-',
    healthy: !spec.suspend,
    status: spec.suspend ? 'Suspended' : 'Active'
  };
}

function summarizeService(item) {
  const base = meta(item);
  const spec = item.spec || {};
  const status = item.status || {};
  const external = [];
  for (const ip of spec.externalIPs || []) external.push(ip);
  for (const entry of (status.loadBalancer && status.loadBalancer.ingress) || []) {
    external.push(entry.ip || entry.hostname);
  }
  const ports = (spec.ports || []).map((p) => {
    const target = p.targetPort !== undefined ? `→${p.targetPort}` : '';
    return `${p.port}${p.nodePort ? ':' + p.nodePort : ''}${target}/${p.protocol || 'TCP'}`;
  });
  return {
    ...base,
    type: spec.type || 'ClusterIP',
    clusterIP: spec.clusterIP || '-',
    externalIP: external.filter(Boolean).join(', ') || '-',
    ports: ports.join(', ') || '-',
    selector: Object.entries(spec.selector || {}).map(([k, v]) => `${k}=${v}`).join(',') || '-'
  };
}

function summarizeIngress(item) {
  const base = meta(item);
  const spec = item.spec || {};
  const hosts = [];
  for (const rule of spec.rules || []) if (rule.host) hosts.push(rule.host);
  for (const tls of spec.tls || []) for (const host of tls.hosts || []) if (!hosts.includes(host)) hosts.push(host);
  const ingressClass = spec.ingressClassName || (base.annotations && base.annotations['kubernetes.io/ingress.class']) || '-';
  return {
    ...base,
    class: ingressClass,
    hosts: hosts.join(', ') || '*',
    tls: (spec.tls || []).length > 0,
    rules: (spec.rules || []).length
  };
}

function summarizeConfigMap(item) {
  const base = meta(item);
  const dataKeys = Object.keys(item.data || {});
  const binaryKeys = Object.keys(item.binaryData || {});
  return {
    ...base,
    keys: dataKeys.length + binaryKeys.length,
    keyList: dataKeys.concat(binaryKeys).join(', ') || '-'
  };
}

function summarizeSecret(item) {
  const base = meta(item);
  const dataKeys = Object.keys(item.data || {});
  const stringKeys = Object.keys(item.stringData || {});
  return {
    ...base,
    type: item.type || 'Opaque',
    keys: dataKeys.length + stringKeys.length,
    keyList: dataKeys.concat(stringKeys).join(', ') || '-'
  };
}

function summarizePvc(item) {
  const base = meta(item);
  const spec = item.spec || {};
  const status = item.status || {};
  return {
    ...base,
    status: status.phase || 'Pending',
    capacity: (status.capacity && status.capacity.storage) || '-',
    storageClass: spec.storageClassName || '-',
    accessModes: (spec.accessModes || []).join(', ') || '-',
    volumeName: spec.volumeName || '-',
    healthy: status.phase === 'Bound'
  };
}

function summarizePv(item) {
  const base = meta(item);
  const spec = item.spec || {};
  const status = item.status || {};
  return {
    ...base,
    status: status.phase || 'Pending',
    capacity: (spec.capacity && spec.capacity.storage) || '-',
    storageClass: spec.storageClassName || '-',
    accessModes: (spec.accessModes || []).join(', ') || '-',
    reclaimPolicy: spec.persistentVolumeReclaimPolicy || '-',
    claim: spec.claimRef ? `${spec.claimRef.namespace}/${spec.claimRef.name}` : '-',
    healthy: status.phase === 'Bound' || status.phase === 'Available'
  };
}

function summarizeStorageClass(item) {
  const base = meta(item);
  return {
    ...base,
    provisioner: item.provisioner || '-',
    reclaimPolicy: item.reclaimPolicy || 'Delete',
    bindingMode: item.volumeBindingMode || 'Immediate',
    allowExpansion: !!item.allowVolumeExpansion,
    default: !!(base.annotations && (base.annotations['storageclass.kubernetes.io/is-default-class'] === 'true' || base.annotations['storageclass.beta.kubernetes.io/is-default-class'] === 'true'))
  };
}

function summarizeIngressClass(item) {
  const base = meta(item);
  const spec = item.spec || {};
  return {
    ...base,
    controller: spec.controller || '-',
    default: !!(base.annotations && base.annotations['ingressclass.kubernetes.io/is-default-class'] === 'true')
  };
}

function summarizeNamespace(item) {
  const base = meta(item);
  return {
    ...base,
    status: (item.status && item.status.phase) || 'Active',
    healthy: !item.status || item.status.phase === 'Active'
  };
}

function summarizeNode(item) {
  const base = meta(item);
  const status = item.status || {};
  const info = status.nodeInfo || {};
  const conditions = status.conditions || [];
  const ready = conditions.find((c) => c.type === 'Ready');
  const roles = Object.keys(base.labels || {})
    .filter((key) => key.startsWith('node-role.kubernetes.io/'))
    .map((key) => key.replace('node-role.kubernetes.io/', ''))
    .filter(Boolean);
  if (!roles.length) roles.push('worker');
  const addresses = status.addresses || [];
  const internal = addresses.find((a) => a.type === 'InternalIP');
  return {
    ...base,
    status: item.spec && item.spec.unschedulable ? 'SchedulingDisabled' : ready ? (ready.status === 'True' ? 'Ready' : 'NotReady') : 'Unknown',
    ready: ready ? ready.status === 'True' : false,
    schedulable: !(item.spec && item.spec.unschedulable),
    roles: roles.join(', '),
    roleList: roles,
    version: info.kubeletVersion || '-',
    internalIP: internal ? internal.address : '-',
    os: info.osImage || '-',
    kernel: info.kernelVersion || '-',
    runtime: info.containerRuntimeVersion || '-',
    arch: info.architecture || '-',
    cpu: (status.capacity && status.capacity.cpu) || '-',
    memory: formatMemory(status.capacity && status.capacity.memory),
    pods: (status.capacity && status.capacity.pods) || '-',
    healthy: ready ? ready.status === 'True' : false
  };
}

function summarizeEvent(item) {
  const base = meta(item);
  const involved = item.involvedObject || {};
  const last = item.lastTimestamp || item.eventTime || item.firstTimestamp || base.createdAt;
  return {
    ...base,
    type: item.type || 'Normal',
    reason: item.reason || '-',
    object: `${involved.kind || ''}/${involved.name || ''}`.replace(/^\//, ''),
    message: item.message || '',
    count: num(item.count),
    lastSeen: last,
    healthy: item.type !== 'Warning'
  };
}

function summarizeServiceAccount(item) {
  const base = meta(item);
  return {
    ...base,
    secrets: ((item.secrets || []).length),
    automount: item.automountServiceAccountToken !== false
  };
}

function summarizeNetworkPolicy(item) {
  const base = meta(item);
  const spec = item.spec || {};
  return {
    ...base,
    podSelector: Object.entries((spec.podSelector && spec.podSelector.matchLabels) || {}).map(([k, v]) => `${k}=${v}`).join(',') || '全部 Pod',
    policyTypes: (spec.policyTypes || []).join(', ') || '-',
    ingressRules: (spec.ingress || []).length,
    egressRules: (spec.egress || []).length
  };
}

function summarizeHpa(item) {
  const base = meta(item);
  const spec = item.spec || {};
  const status = item.status || {};
  const target = spec.scaleTargetRef || {};
  const metrics = (status.currentMetrics || []).map((m) => {
    if (m.resource) {
      const current = (m.resource.current && (m.resource.current.averageUtilization || m.resource.current.averageValue)) || '-';
      return `${m.resource.name}:${current}`;
    }
    return m.type || 'metric';
  });
  return {
    ...base,
    target: `${target.kind || ''}/${target.name || ''}`.replace(/^\//, ''),
    min: num(spec.minReplicas),
    max: num(spec.maxReplicas),
    current: num(status.currentReplicas),
    desired: num(status.desiredReplicas),
    metrics: metrics.join(', ') || '-'
  };
}

const RESOURCES = {
  pods: {
    label: 'Pod', namespaced: true, summarize: summarizePod,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'namespace', label: '命名空间' },
      { key: 'ready', label: '就绪' },
      { key: 'status', label: '状态', type: 'status' },
      { key: 'restarts', label: '重启', align: 'right' },
      { key: 'node', label: '节点' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  deployments: {
    label: 'Deployment', namespaced: true, summarize: summarizeDeployment,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'namespace', label: '命名空间' },
      { key: 'replicas', label: '就绪/期望' },
      { key: 'available', label: '可用', align: 'right' },
      { key: 'strategy', label: '策略' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  statefulsets: {
    label: 'StatefulSet', namespaced: true, summarize: summarizeStatefulSet,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'namespace', label: '命名空间' },
      { key: 'replicas', label: '就绪/期望' },
      { key: 'current', label: '当前', align: 'right' },
      { key: 'serviceName', label: '服务' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  daemonsets: {
    label: 'DaemonSet', namespaced: true, summarize: summarizeDaemonSet,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'namespace', label: '命名空间' },
      { key: 'replicas', label: '就绪/期望' },
      { key: 'misscheduled', label: '错误调度', align: 'right' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  replicasets: {
    label: 'ReplicaSet', namespaced: true, summarize: summarizeReplicaSet,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'namespace', label: '命名空间' },
      { key: 'replicas', label: '就绪/期望' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  jobs: {
    label: 'Job', namespaced: true, summarize: summarizeJob,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'namespace', label: '命名空间' },
      { key: 'status', label: '状态', type: 'status' },
      { key: 'completions', label: '完成' },
      { key: 'duration', label: '耗时' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  cronjobs: {
    label: 'CronJob', namespaced: true, summarize: summarizeCronJob,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'namespace', label: '命名空间' },
      { key: 'schedule', label: '调度' },
      { key: 'status', label: '状态', type: 'status' },
      { key: 'active', label: '运行中', align: 'right' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  services: {
    label: 'Service', namespaced: true, summarize: summarizeService,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'namespace', label: '命名空间' },
      { key: 'type', label: '类型' },
      { key: 'clusterIP', label: 'ClusterIP' },
      { key: 'externalIP', label: '外部 IP' },
      { key: 'ports', label: '端口' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  ingresses: {
    label: 'Ingress', namespaced: true, summarize: summarizeIngress,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'namespace', label: '命名空间' },
      { key: 'class', label: 'Class' },
      { key: 'hosts', label: '域名' },
      { key: 'tls', label: 'TLS', type: 'bool' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  configmaps: {
    label: 'ConfigMap', namespaced: true, summarize: summarizeConfigMap,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'namespace', label: '命名空间' },
      { key: 'keys', label: '键数量', align: 'right' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  secrets: {
    label: 'Secret', namespaced: true, summarize: summarizeSecret,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'namespace', label: '命名空间' },
      { key: 'type', label: '类型' },
      { key: 'keys', label: '键数量', align: 'right' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  persistentvolumeclaims: {
    label: 'PVC', namespaced: true, summarize: summarizePvc,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'namespace', label: '命名空间' },
      { key: 'status', label: '状态', type: 'status' },
      { key: 'capacity', label: '容量' },
      { key: 'storageClass', label: 'StorageClass' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  persistentvolumes: {
    label: 'PV', namespaced: false, summarize: summarizePv,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'status', label: '状态', type: 'status' },
      { key: 'capacity', label: '容量' },
      { key: 'storageClass', label: 'StorageClass' },
      { key: 'claim', label: '绑定' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  storageclasses: {
    label: 'StorageClass', namespaced: false, summarize: summarizeStorageClass,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'provisioner', label: 'Provisioner' },
      { key: 'reclaimPolicy', label: '回收策略' },
      { key: 'bindingMode', label: '绑定模式' },
      { key: 'default', label: '默认', type: 'bool' }
    ]
  },
  namespaces: {
    label: 'Namespace', namespaced: false, summarize: summarizeNamespace,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'status', label: '状态', type: 'status' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  ingressclasses: {
    label: 'IngressClass', namespaced: false, summarize: summarizeIngressClass,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'controller', label: '控制器' },
      { key: 'default', label: '默认', type: 'bool' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  nodes: {
    label: 'Node', namespaced: false, summarize: summarizeNode,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'status', label: '状态', type: 'status' },
      { key: 'roles', label: '角色' },
      { key: 'version', label: '版本' },
      { key: 'internalIP', label: 'IP' },
      { key: 'cpu', label: 'CPU', align: 'right' },
      { key: 'memory', label: '内存', align: 'right' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  events: {
    label: 'Event', namespaced: true, summarize: summarizeEvent,
    columns: [
      { key: 'type', label: '类型', type: 'status' },
      { key: 'reason', label: '原因' },
      { key: 'object', label: '对象' },
      { key: 'message', label: '消息' },
      { key: 'count', label: '次数', align: 'right' },
      { key: 'lastSeen', label: '最后发生', type: 'age' }
    ]
  },
  serviceaccounts: {
    label: 'ServiceAccount', namespaced: true, summarize: summarizeServiceAccount,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'namespace', label: '命名空间' },
      { key: 'secrets', label: 'Secrets', align: 'right' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  networkpolicies: {
    label: 'NetworkPolicy', namespaced: true, summarize: summarizeNetworkPolicy,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'namespace', label: '命名空间' },
      { key: 'podSelector', label: 'Pod 选择器' },
      { key: 'policyTypes', label: '策略类型' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  },
  horizontalpodautoscalers: {
    label: 'HPA', namespaced: true, summarize: summarizeHpa,
    columns: [
      { key: 'name', label: '名称', primary: true },
      { key: 'namespace', label: '命名空间' },
      { key: 'target', label: '目标' },
      { key: 'current', label: '当前/期望', align: 'right' },
      { key: 'min', label: '最小', align: 'right' },
      { key: 'max', label: '最大', align: 'right' },
      { key: 'createdAt', label: '存活', type: 'age' }
    ]
  }
};

async function resolveKube(host, transport, config, servers, stack = []) {
  // 借控制节点读集群时会再次进入本函数，这里挡住互相指向的环，避免无限递归 / 互相等待
  if (stack.includes(host.id)) {
    throw new HttpError(400, `服务器 ${host.name || host.id} 的集群指向形成了环（${[...stack, host.id].join(' → ')}），请检查各节点 k3s 的 K3S_URL 配置`);
  }
  const cached = kubeCache.get(host.id);
  if (cached && Date.now() - cached.at < KUBE_CACHE_TTL_MS) return cached.value;

  // 并发请求共享同一次发现过程，避免同时建立多条 SSH 连接。
  const pending = kubePending.get(host.id);
  if (pending) return pending;

  const epoch = kubeEpoch;
  const task = (async () => {
    const value = await resolveKubeUncached(host, transport, config, servers, [...stack, host.id]);
    if (epoch === kubeEpoch) kubeCache.set(host.id, { at: Date.now(), value });
    return value;
  })();
  kubePending.set(host.id, task);
  try {
    return await task;
  } finally {
    if (kubePending.get(host.id) === task) kubePending.delete(host.id);
  }
}

// 从 agent 节点上找出它连接的集群地址（K3S_URL），再在服务器列表里找到对应控制节点
function agentClusterHost(url, servers, selfId) {
  let hostname = '';
  try {
    hostname = new URL(String(url)).hostname;
  } catch (_) {
    hostname = String(url || '').replace(/^https?:\/\//i, '').split('/')[0].split(':')[0];
  }
  if (!hostname) return null;
  const list = Array.isArray(servers) ? servers : [];
  return list.find((item) => item.id !== selfId && (item.host === hostname || item.name === hostname || item.ip === hostname)) || null;
}

async function resolveKubeUncached(host, transport, config, servers, stack = []) {
  const transportKind = host.transport || 'ssh';

  if (transportKind === 'kubeconfig') {
    const argv = [host.kubectlPath || 'kubectl'];
    if (host.context) argv.push('--context', host.context);
    const env = {};
    if (host.kubeconfig) env.KUBECONFIG = expandHome(host.kubeconfig);
    return { argv, env, mode: 'kubeconfig' };
  }

  const script = [
    'echo "@@UID@@"; id -u 2>/dev/null || echo 1000',
    'echo "@@SUDO@@"; command -v sudo 2>/dev/null || true',
    'echo "@@KUBECTL@@"; command -v kubectl 2>/dev/null || true',
    'echo "@@K3S@@"; command -v k3s 2>/dev/null || true',
    'echo "@@K3SCFG@@"; [ -f /etc/rancher/k3s/k3s.yaml ] && echo /etc/rancher/k3s/k3s.yaml || true',
    'echo "@@ADMINCFG@@"; [ -f /etc/kubernetes/admin.conf ] && echo /etc/kubernetes/admin.conf || true',
    'echo "@@HOMECFG@@"; [ -f "$HOME/.kube/config" ] && echo "$HOME/.kube/config" || true',
    // agent 节点没有 kubeconfig，但知道自己连的是哪个控制节点（systemd 里的 K3S_URL）
    'echo "@@AGENTURL@@"',
    'for f in /etc/systemd/system/k3s-agent.service.env /etc/systemd/system/k3s-agent.service.d/*.conf; do [ -f "$f" ] && grep -ho "K3S_URL=[^ ]*" "$f"; done 2>/dev/null | head -n1 || true',
    'systemctl cat k3s-agent 2>/dev/null | grep -o "server=https://[^ ]*" | head -n1 || true',
    'systemctl show -p ExecStart k3s-agent 2>/dev/null | grep -o "\\-\\-server=[^ ]*" | head -n1 || true'
  ].join('\n');
  const result = await transport.execScript(host, script, { timeout: 20000 });
  const sections = parseSections(result.stdout);
  const uid = Number((sections.UID || '1000').trim()) || 1000;
  const kubectl = (sections.KUBECTL || '').trim() || host.kubectlPath || '';
  const k3s = (sections.K3S || '').trim() || '';
  const k3sCfg = (sections.K3SCFG || '').trim();
  const adminCfg = (sections.ADMINCFG || '').trim();
  const homeCfg = (sections.HOMECFG || '').trim();

  const kubeconfig = host.kubeconfig || k3sCfg || adminCfg || homeCfg || '';
  let argv;
  if (kubectl) {
    argv = [kubectl];
  } else if (k3s) {
    argv = [k3s, 'kubectl'];
  } else {
    throw new HttpError(
      400,
      `主机 ${host.name || host.id} 上未找到 kubectl 或 k3s，无法访问 Kubernetes。已装 k8s 的节点请安装 kubectl，或在 config.json 中指定 kubectlPath。`
    );
  }

  const useSudo = host.useSudo === true && uid !== 0;
  if (useSudo) {
    const sudo = (sections.SUDO || '').trim() || 'sudo';
    argv = [sudo, '-n', ...argv];
  }
  const env = {};
  if (kubeconfig) env.KUBECONFIG = kubeconfig;

  // agent 节点（有 k3s 但没有 admin kubeconfig）：借用它连接的控制节点来读集群
  if (!kubeconfig && k3s) {
    const agentUrl = (sections.AGENTURL || '').replace(/^["']|["']$/g, '').replace(/^K3S_URL=/, '').replace(/^["']|["']$/g, '').trim();
    if (agentUrl) {
      const server = agentClusterHost(agentUrl, servers, host.id);
      if (!server) {
        throw new HttpError(
          400,
          `主机 ${host.name || host.id} 是 k3s agent（控制面不在本机），它连接的集群地址是 ${agentUrl}，但服务器列表里没有这台控制节点。请先把该控制节点加入服务器列表，再从这里查看工作负载。`
        );
      }
      const serverPrefix = await resolveKube(server, transport, config, servers, stack);
      return {
        ...serverPrefix,
        delegate: server,
        via: { id: server.id, name: server.name || server.host || server.id, host: server.host || '', url: agentUrl }
      };
    }
    throw new HttpError(
      400,
      `主机 ${host.name || host.id} 是 k3s agent，本机没有 kubeconfig，也读不到它连接的控制节点地址。请在控制节点上查看集群，或把 /etc/systemd/system/k3s-agent.service.env 里的 K3S_URL 对应机器加入服务器列表。`
    );
  }

  const value = {
    argv,
    env,
    mode: 'ssh',
    info: { uid, kubectl, k3s, kubeconfig, sudo: useSudo }
  };
  return value;
}

function friendlyKubectlError(stderr, stdout) {
  const text = String(stderr || '').trim() || String(stdout || '').trim();
  if (!text) return 'kubectl 执行失败（无输出）';
  if (/was refused|connection refused/i.test(text)) return `无法连接 Kubernetes API：${text.split('\n')[0]}`;
  if (/x509|certificate/i.test(text)) return `Kubernetes API 证书校验失败：${text.split('\n')[0]}`;
  if (/Unauthorized|forbidden/i.test(text)) return `Kubernetes 认证/授权失败：${text.split('\n')[0]}`;
  if (/the server doesn't have a resource type/i.test(text)) return text.split('\n')[0];
  if (/no such host/i.test(text)) return `无法解析 Kubernetes API 地址：${text.split('\n')[0]}`;
  return text.slice(0, 2000);
}

async function kubectlRaw(host, args, opts = {}) {
  const cfg = opts.config;
  const transport = opts.transport;
  const prefix = await resolveKube(host, transport, cfg, opts.servers);
  const target = prefix.delegate || host;
  const requestTimeout = Number((cfg && cfg.app && cfg.app.kubectlTimeoutSeconds) || 25);
  const argv = [...prefix.argv, `--request-timeout=${requestTimeout}s`, ...args];
  const started = Date.now();
  const result = await transport.execCommand(
    target,
    { argv, env: prefix.env, input: opts.input === undefined ? null : opts.input },
    { timeout: opts.timeout, maxBytes: opts.maxBytes }
  );
  return { ...result, ms: Date.now() - started, prefix, via: prefix.via || null };
}

// 前端用：这台机器是怎么访问 Kubernetes 的（本机直连 / 借用控制节点）
async function kubeAccess(host, opts = {}) {
  const prefix = await resolveKube(host, opts.transport, opts.config, opts.servers);
  const info = prefix.info || {};
  return {
    mode: prefix.mode,
    kubeconfig: info.kubeconfig || '',
    kubectl: info.kubectl || '',
    k3s: info.k3s || '',
    sudo: info.sudo === true,
    via: prefix.via || null
  };
}

// 打开一个容器内 shell 会话。SSH 模式申请远端 PTY（真正的交互式 shell），
// local / kubeconfig 模式退化为带 stdin 的 kubectl exec（仍保持同一 shell 进程）。
async function openPodShell(host, namespace, pod, container, opts = {}) {
  const ns = String(namespace || '').trim();
  const name = String(pod || '').trim();
  const cname = String(container || '').trim();
  if (!ns || !name) throw new HttpError(400, '缺少 namespace 或 Pod 名称');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(name)) throw new HttpError(400, 'Pod 名称不合法');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(ns)) throw new HttpError(400, '命名空间不合法');
  if (cname && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/.test(cname)) throw new HttpError(400, '容器名称不合法');

  const transport = opts.transport;
  const prefix = await resolveKube(host, transport, opts.config, opts.servers);
  const shellHost = prefix.delegate || host;
  const transportKind = host.transport || 'ssh';
  const argv = ['exec', '-i', '-n', ns, name];
  if (cname) argv.push('-c', cname);
  argv.push('--', 'sh');
  if (transportKind === 'ssh') argv.splice(1, 0, '-t');

  if (transportKind === 'ssh') {
    const envParts = Object.entries(prefix.env || {}).map(([key, value]) => `${key}=${sq(value)}`);
    const command = [...envParts, ...[...prefix.argv, ...argv].map(sq)].join(' ');
    const stream = await transport.openSshExec(shellHost, command, { pty: true });
    let closed = false;
    return {
      tty: true,
      write: (data) => {
        if (closed) return false;
        try { stream.write(data); return true; } catch (_) { return false; }
      },
      close: () => {
        if (closed) return;
        closed = true;
        try { stream.end(); } catch (_) { /* ignore */ }
      },
      resize: (rows, cols) => {
        if (closed) return false;
        try { stream.setWindow(rows, cols, 0, 0); return true; } catch (_) { return false; }
      },
      onData: (fn) => {
        stream.on('data', fn);
        if (stream.stderr) stream.stderr.on('data', fn);
      },
      onClose: (fn) => stream.on('close', (code) => fn(code === undefined ? 0 : code)),
      onError: (fn) => stream.on('error', fn)
    };
  }

  const env = { ...process.env, ...(prefix.env || {}) };
  const child = spawn(prefix.argv[0], [...prefix.argv.slice(1), ...argv], {
    env,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let closed = false;
  return {
    tty: false,
    write: (data) => {
      if (closed || !child.stdin || child.stdin.destroyed) return false;
      try { child.stdin.write(data); return true; } catch (_) { return false; }
    },
    close: () => {
      if (closed) return;
      closed = true;
      try { child.stdin.end(); } catch (_) { /* ignore */ }
      try { child.kill('SIGTERM'); } catch (_) { /* ignore */ }
    },
    onData: (fn) => {
      child.stdout.on('data', fn);
      child.stderr.on('data', fn);
    },
    onClose: (fn) => child.on('close', (code) => fn(code === undefined ? 0 : code)),
    onError: (fn) => child.on('error', fn)
  };
}

async function kubectlJson(host, args, opts = {}) {
  const result = await kubectlRaw(host, args, opts);
  if (result.code !== 0) {
    throw new HttpError(502, friendlyKubectlError(result.stderr, result.stdout), result.stderr.slice(-2000));
  }
  const text = result.stdout.trim();
  if (!text) return { items: [] };
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new HttpError(502, 'kubectl 返回内容不是合法 JSON', truncate(result.stdout, 1500));
  }
}

function columnsFor(kind) {
  const def = RESOURCES[kind];
  if (!def) return [];
  return def.columns;
}

function normalizeKind(kind) {
  if (!kind) return null;
  const key = String(kind).toLowerCase();
  return RESOURCES[key] ? key : null;
}

async function listResources(host, kind, namespace, opts = {}) {
  const canonical = normalizeKind(kind);
  if (!canonical) throw new HttpError(400, `不支持的资源类型：${kind}`);
  const def = RESOURCES[canonical];
  const args = ['get', canonical];
  if (def.namespaced) {
    if (namespace) args.push('-n', namespace);
    else args.push('-A');
  }
  args.push('-o', 'json');
  const json = await kubectlJson(host, args, opts);
  let items = (json.items || []).map((item) => def.summarize(item));
  if (canonical === 'events') {
    items.sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));
    items = items.slice(0, 300);
  } else {
    items.sort((a, b) => {
      const ns = String(a.namespace || '').localeCompare(String(b.namespace || ''));
      if (ns !== 0) return ns;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }
  return {
    kind: canonical,
    label: def.label,
    namespaced: def.namespaced,
    columns: def.columns,
    items,
    fetchedAt: new Date().toISOString()
  };
}

async function getResourceYaml(host, kind, namespace, name, opts = {}) {
  const canonical = normalizeKind(kind);
  if (!canonical) throw new HttpError(400, `不支持的资源类型：${kind}`);
  const def = RESOURCES[canonical];
  if (!name) throw new HttpError(400, '缺少资源名称');
  const args = ['get', canonical, name];
  if (def.namespaced && namespace) args.push('-n', namespace);
  args.push('-o', 'yaml');
  const result = await kubectlRaw(host, args, opts);
  if (result.code !== 0) throw new HttpError(502, friendlyKubectlError(result.stderr, result.stdout));
  return result.stdout;
}

async function clusterOverview(host, opts = {}) {
  const [versionJson, nodesJson, podsJson, deployJson, servicesJson, namespacesJson] = await Promise.all([
    kubectlJson(host, ['version', '-o', 'json'], opts).catch(() => ({})),
    kubectlJson(host, ['get', 'nodes', '-o', 'json'], opts),
    kubectlJson(host, ['get', 'pods', '-A', '-o', 'json'], opts),
    kubectlJson(host, ['get', 'deployments', '-A', '-o', 'json'], opts),
    kubectlJson(host, ['get', 'services', '-A', '-o', 'json'], opts),
    kubectlJson(host, ['get', 'namespaces', '-o', 'json'], opts)
  ]);

  const nodes = (nodesJson.items || []).map(summarizeNode);
  const pods = podsJson.items || [];
  const podSummaries = pods.map(summarizePod);
  const deployments = deployJson.items || [];
  const services = servicesJson.items || [];
  const namespaces = namespacesJson.items || [];

  const podStats = {
    total: podSummaries.length,
    running: podSummaries.filter((p) => p.status === 'Running').length,
    pending: podSummaries.filter((p) => p.status === 'Pending').length,
    failed: podSummaries.filter((p) => p.status === 'Failed' || p.status === 'CrashLoopBackOff' || p.status === 'Error').length,
    succeeded: podSummaries.filter((p) => p.status === 'Succeeded').length,
    unhealthy: podSummaries.filter((p) => !p.healthy).length,
    restarts: podSummaries.reduce((sum, p) => sum + p.restarts, 0)
  };
  const deploymentStats = {
    total: deployments.length,
    ready: deployments.filter((d) => {
      const spec = d.spec || {};
      const status = d.status || {};
      return num(spec.replicas) === num(status.readyReplicas);
    }).length
  };

  return {
    serverVersion: (versionJson.serverVersion && versionJson.serverVersion.gitVersion) || '-',
    clientVersion: (versionJson.clientVersion && versionJson.clientVersion.gitVersion) || '-',
    nodes,
    nodeStats: {
      total: nodes.length,
      ready: nodes.filter((n) => n.ready).length,
      controlPlane: nodes.filter((n) => n.roleList.some((r) => r.includes('master') || r.includes('control-plane'))).length
    },
    pods: podSummaries.filter((p) => !p.healthy).slice(0, 12),
    podStats,
    deploymentStats,
    serviceCount: services.length,
    namespaceCount: namespaces.length,
    warningEventCount: null,
    fetchedAt: new Date().toISOString()
  };
}

async function applyYaml(host, yaml, opts = {}) {
  if (!yaml || !String(yaml).trim()) throw new HttpError(400, 'YAML 内容为空');
  const args = ['apply', '-f', '-'];
  if (opts.namespace) args.push('-n', opts.namespace);
  if (opts.dryRun) args.push(`--dry-run=${opts.dryRun === 'client' ? 'client' : 'server'}`);
  const result = await kubectlRaw(host, args, { ...opts, input: String(yaml) });
  if (result.code !== 0) {
    throw new HttpError(502, '应用 YAML 失败', friendlyKubectlError(result.stderr, result.stdout));
  }
  return { output: (result.stdout + result.stderr).trim() };
}

async function deleteResource(host, kind, namespace, name, opts = {}) {
  const def = RESOURCES[normalizeKind(kind)];
  if (!def) throw new HttpError(400, `不支持的资源类型：${kind}`);
  const args = ['delete', kind, name];
  if (def.namespaced && namespace) args.push('-n', namespace);
  args.push('--ignore-not-found=true', '--wait=false');
  const result = await kubectlRaw(host, args, opts);
  if (result.code !== 0) throw new HttpError(502, '删除失败', friendlyKubectlError(result.stderr, result.stdout));
  return { output: (result.stdout + result.stderr).trim() };
}

async function scaleResource(host, kind, namespace, name, replicas, opts = {}) {
  if (!['deployments', 'statefulsets', 'replicasets'].includes(kind)) {
    throw new HttpError(400, '仅支持对 Deployment / StatefulSet / ReplicaSet 扩缩容');
  }
  const count = Number(replicas);
  if (!Number.isInteger(count) || count < 0 || count > 10000) throw new HttpError(400, '副本数必须是 0-10000 的整数');
  const args = ['scale', `${kind}/${name}`, `--replicas=${count}`];
  if (namespace) args.push('-n', namespace);
  const result = await kubectlRaw(host, args, opts);
  if (result.code !== 0) throw new HttpError(502, '扩缩容失败', friendlyKubectlError(result.stderr, result.stdout));
  return { output: (result.stdout + result.stderr).trim() };
}

async function restartResource(host, kind, namespace, name, opts = {}) {
  if (!['deployments', 'statefulsets', 'daemonsets'].includes(kind)) {
    throw new HttpError(400, '仅支持重启 Deployment / StatefulSet / DaemonSet');
  }
  const args = ['rollout', 'restart', `${kind}/${name}`];
  if (namespace) args.push('-n', namespace);
  const result = await kubectlRaw(host, args, opts);
  if (result.code !== 0) throw new HttpError(502, '重启失败', friendlyKubectlError(result.stderr, result.stdout));
  return { output: (result.stdout + result.stderr).trim() };
}

async function nodeAction(host, action, nodeName, opts = {}) {
  if (!['cordon', 'uncordon', 'drain'].includes(action)) throw new HttpError(400, '不支持的节点操作');
  if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i.test(nodeName)) throw new HttpError(400, '节点名称不合法');
  const args = [action, nodeName];
  if (action === 'drain') args.push('--ignore-daemonsets', '--delete-emptydir-data', '--force', '--timeout=180s');
  const result = await kubectlRaw(host, args, { ...opts, timeout: Math.max(200000, opts.timeout || 0) });
  if (result.code !== 0) throw new HttpError(502, `${action} 失败`, friendlyKubectlError(result.stderr, result.stdout));
  return { output: (result.stdout + result.stderr).trim() };
}

async function podLogs(host, namespace, pod, opts = {}) {
  if (!/^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/i.test(pod)) throw new HttpError(400, 'Pod 名称不合法');
  const tail = Math.min(5000, Math.max(1, Number(opts.tail) || 500));
  const args = ['logs', pod];
  if (namespace) args.push('-n', namespace);
  args.push('--tail', String(tail));
  if (opts.container) args.push('-c', opts.container);
  if (opts.previous) args.push('--previous');
  if (opts.timestamps) args.push('--timestamps');
  const result = await kubectlRaw(host, args, { ...opts, timeout: 40000 });
  if (result.code !== 0) {
    const message = friendlyKubectlError(result.stderr, result.stdout);
    if (/previous terminated container/i.test(message)) {
      throw new HttpError(400, '该容器没有上一次运行的日志');
    }
    throw new HttpError(502, '读取日志失败', message);
  }
  return result.stdout;
}

async function describeResource(host, kind, namespace, name, opts = {}) {
  const def = RESOURCES[normalizeKind(kind)];
  if (!def) throw new HttpError(400, `不支持的资源类型：${kind}`);
  const args = ['describe', kind, name];
  if (def.namespaced && namespace) args.push('-n', namespace);
  const result = await kubectlRaw(host, args, opts);
  if (result.code !== 0) throw new HttpError(502, '获取详情失败', friendlyKubectlError(result.stderr, result.stdout));
  return result.stdout;
}

async function eventsFor(host, namespace, name, opts = {}) {
  const args = ['get', 'events'];
  if (namespace) args.push('-n', namespace);
  else args.push('-A');
  args.push('-o', 'json');
  const json = await kubectlJson(host, args, opts);
  let items = (json.items || []).map(summarizeEvent);
  if (name) items = items.filter((e) => e.object.endsWith('/' + name));
  items.sort((a, b) => new Date(b.lastSeen || 0) - new Date(a.lastSeen || 0));
  return { items: items.slice(0, 200), columns: RESOURCES.events.columns };
}

function parseTopText(stdout, namespaced) {
  return String(stdout || '')
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.trim().split(/\s+/))
    .filter((cols) => cols.length >= 5)
    .map((cols) => {
      const offset = namespaced ? 1 : 0;
      return {
        namespace: namespaced ? cols[0] : '',
        name: cols[offset] || '',
        cpu: cols[offset + 1] || '-',
        cpuPercent: /%$/.test(cols[offset + 2] || '') ? cols[offset + 2] : '',
        memory: cols[offset + 3] || '-',
        memoryPercent: /%$/.test(cols[offset + 4] || '') ? cols[offset + 4] : ''
      };
    });
}

async function topMetrics(host, opts = {}) {
  try {
    const [nodes, pods] = await Promise.all([
      kubectlRaw(host, ['top', 'nodes', '--no-headers'], opts),
      kubectlRaw(host, ['top', 'pods', '-A', '--no-headers'], opts)
    ]);
    if (nodes.code !== 0) {
      return { available: false, error: friendlyKubectlError(nodes.stderr, nodes.stdout), nodes: [], pods: [] };
    }
    return {
      available: true,
      nodes: parseTopText(nodes.stdout, false),
      pods: pods.code === 0 ? parseTopText(pods.stdout, true) : []
    };
  } catch (err) {
    return { available: false, error: err.message, nodes: [], pods: [] };
  }
}

async function waitForNodes(host, expectedNames, opts = {}) {
  const timeout = opts.timeout || 240000;
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeout) {
    if (opts.shouldAbort && opts.shouldAbort()) throw new HttpError(499, '操作已取消');
    try {
      const json = await kubectlJson(host, ['get', 'nodes', '-o', 'json'], { ...opts, timeout: 30000 });
      const nodes = (json.items || []).map(summarizeNode);
      last = nodes;
      const byName = new Map(nodes.map((n) => [n.name, n]));
      const expected = expectedNames && expectedNames.length
        ? expectedNames.filter(Boolean)
        : nodes.map((n) => n.name);
      const allReady = expected.length > 0 && expected.every((name) => {
        const node = byName.get(name);
        return node && node.ready;
      });
      if (allReady) return nodes;
    } catch (_) { /* 轮询期间忽略暂时性错误 */ }
    await sleep(opts.interval || 4000);
  }
  throw new HttpError(504, `等待节点就绪超时（${Math.round(timeout / 1000)}s）`, last ? JSON.stringify(last.map((n) => ({ name: n.name, status: n.status }))) : null);
}

async function namespaceList(host, opts = {}) {
  const json = await kubectlJson(host, ['get', 'namespaces', '-o', 'json'], opts);
  return (json.items || []).map((item) => ({
    name: item.metadata.name,
    status: (item.status && item.status.phase) || 'Active',
    createdAt: item.metadata.creationTimestamp
  })).sort((a, b) => a.name.localeCompare(b.name));
}

async function nodeList(host, opts = {}) {
  const json = await kubectlJson(host, ['get', 'nodes', '-o', 'json'], opts);
  return (json.items || []).map(summarizeNode);
}

module.exports = {
  RESOURCES,
  clearKubeCache,
  resolveKube,
  kubeAccess,
  kubectlRaw,
  kubectlJson,
  openPodShell,
  listResources,
  getResourceYaml,
  clusterOverview,
  applyYaml,
  deleteResource,
  scaleResource,
  restartResource,
  nodeAction,
  podLogs,
  describeResource,
  eventsFor,
  topMetrics,
  waitForNodes,
  namespaceList,
  nodeList,
  columnsFor,
  normalizeKind,
  summarizers: { summarizePod, summarizeNode, summarizeEvent }
};
