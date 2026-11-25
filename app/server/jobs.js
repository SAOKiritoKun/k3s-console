'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { HttpError } = require('./util');

let seq = 0;

class Job extends EventEmitter {
  constructor(type, title, meta = {}) {
    super();
    this.setMaxListeners(100);
    this.id = 'job_' + Date.now().toString(36) + '_' + (++seq) + '_' + crypto.randomBytes(3).toString('hex');
    this.type = type;
    this.title = title;
    this.meta = meta;
    this.status = 'running';
    this.steps = [];
    this.logs = [];
    this.result = null;
    this.error = null;
    this.createdAt = new Date().toISOString();
    this.startedAt = this.createdAt;
    this.finishedAt = null;
    this.cancelled = false;
    this._kills = new Set();
    this._stepSeq = 0;
  }

  static fromJSON(data) {
    if (!data || !data.id) return null;
    const job = new Job(data.type || 'task', data.title || data.id, data.meta || {});
    job.id = String(data.id);
    job.status = data.status || 'failed';
    job.steps = Array.isArray(data.steps) ? data.steps : [];
    job.logs = Array.isArray(data.logs) ? data.logs : [];
    job.result = data.result === undefined ? null : data.result;
    job.error = data.error === undefined ? null : data.error;
    job.createdAt = data.createdAt || job.createdAt;
    job.startedAt = data.startedAt || job.createdAt;
    job.finishedAt = data.finishedAt || null;
    job.cancelled = job.status === 'cancelled';
    job._stepSeq = job.steps.reduce((max, step) => Math.max(max, Number(step && step.id) || 0), 0);
    return job;
  }

  toJSON() {
    return {
      id: this.id,
      type: this.type,
      title: this.title,
      meta: this.meta,
      status: this.status,
      steps: this.steps,
      logs: this.logs,
      result: this.result,
      error: this.error,
      createdAt: this.createdAt,
      startedAt: this.startedAt,
      finishedAt: this.finishedAt
    };
  }

  pushEvent(payload) {
    try {
      this.emit('event', payload);
    } catch (err) {
      // 事件监听器异常不能影响操作
    }
  }

  log(text, level = 'info') {
    const raw = String(text === undefined || text === null ? '' : text);
    const lines = raw.replace(/\r\n/g, '\n').split('\n');
    for (const line of lines) {
      if (line === '' && lines.length > 1) continue;
      const entry = { ts: new Date().toISOString(), level, text: line };
      this.logs.push(entry);
      if (this.logs.length > 8000) this.logs.splice(0, this.logs.length - 8000);
      this.pushEvent({ type: 'log', entry });
    }
  }

  startStep(title) {
    const step = {
      id: ++this._stepSeq,
      title,
      status: 'running',
      detail: '',
      progress: null,
      startedAt: new Date().toISOString(),
      finishedAt: null
    };
    this.steps.push(step);
    this.pushEvent({ type: 'step', step });
    return step;
  }

  // progress 传 0-100 表示真实完成度（目前只有导出下载步骤有），其余步骤保持 null
  updateStep(step, detail, progress) {
    if (!step) return;
    step.detail = detail || '';
    if (progress !== undefined) {
      step.progress = Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : null;
    }
    this.pushEvent({ type: 'step', step });
  }

  finishStep(step, status = 'success', detail = '') {
    if (!step) return;
    step.status = status;
    step.detail = detail || step.detail;
    step.finishedAt = new Date().toISOString();
    this.pushEvent({ type: 'step', step });
  }

  registerKill(fn) {
    if (typeof fn === 'function') this._kills.add(fn);
  }

  unregisterKill(fn) {
    this._kills.delete(fn);
  }

  abort() {
    if (this.status !== 'running') return false;
    this.cancelled = true;
    this.log('收到取消请求，正在停止当前步骤…', 'warn');
    for (const kill of this._kills) {
      try { kill(); } catch (_) { /* ignore */ }
    }
    this._kills.clear();
    this.pushEvent({ type: 'status', status: 'cancelling' });
    return true;
  }

