'use strict';

/* ============================================================
 * 路由与事件
 * ============================================================ */
const RENDERERS = {
  dashboard: renderDashboard,
  hosts: renderHosts,
  workloads: renderWorkloads,
  deploy: renderDeploy,
  jobs: renderJobs,
  settings: renderSettings
};

async function handleAction(el, action) {
  const hostId = el.dataset.host;
  const host = hostId ? findHost(hostId) : null;
  switch (action) {
    case 'host-add':
      openHostForm();
      break;
    case 'group-add':
      await addHostGroup();
      break;
    case 'group-rename':
      await renameHostGroup(el.dataset.group || '');
      break;
    case 'group-delete':
      await deleteHostGroup(el.dataset.group || '');
      break;
    case 'group-toggle':
      toggleHostGroup(el.dataset.group || '');
      break;
    case 'overview-detail':
      openOverviewDetail(el.dataset.kind || 'servers');
      break;
    case 'overview-host':
      if (!host) return;
      closeModal();
      setActiveHost(host.id);
      navigate('hosts');
      break;
    case 'host-select':
      if (!host) return;
      setActiveHost(host.id);
      S.cluster = null;
      S.workloadData = null;
      renderView();
      break;
    case 'host-picker-open':
      openHostPicker();
      break;
    case 'host-picker-single':
      if (S.activeHostId) setActiveHost(S.activeHostId);
      S.cluster = null;
      S.workloadData = null;
      renderView();
      break;
    case 'host-menu':
      if (host) openHostActionMenu(el, host);
      break;
    case 'host-ssh':
      if (host) openHostShell(host);
      break;
    case 'host-edit':
      if (host) openHostForm(host);
      break;
    case 'host-duplicate':
      if (host) await duplicateHost(host);
      break;
    case 'host-detect': {
      if (!host) return;
      await detectAll(true, host.id);
      if (S.view === 'hosts') refreshHostsTable();
      else renderView();
      const state = S.detected[host.id];
      if (state && state.authFailed) toast('读取服务器信息失败：' + (state.error || '认证失败'), 'error');
      else if (state && (state.error || state.reachable === false)) toast('读取服务器信息失败：' + (state.error || '主机不可达'), 'error');
      else toast(`${hostName(host)} 服务器信息已更新`, 'success', 2200);
      if (S.clusterModalHostId === host.id) {
        S.cluster = null;
        openClusterModal(host);
      }
      break;
    }
    case 'host-preflight':
      if (host) openPreflight(host);
      break;
    case 'host-install':
      if (host) openInstallChoice(host);
      break;
    case 'host-uninstall':
      if (host) uninstallHost(host);
      break;
    case 'host-delete':
      if (host) deleteHost(host);
      break;
    case 'detect-all':
      await detectAll(true);
      if (S.view === 'hosts') refreshHostsTable();
      else renderView();
      break;
    case 'enter-cluster':
      if (!host) return;
      openClusterModal(host);
      break;
    case 'goto-install':
      goDeployTab('install');
      break;
    case 'goto-hosts':
      navigate('hosts');
      break;
    case 'goto-yaml':
      if ($('#modalRoot .modal.cluster-modal')) closeModal();
      goDeployTab('custom');
      setTimeout(() => {
        const ta = $('#deployYaml');
        if (ta) { ta.scrollIntoView({ block: 'center', behavior: 'smooth' }); ta.focus(); }
      }, 120);
      break;
    case 'goto-jobs':
      navigate('jobs');
      break;
    case 'cluster-refresh':
      await loadClusterData(activeHost(), true);
      toast('集群信息已刷新', 'success', 1600);
      break;
    case 'node-info':
      openNodeInfo(el.dataset.node);
      break;
    case 'node-cordon':
    case 'node-uncordon':
    case 'node-drain':
      await doNodeAction(el.dataset.node, action.replace('node-', ''));
      break;
    case 'open-events':
      openEventsModal();
      break;
    case 'open-namespace':
      if ($('#modalRoot .modal.cluster-modal')) closeModal();
      S.page.namespace = el.dataset.ns || '';
      S.page.kind = 'pods';
      S.page.page = 1;
      S.page.search = '';
      S.workloadData = null;
      navigate('workloads');
      break;
    case 'wl-kind':
      changeKind(el.dataset.kind);
      break;
    case 'wl-refresh':
      await loadWorkloads(true);
      break;
    case 'wl-prev':
      if (S.page.page > 1) { S.page.page -= 1; refreshWorkloadTable(); }
      break;
    case 'wl-next':
      S.page.page += 1;
      refreshWorkloadTable();
      break;
    case 'open-resource':
      openResourceDrawer(el.dataset.kind, el.dataset.ns, el.dataset.name);
      break;
    case 'drawer-close':
      closeDrawer();
      break;
    case 'drawer-tab':
      renderDrawerTab(el.dataset.tab);
      break;
    case 'drawer-scale':
      drawerScale();
      break;
    case 'drawer-restart-pod':
      drawerRestartPod();
      break;
    case 'drawer-restart':
      drawerRestart();
      break;
    case 'drawer-delete':
      drawerDelete();
      break;
    case 'job-open':
      openJobModal(el.dataset.job);
      break;
    case 'job-cancel':
      await cancelJob(el.dataset.job);
      break;
    case 'jobs-refresh':
      await refreshJobs(false);
      renderJobsList();
      toast('操作记录已刷新', 'success', 1500);
      break;
    case 'deploy-tab':
      goDeployTab(el.dataset.tab || 'install');
      break;
    case 'k3s-page':
      setK3sPage(el.dataset.page || 'install');
      break;
    case 'deploy-pick-hosts':
      openDeployHostPicker();
      break;
    case 'deploy-force-show':
      ensureDeployForm().force = true;
      renderView();
      break;
    case 'upgrade-start':
      await startUpgrade();
      break;
    case 'component-install':
      await installCommunityComponent(el.dataset.component);
      break;
    case 'image-copy':
      if (el.dataset.image) await copyText(el.dataset.image);
      break;
    case 'image-pull': {
      if (el.dataset.image) await pullBaseImageWithPicker(el.dataset.image, el);
      break;
    }
    case 'components-subtab': {
      const tab = componentSubTabOf(el.dataset.tab || 'components');
      if (tab === S.componentsTab) break;
      S.componentsTab = tab;
      renderView();
      break;
    }
    case 'image-category': {
      const category = String(el.dataset.category || '').trim();
      if (!category || category === imageCategoryId()) break;
      S.imageCategory = category;
      renderView();
      break;
    }
    case 'node-images-goto':
      S.hostImages = {};
      goComponentsTab('node-images');
      break;
    case 'node-images-refresh': {
      const host = nodeImageHost();
      if (host) delete S.hostImages[host.id];
      renderView();
      break;
    }
    case 'node-images-filters-reset':
      S.hostImageFilters = { name: '', id: '' };
      renderView();
      break;
    case 'node-images-import': {
      // 先选服务器（可多选、可跨集群），再上传 .tar：同一个包依次分发到每台
      const pool = nodeImagePool();
      if (!pool.length) { toast('还没有可导入的服务器', 'error'); break; }
      const current = nodeImageHost();
      const picked = await pickHosts({
        hosts: pool,
        allowMixed: true,
        initial: current ? [current.id] : [],
        title: '选择要导入镜像的服务器',
        hint: '可以多选、可跨集群；选好后再挑镜像包，同一个 tar 会依次分发到每台服务器导入。',
        confirmText: '选择镜像包'
      });
      if (!picked.length) break;
      importK3sImageTar(picked, {
        onClose: () => {
          picked.forEach((host) => delete S.hostImages[host.id]);
          renderView();
        }
      });
      break;
    }
    case 'node-image-copy':
      if (el.dataset.image) await copyText(el.dataset.image);
      break;
    case 'node-image-download': {
      const host = findHost(el.dataset.host);
      const image = el.dataset.image || '';
      if (!host || !image || image === '<none>') break;
      el.disabled = true;
      try {
        const created = await api(`/hosts/${encodeURIComponent(host.id)}/images/export`, {
          method: 'POST',
          body: { image }
        });
        openJobModal(created.jobId, { onClose: () => renderView() });
      } catch (err) {
        el.disabled = false;
        toast(errorText(err), 'error', 6000);
      }
      break;
    }
    case 'node-image-delete': {
      const host = findHost(el.dataset.host);
      const imageId = el.dataset.imageId || '';
      if (!host || !imageId) break;
      await deleteK3sImage(host, imageId, el.dataset.imageLabel || '', {
        onCancel: () => {},
        onDone: () => {
          delete S.hostImages[host.id];
          renderView();
        }
      });
      break;
    }
    case 'image-repo-config':
      openImageRepositoryConfig();
      break;
    case 'image-new':
      openImageEditor(null);
      break;
    case 'image-edit':
      openImageEditor(findBaseImage(String(el.dataset.image || '').trim()));
      break;
    case 'image-menu':
      openImageActionMenu(el, String(el.dataset.image || '').trim());
      break;
    case 'image-delete':
      await deleteBaseImage(String(el.dataset.image || '').trim());
      break;
    case 'image-category-add':
      openImageCategoryDraft();
      break;
    case 'image-category-delete':
      event.stopPropagation();
      await deleteImageCategory(String(el.dataset.category || '').trim());
      break;
    case 'image-pull-copy':
      if (el.dataset.command) await copyText(el.dataset.command);
      if (el.closest('.copy-command-menu')) el.blur();
      break;
    case 'deploy-start':
      await startClusterDeploy();
      break;
    case 'deploy-preflight':
      await deployPreflight();
      break;
    case 'offline-refresh':
      await loadOfflinePackages();
      if (S.view === 'deploy') renderView();
      toast(S.offlinePackages.length ? `已加载 ${S.offlinePackages.length} 个离线安装包` : '未找到离线安装包', S.offlinePackages.length ? 'success' : 'error');
      break;
    case 'yaml-apply':
      await applyYamlFromDeploy();
      break;
    case 'yaml-template-check':
      checkYamlTemplateSyntax();
      break;
    case 'yaml-template-save':
      openSaveYamlTemplateDialog();
      break;
    case 'yaml-template-delete':
      await deleteYamlTemplate();
      break;
    case 'pod-config-add':
      openPodConfigTypePicker();
      break;
    case 'pod-config-import':
      openPodConfigImport();
      break;
    case 'pod-config-refresh':
      await refreshPodConfigs();
      break;
    case 'pod-config-filter-clear':
      S.podConfigTypeFilter = 'all';
      renderView();
      break;
    case 'pod-config-view':
      viewPodConfig(el.dataset.templateId);
      break;
    case 'pod-config-edit':
      editPodConfig(el.dataset.templateId);
      break;
    case 'pod-config-delete':
      await deletePodConfig(el.dataset.templateId);
      break;
    case 'pod-config-apply':
      await applyPodConfig(el.dataset.templateId);
      break;
    case 'wl-add':
      openAddResource();
      break;
    case 'settings-tab':
      S.page.settingsTab = el.dataset.tab;
      renderSettings();
      break;
    case 'config-save':
      await saveConfig();
      break;
    case 'config-reload':
      await reloadConfig();
      break;
    case 'config-format': {
      const editor = $('#configEditor');
      if (!editor) return;
      try {
        editor.value = JSON.stringify(JSON.parse(editor.value), null, 2);
        S.settingsDraft = editor.value;
        toast('已格式化', 'success', 1500);
      } catch (err) {
        toast('JSON 解析失败：' + err.message, 'error');
      }
      break;
    }
    case 'config-download':
      downloadText('config.json', S.settingsDraft || JSON.stringify(S.config || {}, null, 2));
      break;
    case 'save-token':
      await saveToken();
      break;
    case 'boot-retry':
      location.reload();
      break;
    default:
      console.warn('未处理的操作：', action);
  }
}

