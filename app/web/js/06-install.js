'use strict';

/* ============================================================
 * 操作弹窗
 * ============================================================ */
let jobStream = null;

// 触发浏览器下载（用于镜像 tar 导出等已经落到控制端的文件）
function startJobDownload(url, name) {
  if (!url) return;
  const link = document.createElement('a');
  link.href = withToken(url);
  link.download = name || 'download.bin';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  link.remove();
}

function openJobModal(jobId, opts = {}) {
  closeJobStream();
  let currentJob = null;
  let endNotified = false;
  const notifyEnd = (job) => {
    if (endNotified || !job) return;
    endNotified = true;
    if (typeof opts.onEnd === 'function') {
      try { opts.onEnd(job); } catch (err) { console.warn(err); }
    }
  };
  const modal = openModal({
    title: '操作详情',
    size: 'wide',
    body: `
      <div class="row" style="margin-bottom:14px">
        <span id="jobStatusBadge">${badge('加载中', 'info')}</span>
        <span class="small dim" id="jobTime"></span>
      </div>
      <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1.25fr);gap:16px" id="jobGrid">
        <div>
          <div class="tiny dim" style="letter-spacing:1px;margin-bottom:8px">执行步骤</div>
          <div class="steps" id="jobSteps"><div class="skeleton" style="height:40px"></div></div>
        </div>
        <div style="min-width:0">
          <div class="row" style="margin-bottom:8px">
            <span class="tiny dim" style="letter-spacing:1px">实时日志</span>
            <span class="spacer"></span>
            <button class="btn-link" id="jobScrollToggle">自动滚动：开</button>
          </div>
          <div class="logbox" id="jobLog" style="height:360px"><div class="lg-dim">等待日志输出…</div></div>
        </div>
      </div>`,
    foot: `<span class="tiny dim" id="jobDownloadHint" style="margin-right:auto"></span><button class="btn-link hidden" id="jobDownloadLink" style="margin-right:12px">下载 tar</button><button class="btn ghost" data-close="1">关闭</button><button class="btn danger hidden" id="jobCancel">${icon('stop')} 取消操作</button>`,
    onClose: () => {
      closeJobStream();
      if (typeof opts.onClose === 'function') {
        try { opts.onClose(); } catch (err) { console.warn(err); }
      }
    }
  });

  const logEl = $('#jobLog', modal.el);
  let autoScroll = true;
  let logCount = 0;
  const scrollToggle = $('#jobScrollToggle', modal.el);
  scrollToggle.addEventListener('click', () => {
    autoScroll = !autoScroll;
    scrollToggle.textContent = '自动滚动：' + (autoScroll ? '开' : '关');
    if (autoScroll) logEl.scrollTop = logEl.scrollHeight;
  });
  logEl.addEventListener('scroll', () => {
    const atBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 30;
    if (!atBottom && autoScroll) {
      autoScroll = false;
      scrollToggle.textContent = '自动滚动：关';
    }
  });

  function appendLog(entry) {
    if (!entry) return;
    if (!logCount) logEl.innerHTML = '';
    logCount += 1;
    const line = document.createElement('div');
    line.className = entry.level === 'error' ? 'lg-err' : entry.level === 'warn' ? 'lg-warn' : entry.level === 'ok' ? 'lg-ok' : '';
    const ts = entry.ts ? shortTime(entry.ts) : '';
    line.textContent = `${ts}  ${entry.text}`;
    logEl.appendChild(line);
    if (logEl.childNodes.length > 4000) logEl.removeChild(logEl.firstChild);
    if (autoScroll) logEl.scrollTop = logEl.scrollHeight;
  }

  function renderSteps(steps) {
    const root = $('#jobSteps', modal.el);
    if (!steps || !steps.length) { root.innerHTML = '<div class="tiny dim">准备中…</div>'; return; }
    root.innerHTML = steps.map((s) => {
      // 只有带真实百分比（导出下载步骤）的 running 状态才画进度环，其余步骤维持原样
      const pct = s.status === 'running' && Number.isFinite(s.progress)
        ? Math.max(0, Math.min(100, Math.round(s.progress)))
        : null;
      const ico = s.status === 'success' ? icon('check')
        : s.status === 'failed' ? icon('x')
          : s.status === 'running' ? '<span class="spinner" style="width:11px;height:11px;border-width:2px"></span>'
            : s.id;
      return `
      <div class="step ${esc(s.status)}" data-step="${s.id}">
        <div class="step-ico${pct === null ? '' : ' ring'}"${pct === null ? '' : ` style="--p:${pct}"`}>${ico}</div>
        <div class="step-main">
          <div class="step-title">${esc(s.title)}</div>
          ${s.detail ? `<div class="step-detail">${esc(s.detail)}</div>` : ''}
        </div>
        <div class="step-time">${s.startedAt ? duration(s.startedAt, s.finishedAt) : ''}</div>
      </div>`;
    }).join('');
  }

  // 状态没变、只有进度或文字变化时原地更新：重建 innerHTML 会让转圈动画从 0° 重新开始，
  // 4 次/秒的进度推送下看起来就像卡住不动
  function patchStep(step) {
    const root = $('#jobSteps', modal.el);
    const el = root && root.querySelector(`.step[data-step="${step.id}"]`);
    if (!el) return false;
    const ico = el.querySelector('.step-ico');
    const wantRing = step.status === 'running' && Number.isFinite(step.progress);
    if (wantRing !== ico.classList.contains('ring')) return false;
    if (wantRing) {
      const pct = String(Math.max(0, Math.min(100, Math.round(step.progress))));
      if (ico.style.getPropertyValue('--p') !== pct) ico.style.setProperty('--p', pct);
    }
    const main = el.querySelector('.step-main');
    let detail = el.querySelector('.step-detail');
    if (step.detail) {
      if (!detail) {
        detail = document.createElement('div');
        detail.className = 'step-detail';
        main.appendChild(detail);
      }
      if (detail.textContent !== step.detail) detail.textContent = step.detail;
    } else if (detail) {
      detail.remove();
    }
    return true;
  }

  function applySnapshot(job) {
    currentJob = job;
    const titleEl = modal.el.querySelector('.modal-head h3');
    if (titleEl) titleEl.textContent = job.status === 'running' || job.status === 'cancelling' ? '操作执行中' : '操作详情';
    $('#jobStatusBadge', modal.el).innerHTML = `<span class="badge ${jobTone(job.status)}">${esc(jobStatusText(job.status))}</span>`;
    $('#jobTime', modal.el).textContent = `${fmtTime(job.startedAt)} · 耗时 ${duration(job.startedAt, job.finishedAt)}`;
    $('#jobGrid', modal.el).style.gridTemplateColumns = 'minmax(0,1fr) minmax(0,1.25fr)';
    renderSteps(job.steps);
    const cancelBtn = $('#jobCancel', modal.el);
    if (job.status === 'running' || job.status === 'cancelling') {
      cancelBtn.classList.remove('hidden');
      cancelBtn.disabled = job.status === 'cancelling';
    } else {
      cancelBtn.classList.add('hidden');
    }
    const downloadLink = $('#jobDownloadLink', modal.el);
    const downloadHint = $('#jobDownloadHint', modal.el);
    // tar 是一次性的：下载完成后服务端会删掉控制端副本，并写入 downloadedAt
    const result = job.result || {};
    const fileInfo = !DEMO && result.downloadUrl && result.file && !result.downloadedAt ? result : null;
    if (downloadHint) {
      if (downloading) {
        downloadHint.textContent = '正在下载 tar…，完成后控制端临时文件会自动清理';
      } else if (fileInfo) {
        downloadHint.textContent = '这个 tar 还没下载过，可点右侧「下载 tar」保存到本机';
      } else if (result.downloadedAt) {
        downloadHint.textContent = result.fileRemoved === false
          ? 'tar 已下载；临时文件清理失败，请手动清理 logs/tmp'
          : 'tar 已下载，控制端临时文件已清理';
      } else if (result.fileMissing) {
        downloadHint.textContent = 'tar 已被清理，如需使用请重新导出';
      } else {
        downloadHint.textContent = '';
      }
    }
    if (downloadLink) {
      if (fileInfo && !downloading) {
        downloadLink.classList.remove('hidden');
        downloadLink.disabled = false;
        if (!downloadLink.dataset.bound) {
          downloadLink.dataset.bound = '1';
          downloadLink.addEventListener('click', () => {
            if (downloadLink.disabled || downloading) return;
            downloadJobFile();
          });
        }
      } else {
        downloadLink.classList.add('hidden');
      }
    }
    if (job.logs && job.logs.length) {
      logEl.innerHTML = '';
      logCount = 0;
      for (const entry of job.logs) appendLog(entry);
    }
  }

  // tar 是一次性文件：任务结束时自动下载，下载期间轮询记录，
  // 等服务端删掉控制端副本后把窗口切到“已下载”状态。
  let watchingDownload = false;
  let downloadStarted = false;
  let downloading = false;
  function watchDownloadState() {
    if (watchingDownload || DEMO) return;
    watchingDownload = true;
    let tries = 0;
    const tick = async () => {
      tries += 1;
      if (!document.body.contains(modal.el)) { watchingDownload = false; return; }
      try {
        const data = await api(`/jobs/${encodeURIComponent(jobId)}`);
        const state = (data.job && data.job.result) || {};
        if (!state.file) {
          watchingDownload = false;
          downloading = false;
          applySnapshot(data.job);
          return;
        }
      } catch (_) { /* 网络抖动时继续重试 */ }
      if (tries < 240) {
        setTimeout(tick, 3000);
      } else {
        watchingDownload = false;
        downloadStarted = false;
        downloading = false;
        const link = $('#jobDownloadLink', modal.el);
        const hint = $('#jobDownloadHint', modal.el);
        if (link) link.classList.remove('hidden');
        if (hint) hint.textContent = '下载可能仍在进行，可重新点击「下载 tar」';
      }
    };
    setTimeout(tick, 2500);
  }

  function downloadJobFile() {
    if (downloadStarted || downloading) return;
    const info = (currentJob && currentJob.result) || {};
    if (!info.downloadUrl || !info.file) return;
    downloadStarted = true;
    downloading = true;
    const link = $('#jobDownloadLink', modal.el);
    const hint = $('#jobDownloadHint', modal.el);
    if (link) link.classList.add('hidden');
    if (hint) hint.textContent = '正在下载 tar…，完成后控制端临时文件会自动清理';
    startJobDownload(info.downloadUrl, info.name);
    watchDownloadState();
  }

  async function load() {
    try {
      const data = await api(`/jobs/${encodeURIComponent(jobId)}`);
      applySnapshot(data.job);
      if (data.job.status === 'running') startStream();
      else {
        wireCancel();
        notifyEnd(data.job);
      }
    } catch (err) {
      $('#jobSteps', modal.el).innerHTML = `<div class="alert err">${icon('alert')}<div>${esc(errorText(err))}</div></div>`;
    }
  }

  function wireCancel() {
    const btn = $('#jobCancel', modal.el);
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: 'POST' });
        toast('已请求取消操作', 'info');
      } catch (err) {
        toast(errorText(err), 'error');
        btn.disabled = false;
      }
    });
  }

  function startStream() {
    wireCancel();
    if (DEMO) return;
    try {
      jobStream = new EventSource(withToken(`/api/jobs/${encodeURIComponent(jobId)}/stream`));
      jobStream.onmessage = (event) => {
        let payload;
        try { payload = JSON.parse(event.data); } catch (_) { return; }
        if (payload.type === 'snapshot') applySnapshot(payload.job);
        else if (payload.type === 'log') appendLog(payload.entry);
        else if (payload.type === 'step') {
          if (!currentJob) return;
          const idx = currentJob.steps.findIndex((s) => s.id === payload.step.id);
          const prev = idx >= 0 ? currentJob.steps[idx] : null;
          if (idx >= 0) currentJob.steps[idx] = payload.step;
          else currentJob.steps.push(payload.step);
          // 只有进度/文字变化就原地更新，保住转圈动画；状态变了才整段重建
          if (!(prev && prev.status === payload.step.status && patchStep(payload.step))) {
            renderSteps(currentJob.steps);
          }
        } else if (payload.type === 'status') {
          $('#jobStatusBadge', modal.el).innerHTML = `<span class="badge info">${esc(jobStatusText(payload.status))}</span>`;
        } else if (payload.type === 'end') {
          applySnapshot(payload.job);
          closeJobStream();
          refreshJobs();
          if (payload.job.status === 'success') toast('操作执行成功', 'success');
          else if (payload.job.status === 'failed') toast('操作执行失败：' + (payload.job.error || '请查看日志'), 'error');
          else if (payload.job.status === 'cancelled') toast('操作已取消', 'info');
          if (payload.job.status === 'success' && (payload.job.type === 'install' || payload.job.type === 'deploy' || payload.job.type === 'uninstall')) {
            setTimeout(() => detectAll(true), 600);
          }
          if (!DEMO && payload.job.status === 'success' && payload.job.type === 'image-export') {
            const info = payload.job.result || {};
            if (info.downloadUrl && info.file) downloadJobFile();
          }
          notifyEnd(payload.job);
        }
      };
      jobStream.onerror = () => {
        closeJobStream();
      };
    } catch (err) {
      console.warn(err);
    }
  }

  function closeJobStream() {
    if (jobStream) { try { jobStream.close(); } catch (_) {} jobStream = null; }
  }

  load();
  return modal;
}
