/* ============================================================
 * 服务器 SFTP 文件管理
 * 嵌入远程连接弹窗使用
 * ============================================================ */

function sftpPanelHTML(st) {
  return `<div class="sftp-browser${st && st.compact ? ' compact' : ''}">
    <div class="sftp-toolbar">
      <button class="icon-btn sftp-home-btn" type="button" title="回到 SSH 用户主目录" aria-label="回到 SSH 用户主目录">${icon('folder')}</button>
      <button class="icon-btn sftp-up-btn" type="button" title="返回上一级目录" aria-label="返回上一级目录">${icon('arrow-left')}</button>
      <div class="sftp-address">
        <input class="input sftp-path-input" spellcheck="false" autocomplete="off" placeholder="远程目录，例如 /opt" aria-label="远程目录" />
        <button class="icon-btn sftp-go-btn" type="button" title="前往输入的目录" aria-label="前往输入的目录">${icon('chevron-right')}</button>
      </div>
      <button class="icon-btn sftp-refresh-btn" type="button" title="刷新目录" aria-label="刷新目录">${icon('refresh')}</button>
      <button class="btn sm primary btn-icon sftp-upload-btn" type="button" title="选择文件上传；也可以直接把文件拖入窗口" aria-label="上传文件">${icon('upload')}</button>
      <input type="file" class="sftp-file-input" multiple hidden />
    </div>
    <div class="sftp-subbar">
      <span class="sftp-hint">点击文件夹进入，点击文件名下载</span>
      <span class="spacer"></span>
      <span class="sftp-note"></span>
    </div>
    <div class="sftp-list"></div>
    <div class="sftp-drop-hint" aria-hidden="true">
      <div><b>释放文件上传</b><span class="sftp-drop-path">当前目录</span></div>
    </div>
  </div>`;
}

function createSftpPanel(host, root, options = {}) {
  if (!host || !root) throw new Error('SFTP 面板缺少主机或容器');
  const st = {
    host,
    root,
    dropRoot: options.dropRoot || root,
    compact: options.compact === true,
    path: '',
    home: '',
    parent: '',
    entries: [],
    loading: true,
    uploading: false,
    uploadText: '',
    error: '',
    loadSeq: 0,
    activeXhr: null,
    pendingPath: '',
    cancelled: false
  };
  root.innerHTML = sftpPanelHTML(st);
  bindSftpPanel(st);
  renderSftp(st);
  loadSftpDir(st, '');
  return {
    state: st,
    load(targetPath) {
      return loadSftpDir(st, targetPath);
    },
    currentPath() {
      return st.path || '';
    },
    destroy() {
      st.cancelled = true;
      st.loadSeq += 1;
      if (st.activeXhr) {
        try { st.activeXhr.abort(); } catch (_) { /* ignore */ }
        st.activeXhr = null;
      }
    }
  };
}

function bindSftpPanel(st) {
  const root = st.root;
  const pathInput = $('.sftp-path-input', root);
  const fileInput = $('.sftp-file-input', root);
  if (pathInput) {
    pathInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        loadSftpDir(st, pathInput.value);
      }
    });
  }
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = '';
      uploadSftpFiles(st, files);
    });
  }
  bindSftpDrop(st);
  root.addEventListener('click', (event) => {
    if (st.cancelled) return;
    const target = event.target && event.target.closest ? event.target : null;
    if (!target) return;
    if (target.closest('.sftp-home-btn')) {
      loadSftpDir(st, '');
      return;
    }
    if (target.closest('.sftp-up-btn')) {
      if (st.parent) loadSftpDir(st, st.parent);
      return;
    }
    if (target.closest('.sftp-go-btn')) {
      loadSftpDir(st, pathInput ? pathInput.value : '');
      return;
    }
    if (target.closest('.sftp-refresh-btn')) {
      loadSftpDir(st, st.path);
      return;
    }
    if (target.closest('.sftp-upload-btn')) {
      if (st.loading || st.uploading) return;
      if (!st.path) { toast('当前目录尚未加载完成', 'error'); return; }
      if (fileInput) fileInput.click();
      return;
    }
    const open = target.closest('[data-sftp-open]');
    if (open) {
      loadSftpDir(st, open.getAttribute('data-sftp-open'));
      return;
    }
    const download = target.closest('[data-sftp-download]');
    if (download) {
      const remotePath = download.getAttribute('data-sftp-download');
      const name = download.getAttribute('data-sftp-name') || remotePath.split('/').pop() || 'download';
      downloadSftpFile(st, remotePath, name);
      return;
    }
    const dirRow = target.closest('[data-sftp-row-dir]');
    if (dirRow) {
      loadSftpDir(st, dirRow.getAttribute('data-sftp-row-dir'));
    }
  });
}