function bindStatic() {
  bindTheme();
  bindCselect();

  document.addEventListener('click', (event) => {
    if (hostActionMenuEl && (!event.target.closest || !event.target.closest('#hostActionMenu'))) closeHostActionMenu();
    if (imageActionMenuEl && (!event.target.closest || !event.target.closest('#imageActionMenu'))) closeImageActionMenu();
    if (jobContextMenuEl && (!event.target.closest || !event.target.closest('#jobContextMenu'))) closeJobContextMenu();
    const deployParent = event.target.closest('.nav-parent[data-view="deploy"]');
    if (deployParent) {
      event.preventDefault();
      S.navDeployOpen = !S.navDeployOpen;
      syncDeployNav();
      navigate('deploy');
      $('#sidebar').classList.remove('open');
      return;
    }
    const deployNav = event.target.closest('[data-deploy-tab]');
    if (deployNav) {
      event.preventDefault();
      S.navDeployOpen = true;
      syncDeployNav();
      goDeployTab(deployNav.dataset.deployTab);
      $('#sidebar').classList.remove('open');
      return;
    }
    const nav = event.target.closest('.nav-item[data-view]');
    if (nav) {
      event.preventDefault();
      navigate(nav.dataset.view);
      $('#sidebar').classList.remove('open');
      return;
    }
    const el = event.target.closest('[data-action]');
    if (!el) return;
    event.preventDefault();
    event.stopPropagation();
    Promise.resolve(handleAction(el, el.dataset.action)).catch((err) => {
      console.error(err);
      toast(errorText(err), 'error');
    });
  });

  document.addEventListener('input', (event) => {
    const target = event.target;
    if (target.id === 'hostsSearch') {
      S.page.hostsQuery = target.value;
      refreshServerList();
    } else if (target.id === 'nodeImageNameFilter') {
      S.hostImageFilters.name = target.value;
      refreshNodeImageResult();
    } else if (target.id === 'nodeImageIdFilter') {
      S.hostImageFilters.id = target.value;
      refreshNodeImageResult();
    } else if (target.id === 'wlSearch') {
      S.page.search = target.value;
      S.page.page = 1;
      refreshWorkloadTable();
    } else if (target.id === 'configEditor') {
      S.settingsDraft = target.value;
    } else if (target.id === 'deployYaml') {
      scheduleYamlSyntaxCheck();
    }
  });

  // 镜像分类页签：拖动排序
  document.addEventListener('dragstart', (event) => imageCategoryDragStart(event));
  document.addEventListener('dragover', (event) => imageCategoryDragOver(event));
  document.addEventListener('drop', (event) => {
    Promise.resolve(imageCategoryDrop(event)).catch((err) => {
      console.error(err);
      toast(errorText(err), 'error', 5000);
    });
  });
  document.addEventListener('dragend', () => imageCategoryDragEnd());

  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target.id === 'wlNamespace') {
      S.page.namespace = target.value;
      S.page.page = 1;
      S.workloadData = null;
      renderView();
    } else if (target.id === 'podConfigTypeFilter') {
      S.podConfigTypeFilter = target.value || 'all';
      renderView();
    } else if (target.id === 'nodeImageHostSelect') {
      // 单选切换：换一台服务器就重新读取该节点的镜像
      if (!target.value) return;
      S.hostImageTarget = target.value;
      delete S.hostImages[target.value];
      renderView();
    } else if (target.id === 'yamlTemplate') {
      const template = yamlTemplateByKey(target.value);
      updateYamlTemplateDeleteButton();
      const editor = $('#deployYaml');
      if (template && editor) {
        editor.value = template.yaml;
        const syntax = checkYamlSyntax(template.yaml);
        paintYamlSyntaxStatus(syntax);
        if (!syntax.ok) toast(`模板语法错误：${syntax.message}`, 'error');
      }
    } else if (target.matches('[data-image-version]')) {
      updateBaseImageVersion(target);
    } else if (target.id === 'deployHostSelect') {
      if (!target.value) return;
      const draft = $('#deployYaml') ? $('#deployYaml').value : null;
      const namespace = $('#yamlNamespace') ? $('#yamlNamespace').value : null;
      const dryRun = $('#yamlDryRun') ? $('#yamlDryRun').checked : null;
      setActiveHost(target.value);
      renderView();
      if (draft !== null) {
        const editor = $('#deployYaml');
        if (editor) editor.value = draft;
      }
      if (namespace !== null) {
        const input = $('#yamlNamespace');
        if (input) input.value = namespace;
      }
      if (dryRun !== null) {
        const checkbox = $('#yamlDryRun');
        if (checkbox) checkbox.checked = dryRun;
      }
    }
  });

  $('#menuBtn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  const hostPickerBtn = $('#hostPickerBtn');
  if (hostPickerBtn) hostPickerBtn.addEventListener('click', () => openHostPicker());
  $('#overlay').addEventListener('click', () => {
    const modal = $('#modalRoot .modal');
    if (modal) closeModal();
    else closeDrawer();
  });
  window.addEventListener('scroll', closeHostActionMenu, true);
  window.addEventListener('resize', closeHostActionMenu);
  window.addEventListener('scroll', closeJobContextMenu, true);
  window.addEventListener('resize', closeJobContextMenu);
  bindHostTreeDrag();
  document.addEventListener('keydown', (event) => {
    if ((event.key === 'Enter' || event.key === ' ') && event.target instanceof Element) {
      const stat = event.target.closest('.stat.clickable[data-action]');
      if (stat) {
        event.preventDefault();
        stat.click();
        return;
      }
      const groupHead = event.target.closest('.group-node-head[data-action="group-toggle"]');
      if (groupHead) {
        event.preventDefault();
        groupHead.click();
        return;
      }
    }
    if (event.key === 'Escape') {
      if (hostActionMenuEl) {
        closeHostActionMenu();
        return;
      }
      if (jobContextMenuEl) {
        closeJobContextMenu();
        return;
      }
      if (imageCategoryDraftEl) {
        closeImageCategoryDraft();
        return;
      }
      if ($('#modalRoot .modal')) closeModal();
      else if ($('#resourceDrawer')) closeDrawer();
    }
  });
  $('#refreshBtn').addEventListener('click', async () => {
    const btn = $('#refreshBtn');
    btn.classList.add('spin');
    try {
      if (S.view === 'dashboard' || S.view === 'hosts') {
        await detectAll(true);
      } else if (S.view === 'workloads') {
        await loadWorkloads(true);
      } else if (S.view === 'jobs') {
        await refreshJobs(false);
        renderJobsList();
      } else {
        renderView();
      }
    } catch (err) {
      toast(errorText(err), 'error');
    } finally {
      setTimeout(() => btn.classList.remove('spin'), 500);
    }
  });

  window.addEventListener('hashchange', () => {
    if (document.body.classList.contains('remote-detached')) return;
    const route = parseRoute(location.hash);
    const view = VIEW_META[route.view] ? route.view : 'dashboard';
    const nextTab = view === 'deploy' ? route.tab : '';
    const changed = view !== S.view || (view === 'deploy' && nextTab !== S.deployTab);
    if (view === 'deploy') S.deployTab = nextTab;
    const canonical = routeHash(view, S.deployTab);
    if (location.hash !== canonical) history.replaceState(null, '', canonical);
    if (changed) {
      S.view = view;
      renderView();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && S.jobs.some((j) => j.status === 'running')) refreshJobs();
    if (!document.hidden) pollOfflinePackages();
  });
}