  checkCancelled() {
    if (this.cancelled) throw new HttpError(499, '操作已取消');
  }

  finish(status, result, error) {
    if (this.status === 'success' || this.status === 'failed' || this.status === 'cancelled') return;
    this.status = status;
    this.result = result === undefined ? null : result;
    this.error = error ? error.message || String(error) : null;
    this.finishedAt = new Date().toISOString();
    if (error) this.log(`操作失败：${this.error}`, 'error');
    if (this.cancelled && status === 'failed') this.status = 'cancelled';
    // 任务结束后不再有执行体，残留的 running 步骤要收尾，否则窗口里会一直转圈
    const tail = this.status === 'cancelled' ? '已取消' : this.status === 'success' ? '已完成' : (this.error || '未完成');
    for (const step of this.steps) {
      if (step.status !== 'running') continue;
      step.status = this.status === 'success' ? 'success' : 'failed';
      step.detail = this.status === 'cancelled' ? '已取消' : (step.detail || tail);
      step.finishedAt = this.finishedAt;
      this.pushEvent({ type: 'step', step });
    }
    this.pushEvent({ type: 'end', job: this.toJSON() });
  }
}

class JobManager {
  constructor(limit = 50, options = {}) {
    this.jobs = new Map();
    this.summaries = new Map();
    this.files = new Map();
    this.limit = limit;
    this.dir = options.dir || '';
    if (this.dir) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        this._load();
      } catch (err) {
        console.warn(`[操作记录] 无法初始化目录 ${this.dir}：${err.message}`);
      }
    }
  }

  _summary(job) {
    // 列表只返回摘要，避免轮询时反复传输大量日志与可能含 token 的操作结果
    return {
      id: job.id,
      type: job.type,
      title: job.title,
      meta: job.meta,
      status: job.status,
      steps: job.steps,
      error: job.error,
      logCount: job.logs.length,
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt
    };
  }

  _recordPath(id) {
    if (!this.dir) return '';
    if (!/^job_[A-Za-z0-9_-]+$/.test(String(id))) return '';
    return path.join(this.dir, `${id}.json`);
  }

  _load() {
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((name) => name.endsWith('.json'));
    } catch (err) {
      console.warn(`[操作记录] 无法读取目录 ${this.dir}：${err.message}`);
      return;
    }
    for (const name of names) {
      const file = path.join(this.dir, name);
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const job = Job.fromJSON(data);
        if (!job) continue;
        // 服务重启时，之前处于 running 的记录已经不可能继续执行，标记为中断。
        if (job.status === 'running' || job.status === 'cancelling') {
          job.status = 'failed';
          job.error = '服务重启，操作未完成';
          job.finishedAt = new Date().toISOString();
          job.log('服务重启，操作未完成，已自动标记为失败', 'error');
          this._write(job, file);
        }
        this.summaries.set(job.id, this._summary(job));
        this.files.set(job.id, file);
      } catch (err) {
        console.warn(`[操作记录] 跳过无法读取的记录 ${name}：${err.message}`);
      }
    }
  }

  _write(job, knownFile) {
    if (!this.dir) return;
    const file = knownFile || this.files.get(job.id) || this._recordPath(job.id);
    if (!file) return;
    const tmp = `${file}.tmp`;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const data = JSON.stringify(job.toJSON());
      fs.writeFileSync(tmp, data, 'utf8');
      try {
        fs.renameSync(tmp, file);
      } catch (_) {
        fs.writeFileSync(file, data, 'utf8');
        try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
      }
      this.files.set(job.id, file);
      this.summaries.set(job.id, this._summary(job));
    } catch (err) {
      console.warn(`[操作记录] 保存记录 ${job.id} 失败：${err.message}`);
      try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
    }
  }

  create(type, title, meta) {
    const job = new Job(type, title, meta);
    this.jobs.set(job.id, job);
    this.files.set(job.id, this._recordPath(job.id));
    this.summaries.set(job.id, this._summary(job));
    this._write(job);
    this.prune();
    return job;
  }

  // 用给定的 job 执行任务并落盘记录。用于「先创建 job 让前端打开跟踪窗口、
  // 稍后由另一个请求（例如上传流）真正开始执行」的场景。
  async runJob(job, fn) {
    try {
      const result = await fn(job);
      // 取消请求可能来得太晚（工作已经全部完成），此时按实际结果记为成功，
      // 避免出现“所有步骤都成功、状态却是已取消”的矛盾记录。
      if (job.cancelled) job.log('取消请求到达时操作已完成，按实际结果记为成功', 'warn');
      job.finish('success', result);
      return result;
    } catch (err) {
      if (job.cancelled || (err && err.status === 499)) {
        job.finish('cancelled', null, null);
      } else {
        job.finish('failed', null, err);
      }
      throw err;
    } finally {
      this._write(job);
    }
  }

  // 直接结束一个 job（超时、外部中断等没有执行体的情况）
  settle(job, status, result, error) {
    if (!job) return job;
    job.finish(status, result, error);
    this._write(job);
    return job;
  }

  // 任务结束后仍可能需要改结果（例如导出 tar 下载完成、临时文件已清理）：落盘并广播快照，
  // 让还开着的任务窗口同步更新下载按钮状态。
  save(job, patch = null) {
    if (!job) return job;
    if (patch && job.result && typeof job.result === 'object') Object.assign(job.result, patch);
    this._write(job);
    job.pushEvent({ type: 'snapshot', job: job.toJSON() });
    return job;
  }

  run(type, title, meta, fn) {
    const job = this.create(type, title, meta);
    setImmediate(() => {
      this.runJob(job, fn).catch(() => { /* 失败状态已写入记录 */ });
    });
    return job;
  }

  get(id) {
    const job = this.jobs.get(id);
    if (job) return job;
    const file = this.files.get(id) || this._recordPath(id);
    if (!file) throw new HttpError(404, `找不到操作记录：${id}`);
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      const loaded = Job.fromJSON(data);
      if (!loaded) throw new Error('记录格式无效');
      this.jobs.set(loaded.id, loaded);
      this.files.set(loaded.id, file);
      this.summaries.set(loaded.id, this._summary(loaded));
      this.prune();
      return loaded;
    } catch (err) {
      if (err instanceof HttpError) throw err;
      throw new HttpError(404, `找不到操作记录：${id}`);
    }
  }

  list() {
    return Array.from(this.summaries.values())
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  }

  // 删除一条操作记录：内存里的任务对象 + 记录文件一起清掉
  remove(id) {
    const job = this.jobs.get(id) || null;
    this.jobs.delete(id);
    this.summaries.delete(id);
    const file = this.files.get(id) || this._recordPath(id);
    this.files.delete(id);
    if (file) {
      try { fs.rmSync(file, { force: true }); } catch (_) { /* ignore */ }
    }
    return job;
  }

  // 清空所有操作记录（内存 + 磁盘），目录里可能还有没加载进内存的记录，一并删除
  clearAll() {
    for (const id of Array.from(this.jobs.keys())) {
      this.remove(id);
    }
    this.jobs.clear();
    this.summaries.clear();
    this.files.clear();
    if (!this.dir) return;
    let names = [];
    try {
      names = fs.readdirSync(this.dir).filter((name) => name.endsWith('.json'));
    } catch (_) {
      return;
    }
    for (const name of names) {
      try { fs.rmSync(path.join(this.dir, name), { force: true }); } catch (_) { /* ignore */ }
    }
  }

  prune() {
    if (this.jobs.size <= this.limit) return;
    const finished = Array.from(this.jobs.values())
      .filter((job) => job.status !== 'running')
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    while (this.jobs.size > this.limit && finished.length) {
      const job = finished.shift();
      this.jobs.delete(job.id);
      this.files.delete(job.id);
    }
  }
}

module.exports = { Job, JobManager };