function sftpHasFileDrag(event) {
  const types = event && event.dataTransfer && event.dataTransfer.types;
  return !!types && Array.from(types).includes('Files');
}

function bindSftpDrop(st) {
  const target = st.dropRoot;
  if (!target) return;
  const surface = $('.sftp-browser', st.root) || st.root;
  let depth = 0;
  const clear = () => {
    depth = 0;
    surface.classList.remove('dragover');
  };
  target.addEventListener('dragenter', (event) => {
    if (st.cancelled || !sftpHasFileDrag(event)) return;
    event.preventDefault();
    depth += 1;
    surface.classList.add('dragover');
  }, true);
  target.addEventListener('dragover', (event) => {
    if (st.cancelled || !sftpHasFileDrag(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  }, true);
  target.addEventListener('dragleave', () => {
    if (st.cancelled) return;
    if (depth > 0) depth -= 1;
    if (depth === 0) surface.classList.remove('dragover');
  }, true);
  target.addEventListener('drop', (event) => {
    if (st.cancelled) return;
    const files = event.dataTransfer ? Array.from(event.dataTransfer.files || []) : [];
    if (!files.length && !sftpHasFileDrag(event)) return;
    event.preventDefault();
    clear();
    const items = event.dataTransfer ? Array.from(event.dataTransfer.items || []) : [];
    const hasDirectory = items.some((item) => {
      try {
        const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
        return !!(entry && entry.isDirectory);
      } catch (_) {
        return false;
      }
    });
    if (hasDirectory) {
      toast('暂不支持拖拽文件夹，请拖入文件', 'error');
      return;
    }
    if (st.loading) {
      toast('正在读取当前目录，请稍候', 'error');
      return;
    }
    if (st.uploading) {
      toast('正在上传，请稍候', 'error');
      return;
    }
    if (!st.path) {
      toast('当前目录尚未加载完成', 'error');
      return;
    }
    if (files.length) uploadSftpFiles(st, files);
  }, true);
}

async function loadSftpDir(st, targetPath) {
  if (!st || !st.root || st.cancelled) return false;
  if (st.uploading) {
    st.pendingPath = String(targetPath || '');
    return false;
  }
  const target = String(targetPath || '');
  const seq = ++st.loadSeq;
  st.loading = true;
  st.error = '';
  renderSftp(st);
  try {
    const data = await api(`/hosts/${encodeURIComponent(st.host.id)}/sftp/list?path=${encodeURIComponent(target)}`);
    if (st.cancelled || seq !== st.loadSeq) return false;
    st.path = data.path || '';
    st.home = data.home || '';
    st.parent = data.parent || (st.path === '/' ? '/' : '');
    st.entries = Array.isArray(data.entries) ? data.entries : [];
    st.loading = false;
    st.error = '';
    renderSftp(st);
    return true;
  } catch (err) {
    if (st.cancelled || seq !== st.loadSeq) return false;
    st.loading = false;
    st.entries = [];
    st.error = errorText(err);
    renderSftp(st);
    return false;
  }
}

function sftpFileSize(bytes) {
  if (bytes === null || bytes === undefined) return '—';
  const value = Number(bytes);
  if (!Number.isFinite(value) || value < 0) return '—';
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(value < 10 * 1024 ? 1 : 0) + ' KB';
  if (value < 1024 * 1024 * 1024) return (value / 1024 / 1024).toFixed(value < 10 * 1024 * 1024 ? 1 : 0) + ' MB';
  return (value / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

function sftpRowHTML(entry) {
  const type = entry.type === 'dir' ? 'dir' : entry.type === 'link' ? 'link' : 'file';
  const iconName = type === 'dir' ? 'folder' : type === 'link' ? 'link' : 'file';
  const name = String(entry.name || '');
  const fullPath = String(entry.path || '');
  const canOpen = type === 'dir';
  const action = canOpen
    ? `data-sftp-open="${esc(fullPath)}"`
    : `data-sftp-download="${esc(fullPath)}" data-sftp-name="${esc(name)}"`;
  return `<tr class="sftp-row-${type}"${canOpen ? ` data-sftp-row-dir="${esc(fullPath)}"` : ''}>
    <td class="sftp-name-cell">
      <button type="button" class="sftp-entry ${type}" ${action} title="${esc(canOpen ? '打开文件夹' : '下载文件')}">
        ${icon(iconName)}<span>${esc(name)}</span>
      </button>
    </td>
    <td class="sftp-size">${type === 'dir' ? '—' : sftpFileSize(entry.size)}</td>
    <td class="sftp-time">${fmtTime(entry.mtime)}</td>
    <td class="sftp-mode mono">${esc(entry.modeText || '—')}</td>
    <td class="sftp-actions">${canOpen ? '' : `<button type="button" class="icon-btn sftp-download-btn" data-sftp-download="${esc(fullPath)}" data-sftp-name="${esc(name)}" title="下载">${icon('download')}</button>`}</td>
  </tr>`;
}

function renderSftp(st) {
  if (!st || !st.root || st.cancelled) return;
  const root = st.root;
  const list = $('.sftp-list', root);
  const note = $('.sftp-note', root);
  const pathInput = $('.sftp-path-input', root);
  const upBtn = $('.sftp-up-btn', root);
  const dropPath = $('.sftp-drop-path', root);
  const busy = st.loading || st.uploading;
  if (pathInput && document.activeElement !== pathInput) pathInput.value = st.path || '';
  if (dropPath) dropPath.textContent = st.path ? `上传到 ${st.path}` : '上传到当前目录';
  if (upBtn) upBtn.disabled = busy || st.path === '/' || !st.parent;
  ['.sftp-home-btn', '.sftp-go-btn', '.sftp-refresh-btn', '.sftp-upload-btn'].forEach((selector) => {
    const btn = $(selector, root);
    if (btn) btn.disabled = busy;
  });
  if (note) {
    if (st.uploading) {
      note.classList.remove('err');
      note.innerHTML = `<span class="spinner"></span><span>${esc(st.uploadText || '正在上传…')}</span>`;
    } else if (st.error) {
      note.innerHTML = `${icon('alert')}<span>${esc(st.error)}</span>`;
      note.classList.add('err');
    } else {
      note.classList.remove('err');
      note.textContent = `${st.entries.length} 项`;
    }
  }
  if (!list) return;
  if (st.loading) {
    list.innerHTML = `<div class="sftp-placeholder"><span class="spinner"></span><span>正在读取远程目录…</span></div>`;
    return;
  }
  if (st.error) {
    list.innerHTML = `<div class="sftp-placeholder sftp-error">${icon('alert')}<span>${esc(st.error)}</span></div>`;
    return;
  }
  if (!st.entries.length) {
    list.innerHTML = `<div class="sftp-placeholder">${icon('folder')}<span>这个目录是空的</span></div>`;
    return;
  }
  list.innerHTML = `<div class="table-wrap">
    <table class="data sftp-table">
      <thead><tr><th>名称</th><th class="sftp-size">大小</th><th class="sftp-time">修改时间</th><th class="sftp-mode">权限</th><th class="sftp-actions"></th></tr></thead>
      <tbody>${st.entries.map(sftpRowHTML).join('')}</tbody>
    </table>
  </div>`;
}

function downloadSftpFile(st, remotePath, name) {
  if (!st || !remotePath) return;
  const url = `/api/hosts/${encodeURIComponent(st.host.id)}/sftp/download?path=${encodeURIComponent(remotePath)}`;
  const anchor = document.createElement('a');
  anchor.href = withToken(url);
  anchor.download = name || 'download';
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function uploadSftpFile(st, dir, file, overwrite, onProgress) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({
      dir,
      name: file.name,
      overwrite: overwrite ? '1' : '0'
    });
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/hosts/${encodeURIComponent(st.host.id)}/sftp/upload?${params.toString()}`);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (token()) xhr.setRequestHeader('X-Access-Token', token());
    st.activeXhr = xhr;
    const clear = () => { if (st.activeXhr === xhr) st.activeXhr = null; };
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && typeof onProgress === 'function') onProgress(event.loaded, event.total);
    };
    xhr.onload = () => {
      clear();
      let json = null;
      try { json = JSON.parse(xhr.responseText); } catch (_) { /* ignore */ }
      if (xhr.status === 401) {
        showTokenModal();
        reject(new Error('需要访问令牌'));
        return;
      }
      if (xhr.status < 200 || xhr.status >= 300 || !json || json.ok === false) {
        const err = new Error((json && json.error) || `上传失败（HTTP ${xhr.status}）`);
        err.status = xhr.status;
        reject(err);
        return;
      }
      resolve(json.data);
    };
    xhr.onerror = () => {
      clear();
      reject(new Error('上传失败：无法连接控制台后端'));
    };
    xhr.onabort = () => {
      clear();
      reject(new Error('上传已取消'));
    };
    xhr.send(file);
  });
}

function confirmSftpOverwrite(st, fileName) {
  return new Promise((resolve) => {
    const old = $('.sftp-confirm', st.root);
    if (old) old.remove();
    const bar = document.createElement('div');
    bar.className = 'sftp-confirm';
    bar.innerHTML = `<div class="sftp-confirm-text">当前目录已存在「<b>${esc(fileName)}</b>」，是否覆盖上传？</div>
      <div class="sftp-confirm-actions">
        <button type="button" class="btn sm ghost" data-sftp-confirm="no">跳过</button>
        <button type="button" class="btn sm danger" data-sftp-confirm="yes">覆盖上传</button>
      </div>`;
    const subbar = $('.sftp-subbar', st.root);
    if (subbar) subbar.insertAdjacentElement('afterend', bar);
    else st.root.prepend(bar);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      bar.remove();
      resolve(ok);
    };
    bar.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-sftp-confirm]');
      if (!btn) return;
      finish(btn.getAttribute('data-sftp-confirm') === 'yes');
    });
    const yes = $('[data-sftp-confirm="yes"]', bar);
    if (yes) yes.focus();
  });
}

async function uploadSftpFiles(st, files) {
  if (!st || !files || !files.length || st.uploading || st.cancelled) return;
  if (!st.path) {
    toast('当前目录尚未加载完成', 'error');
    return;
  }
  const dir = st.path;
  const errors = [];
  const skipped = [];
  const entries = Array.isArray(st.entries) ? st.entries : [];
  const existingFiles = new Set(entries.filter((entry) => entry.type !== 'dir').map((entry) => entry.name));
  const existingDirs = new Set(entries.filter((entry) => entry.type === 'dir').map((entry) => entry.name));
  const accepted = [];
  st.uploading = true;
  st.error = '';
  st.uploadText = `准备上传 ${files.length} 个文件…`;
  renderSftp(st);
  for (const file of files) {
    if (st.cancelled) return;
    if (existingDirs.has(file.name)) {
      errors.push(`${file.name}：同名目录已存在`);
      continue;
    }
    let overwrite = existingFiles.has(file.name);
    if (overwrite) {
      st.uploadText = `等待确认：${file.name}`;
      const note = $('.sftp-note', st.root);
      if (note) note.innerHTML = `<span>${esc(st.uploadText)}</span>`;
      const ok = await confirmSftpOverwrite(st, file.name);
      if (st.cancelled) return;
      if (!ok) {
        skipped.push(file.name);
        continue;
      }
    }
    accepted.push({ file, overwrite });
  }
  if (!accepted.length) {
    st.uploading = false;
    st.uploadText = '';
    renderSftp(st);
    if (errors.length) toast(errors[0], 'error', 5200);
    else if (skipped.length) toast(`已跳过 ${skipped.length} 个同名文件`, 'info', 3000);
    return;
  }
  let uploaded = 0;
  for (let i = 0; i < accepted.length; i++) {
    if (st.cancelled) break;
    const { file, overwrite } = accepted[i];
    const base = `正在上传 ${i + 1}/${accepted.length}：${file.name}`;
    st.uploadText = base;
    const note = $('.sftp-note', st.root);
    if (note) note.innerHTML = `<span class="spinner"></span><span>${esc(base)}</span>`;
    const onProgress = (loaded, total) => {
      if (st.cancelled || !total) return;
      const percent = Math.max(0, Math.min(100, Math.round((loaded / total) * 100)));
      st.uploadText = `${base} · ${percent}%`;
      const current = $('.sftp-note', st.root);
      if (current) current.innerHTML = `<span class="spinner"></span><span>${esc(st.uploadText)}</span>`;
    };
    try {
      try {
        await uploadSftpFile(st, dir, file, overwrite, onProgress);
      } catch (err) {
        if (err.status !== 409) throw err;
        st.uploadText = `等待确认：${file.name}`;
        const note2 = $('.sftp-note', st.root);
        if (note2) note2.innerHTML = `<span>${esc(st.uploadText)}</span>`;
        const ok = await confirmSftpOverwrite(st, file.name);
        if (st.cancelled) break;
        if (!ok) {
          skipped.push(file.name);
          continue;
        }
        await uploadSftpFile(st, dir, file, true, onProgress);
      }
      uploaded++;
    } catch (err) {
      if (!st.cancelled) errors.push(`${file.name}：${errorText(err)}`);
    }
  }
  st.uploading = false;
  st.uploadText = '';
  if (st.cancelled) return;
  if (errors.length) {
    const text = errors.length === 1 ? errors[0] : `${errors[0]}（另有 ${errors.length - 1} 个文件失败）`;
    toast(text, 'error', 5200);
  } else if (skipped.length) {
    toast(`上传完成 ${uploaded} 个，跳过 ${skipped.length} 个同名文件`, 'info', 3600);
  } else {
    toast(`${uploaded} 个文件上传完成`, 'success', 2600);
  }
  const pending = st.pendingPath;
  st.pendingPath = '';
  await loadSftpDir(st, pending || dir);
}