async function loadConfig() {
  const data = await api('/config');
  S.config = data.config;
}

async function loadImageRepository() {
  try {
    const data = await api('/image-repository');
    S.imageRepository = data.repository;
  } catch (_) {
    S.imageRepository = { repository: 'docker.io', username: '', hasPassword: false, isDefault: true };
  }
}

function bootStatus(step, text, hint = '') {
  const splash = $('#bootSplash');
  if (!splash) return;
  const order = ['boot', 'hosts', 'ready'];
  const index = order.indexOf(step);
  splash.querySelectorAll('.boot-step').forEach((el) => {
    const i = order.indexOf(el.dataset.bootStep);
    el.classList.toggle('active', i === index);
    el.classList.toggle('done', index >= 0 && i < index);
  });
  if (text) {
    const title = $('#bootSplashTitle');
    if (title) title.textContent = text;
  }
  const hintEl = $('#bootSplashHint');
  if (hintEl) hintEl.textContent = hint;
}

function bootSlowHint() {
  const splash = $('#bootSplash');
  if (!splash || splash.classList.contains('failed')) return;
  splash.classList.add('slow');
  const hint = $('#bootSplashHint');
  if (hint) hint.textContent = '接口响应较慢，仍在等待…';
}

function bootFail(message) {
  const splash = $('#bootSplash');
  if (!splash) return;
  splash.classList.remove('slow');
  splash.classList.add('failed');
  const title = $('#bootSplashTitle');
  if (title) title.textContent = '连接控制台失败';
  const text = $('#bootSplashText');
  if (text) text.textContent = message;
  const hint = $('#bootSplashHint');
  if (hint) {
    hint.innerHTML = '';
    const btn = document.createElement('button');
    btn.className = 'btn primary sm';
    btn.innerHTML = `${icon('refresh')} 重新加载`;
    btn.addEventListener('click', () => location.reload());
    hint.appendChild(btn);
  }
}

