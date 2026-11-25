'use strict';

const crypto = require('crypto');
const { HttpError } = require('./util');

const MAX_OUTPUT = 160 * 1024;

function trimOutput(text) {
  return text.length > MAX_OUTPUT ? text.slice(text.length - MAX_OUTPUT) : text;
}

class TerminalManager {
  constructor(options = {}) {
    this.sessions = new Map();
    this.maxSessions = Number(options.maxSessions) || 8;
    this.idleMs = Number(options.idleMs) || 30 * 60 * 1000;
    this.reapTimer = setInterval(() => this.prune(), 60000);
    this.reapTimer.unref();
  }

  _prepare() {
    this.prune();
    for (const [id, session] of this.sessions) {
      if (session.status !== 'running' && session.clients.size === 0) this.sessions.delete(id);
    }
    if (this.sessions.size >= this.maxSessions) {
      throw new HttpError(429, `同时打开的终端过多（上限 ${this.maxSessions} 个），请先关闭其他终端`);
    }
  }

  async open(kube, ctx, host, namespace, pod, container) {
    this._prepare();
    const shell = await kube.openPodShell(host, namespace, pod, container, ctx);
    return this._register(host, { namespace, pod, container }, shell);
  }

  // 以 SSH 客户端身份打开服务器上的登录 shell，和容器终端复用同一套会话/SSE 通道。
  async openHost(transport, host) {
    this._prepare();
    const shell = await transport.openSshShell(host);
    return this._register(host, { kind: 'host' }, shell);
  }

  _register(host, meta, shell) {
    const id = crypto.randomBytes(9).toString('hex');
    const session = {
      id,
      kind: meta.kind || 'pod',
      hostId: host.id,
      hostName: host.name || host.host || host.id,
      namespace: meta.namespace || '',
      pod: meta.pod || '',
      container: meta.container || '',
      tty: !!shell.tty,
      cwdFile: shell.cwdFile || null,
      output: '',
      status: 'running',
      exitCode: null,
      createdAt: Date.now(),
      lastAt: Date.now(),
      clients: new Set(),
      detachedTimer: null,
      shell,
      finishTimer: null,
      deleteTimer: null
    };
    this.sessions.set(id, session);

    shell.onData((chunk) => {
      if (session.status !== 'running') return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      session.lastAt = Date.now();
      session.output = trimOutput(session.output + text);
      this.broadcast(session, { type: 'output', data: text });
    });
    shell.onError((err) => {
      if (session.status !== 'running') return;
      const message = (err && err.message) || '终端连接异常';
      session.output = trimOutput(session.output + `\n[终端错误] ${message}\n`);
      this.broadcast(session, { type: 'error', message });
      this.finish(session, 1);
    });
    shell.onClose((code) => {
      if (session.status !== 'running') return;
      this.finish(session, code);
    });
    return session;
  }

  get(id) {
    const session = this.sessions.get(String(id || ''));
    if (!session) throw new HttpError(404, '终端会话不存在或已过期');
    return session;
  }

  attach(id, req, res) {
    const session = this.get(id);
    session.lastAt = Date.now();
    if (session.detachedTimer) {
      clearTimeout(session.detachedTimer);
      session.detachedTimer = null;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
    const send = (payload) => {
      if (res.writableEnded || res.destroyed) return false;
      try {
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        return true;
      } catch (_) {
        return false;
      }
    };
    const snapshotOk = send({
      type: 'snapshot',
      session: {
        id: session.id,
        kind: session.kind,
        hostId: session.hostId,
        hostName: session.hostName,
        namespace: session.namespace,
        pod: session.pod,
        container: session.container,
        tty: session.tty,
        status: session.status,
        exitCode: session.exitCode
      },
      output: session.output
    });
    if (!snapshotOk) {
      this.scheduleDetached(session);
      try { res.end(); } catch (_) { /* ignore */ }
      return;
    }
    if (session.status !== 'running') {
      send({ type: 'exit', code: session.exitCode });
      res.end();
      return;
    }

    const client = { res };
    session.clients.add(client);
    let cleaned = false;
    const heartbeat = setInterval(() => {
      if (res.writableEnded || res.destroyed) {
        cleanup();
        return;
      }
      try { res.write(': keepalive\n\n'); } catch (_) { cleanup(); }
    }, 15000);
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      clearInterval(heartbeat);
      session.clients.delete(client);
      // 浏览器关闭页面时 SSE 会断开；给短暂重连窗口后回收远端 PTY，避免会话泄漏。
      if (session.status === 'running' && session.clients.size === 0) this.scheduleDetached(session);
    };
    res.on('close', cleanup);
    res.on('error', cleanup);
    req.on('error', cleanup);
    req.on('close', cleanup);
  }

  scheduleDetached(session) {
    if (session.detachedTimer || session.status !== 'running') return;
    session.detachedTimer = setTimeout(() => {
      session.detachedTimer = null;
      if (session.status !== 'running' || session.clients.size > 0) return;
      this.finish(session, null);
      try { session.shell.close(); } catch (_) { /* ignore */ }
    }, 60000);
    session.detachedTimer.unref();
  }

  write(id, data) {
    const session = this.get(id);
    if (session.status !== 'running') throw new HttpError(409, '终端已结束');
    const text = String(data === undefined || data === null ? '' : data);
    if (text.length > 262144) throw new HttpError(413, '单次输入过长');
    session.lastAt = Date.now();
    const accepted = session.shell.write(text);
    if (!accepted) throw new HttpError(409, '终端已关闭，无法继续输入');
    return true;
  }

  resize(id, cols, rows) {
    const session = this.get(id);
    if (session.status !== 'running') throw new HttpError(409, '终端已结束');
    const c = Math.max(2, Math.min(500, Math.floor(Number(cols) || 0)));
    const r = Math.max(2, Math.min(300, Math.floor(Number(rows) || 0)));
    if (typeof session.shell.resize !== 'function') return false;
    const resized = session.shell.resize(r, c);
    if (resized) {
      session.cols = c;
      session.rows = r;
    }
    session.lastAt = Date.now();
    return !!resized;
  }

  close(id) {
    const session = this.get(id);
    if (session.status === 'running') {
      this.finish(session, null);
      try { session.shell.close(); } catch (_) { /* ignore */ }
    }
    return true;
  }

  finish(session, code) {
    if (session.status !== 'running') return;
    session.status = 'closed';
    session.exitCode = code;
    if (session.shell && typeof session.shell.cleanup === 'function') {
      try { session.shell.cleanup(); } catch (_) { /* ignore */ }
    }
    if (session.detachedTimer) {
      clearTimeout(session.detachedTimer);
      session.detachedTimer = null;
    }
    this.broadcast(session, { type: 'exit', code });
    for (const client of session.clients) {
      if (!client.res.writableEnded) {
        try { client.res.end(); } catch (_) { /* ignore */ }
      }
    }
    session.clients.clear();
    session.deleteTimer = setTimeout(() => this.sessions.delete(session.id), 60000);
    session.deleteTimer.unref();
  }

  broadcast(session, payload) {
    for (const client of [...session.clients]) {
      if (client.res.writableEnded || client.res.destroyed) {
        session.clients.delete(client);
        continue;
      }
      try {
        client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch (_) {
        session.clients.delete(client);
      }
    }
  }

  prune() {
    const now = Date.now();
    for (const session of [...this.sessions.values()]) {
      if (session.status !== 'running') {
        if (session.deleteTimer) continue;
        if (now - session.lastAt > 60000) this.sessions.delete(session.id);
        continue;
      }
      if (now - session.lastAt > this.idleMs) {
        this.finish(session, null);
        try { session.shell.close(); } catch (_) { /* ignore */ }
      }
    }
  }

  stats() {
    return {
      total: this.sessions.size,
      running: [...this.sessions.values()].filter((s) => s.status === 'running').length
    };
  }
}

module.exports = { TerminalManager };