async function init() {
  bindStatic();
  const remoteHostId = new URLSearchParams(location.search).get('remote');
  if (remoteHostId) document.body.classList.add('remote-detached');
  // 弹窗窗口的 sessionStorage 在部分浏览器不会自动继承；从同源 opener 补一次令牌。
  try {
    if (!token() && window.opener && typeof window.opener.token === 'function') {
      const inherited = window.opener.token();
      if (inherited) sessionStorage.setItem(TOKEN_KEY, inherited);
    }
  } catch (_) { /* ignore */ }
  const route = parseRoute(location.hash);
  const hashView = VIEW_META[route.view] ? route.view : 'dashboard';
  S.view = hashView;
  if (hashView === 'deploy') S.deployTab = route.tab || 'install';
  const canonical = routeHash(hashView, S.deployTab);
  if (!remoteHostId && location.hash !== canonical) history.replaceState(null, '', canonical);
  try {
    bootStatus('boot', '正在连接控制台', '正在读取服务状态…');
    const slowTimer = setTimeout(bootSlowHint, 4000);
    try {
      await Promise.all([loadBootstrap(), loadConfig(), loadImageRepository(), loadImageCatalog()]);
      await loadHosts();
    } finally {
      clearTimeout(slowTimer);
    }
    if (remoteHostId) {
      const host = findHost(remoteHostId);
      if (!host || (host.transport || 'ssh') !== 'ssh') {
        document.body.classList.add('remote-detached');
        document.title = '远程连接 · 无法打开';
        $('#view').innerHTML = `<div class="empty"><div class="eico">${icon('alert')}</div><h4>无法打开远程连接</h4><p>服务器不存在，或该服务器未使用 SSH 接入方式。</p></div>`;
        return;
      }
      initDetachedHostShell(host);
      return;
    }
    bootStatus('hosts', '正在读取服务器与集群', '正在加载服务器列表、离线包和模板…');
    await loadOfflinePackages();
    try {
      await loadDeploymentTemplates();
    } catch (err) {
      console.warn('加载我的模板失败：', errorText(err));
    }
    await refreshJobs();
  } catch (err) {
    $('#apiStatus').innerHTML = '<i class="dot err"></i><span>连接失败</span>';
    bootFail(`${errorText(err)}。请确认 Node 服务已启动，且 config.json 格式正确。`);
    return;
  }
  bootStatus('ready', '正在准备界面', '');
  setHeader(S.view);
  updateHostPicker();
  renderView();
  // 启动后只补读还没有结果的服务器；已有结果的保持原样，避免全部闪成「读取中」
  maybeAutoDetect();
  setInterval(() => {
    if (document.hidden) return;
    if (S.jobs.some((j) => j.status === 'running' || j.status === 'cancelling')) refreshJobs();
  }, 8000);
  setInterval(pollOfflinePackages, 10000);
}

init();

// __APP_JS_END__

