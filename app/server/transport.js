'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { HttpError, expandHome, b64, scriptCommand, sq } = require('./util');

let SshClient = null;
let ssh2LoadError = null;
try {
  // ssh2 为可选依赖：没有安装时，密码认证不可用，但其他功能仍可使用
  SshClient = require('ssh2').Client;
} catch (err) {
  ssh2LoadError = err;
}

const DEFAULT_KEY_PATHS = ['~/.ssh/id_ed25519', '~/.ssh/id_rsa'];

function sftpCall(channel, method, ...args) {
  return new Promise((resolve, reject) => {
    if (!channel || typeof channel[method] !== 'function') {
      reject(new HttpError(502, `SFTP 不支持操作：${method}`));
      return;
    }
    channel[method](...args, (err, value) => {
      if (err) reject(err);
      else resolve(value);
    });
  });
}

function sftpIsMissing(err) {
  return /no such file|not found|no such path/i.test(String((err && err.message) || ''));
}

function sftpError(action, target, err) {
  const message = String((err && err.message) || err || '未知错误');
  if (sftpIsMissing(err)) return new HttpError(404, `${action}失败：路径不存在（${target}）`, message);
  if (/permission denied|access denied/i.test(message)) {
    return new HttpError(403, `${action}失败：没有权限（${target}）`, message);
  }
  return new HttpError(502, `${action}失败：${message}`, message);
}

function sftpResolvePath(input, home) {
  let value = String(input === undefined || input === null ? '' : input);
  if (!value || value === '~') value = home || '/';
  else if (value.startsWith('~/')) value = path.posix.join(home || '/', value.slice(2));
  else if (!value.startsWith('/')) value = path.posix.join(home || '/', value);
  const normalized = path.posix.normalize(value);
  return normalized || '/';
}

function sftpSafeName(value) {
  const name = String(value === undefined || value === null ? '' : value);
  if (!name || name === '.' || name === '..' || /[\/\\\0]/.test(name)) {
    throw new HttpError(400, '文件名不合法');
  }
  if (Buffer.byteLength(name, 'utf8') > 255) throw new HttpError(400, '文件名过长');
  return name;
}

function sftpModeText(mode, attrs) {
  const value = Number(mode) || 0;
  let type = '-';
  if (attrs && typeof attrs.isDirectory === 'function' && attrs.isDirectory()) type = 'd';
  else if (attrs && typeof attrs.isSymbolicLink === 'function' && attrs.isSymbolicLink()) type = 'l';
  else if (attrs && typeof attrs.isBlockDevice === 'function' && attrs.isBlockDevice()) type = 'b';
  else if (attrs && typeof attrs.isCharacterDevice === 'function' && attrs.isCharacterDevice()) type = 'c';
  else if (attrs && typeof attrs.isFIFO === 'function' && attrs.isFIFO()) type = 'p';
  else if (attrs && typeof attrs.isSocket === 'function' && attrs.isSocket()) type = 's';
  let text = type;
  const bits = [
    [0o400, 'r'], [0o200, 'w'], [0o100, 'x'],
    [0o040, 'r'], [0o020, 'w'], [0o010, 'x'],
    [0o004, 'r'], [0o002, 'w'], [0o001, 'x']
  ];
  for (const [bit, char] of bits) text += value & bit ? char : '-';
  return text;
}

function sftpEntryType(attrs) {
  if (!attrs) return 'file';
  if (typeof attrs.isDirectory === 'function' && attrs.isDirectory()) return 'dir';
  if (typeof attrs.isSymbolicLink === 'function' && attrs.isSymbolicLink()) return 'link';
  return 'file';
}


function logDebug(...args) {
  if (process.env.DSH_DEBUG) console.error('[transport]', ...args);
}

// 把命令输出按行推给调用方，用于把远程命令的实时输出写进操作日志。
function lineSplitter(onLine, streamName) {
  let buffer = '';
  const emit = (line) => {
    const text = String(line).replace(/\r$/, '');
    if (!text.trim()) return;
    try { onLine(text, streamName); } catch (_) { /* 日志回调异常不能影响命令执行 */ }
  };
  return {
    push(chunk) {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        emit(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
        idx = buffer.indexOf('\n');
      }
      // 极端情况下（没有换行的超长输出）避免缓冲区无限增长
      if (buffer.length > 8192) {
        emit(buffer);
        buffer = '';
      }
    },
    end() {
      if (buffer) emit(buffer);
      buffer = '';
    }
  };
}

class Transport {
  constructor(config) {
    this.config = config;
    this.clients = new Map();
  }

  setConfig(config) {
    if (this.config === config) return;
    this.config = config;
    // 配置可能改变了密钥、超时或 known_hosts 策略，旧连接不能继续复用。
    this.dispose();
  }

  resetHost(id) {
    this._dropClient(String(id || ''));
  }

  get sshConfig() {
    return (this.config && this.config.ssh) || {};
  }

  timeoutFor(opts) {
    const fallback = Number((this.config && this.config.app && this.config.app.commandTimeoutMs) || 60000);
    return Math.max(1000, Number(opts && opts.timeout) || fallback);
  }

  async execScript(host, script, opts = {}) {
    const transport = host.transport || 'ssh';
    const inner = scriptCommand(script);
    const command = opts.asRoot
      ? `if [ "$(id -u)" -eq 0 ]; then ${inner}; else sudo -n sh -c ${sq(inner)}; fi`
      : inner;
    if (transport === 'ssh') {
      return this._execSsh(host, command, opts);
    }
    if (transport === 'local') {
      this._assertLocalSupported();
      return this._execLocal(['/bin/sh', '-lc', command], {}, null, opts);
    }
    throw new HttpError(400, `transport=${transport} 不支持执行远程脚本`);
  }

  async execCommand(host, command, opts = {}) {
    const transport = host.transport || 'ssh';
    const argv = Array.isArray(command.argv) ? command.argv : [];
    if (!argv.length) throw new HttpError(500, '空命令');
    const env = command.env || {};
    const input = command.input === undefined ? null : command.input;

    if (transport === 'ssh') {
      const parts = [];
      for (const [key, value] of Object.entries(env)) {
        parts.push(`${key}=${sq(value)}`);
      }
      parts.push(...argv.map(sq));
      return this._execSsh(host, parts.join(' '), { ...opts, input });
    }
    if (transport === 'local') {
      this._assertLocalSupported();
      return this._execLocal(argv, env, input, opts);
    }
    if (transport === 'kubeconfig') {
      // kubeconfig 模式本来就是在控制端跑 kubectl，三端都合法
      return this._execLocal(argv, env, input, opts);
    }
    throw new HttpError(400, `不支持的 transport：${transport}`);
  }

  // ------------------------------------------------------------------ SSH

  async putFile(host, localPath, remotePath, opts = {}) {
    const transport = host.transport || 'ssh';
    if (transport === 'local') {
      this._assertLocalSupported();
      fs.mkdirSync(path.dirname(remotePath), { recursive: true });
      await fs.promises.copyFile(localPath, remotePath);
      if (opts.mode !== undefined) {
        try { await fs.promises.chmod(remotePath, opts.mode); } catch (_) { /* ignore */ }
      }
      return;
    }
    if (transport !== 'ssh') {
      throw new HttpError(400, `transport=${transport} 不支持上传文件`);
    }
    if (!SshClient) {
      throw new HttpError(
        503,
        '缺少 ssh2 依赖，无法上传离线安装包。请在项目目录执行 `npm install`。',
        ssh2LoadError ? String(ssh2LoadError.message) : null
      );
    }
    const client = await this._getClient(host);
    return new Promise((resolve, reject) => {
      let settled = false;
      let sftp = null;
      const timeout = Number(opts.timeout) || 30 * 60 * 1000;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try { if (sftp) sftp.end(); } catch (_) { /* ignore */ }
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        finish(new HttpError(504, `SFTP 上传超时（${Math.round(timeout / 1000)}s）`));
      }, timeout);
      client.sftp((err, channel) => {
        if (settled) {
          try { if (channel) channel.end(); } catch (_) { /* ignore */ }
          return;
        }
        if (err) {
          finish(new HttpError(502, `SSH 无法打开 SFTP 通道：${err.message}`));
          return;
        }
        sftp = channel;
        const options = {};
        if (opts.mode !== undefined) options.mode = opts.mode;
        if (typeof opts.onProgress === 'function') {
          options.step = (transferred, _chunk, total) => opts.onProgress(transferred, total);
        }
        channel.fastPut(localPath, remotePath, options, (putErr) => {
          if (putErr) finish(new HttpError(502, `SFTP 上传失败：${putErr.message}`));
          else finish(null);
        });
      });
    });
  }

  // ------------------------------------------------------------------ SFTP 文件管理

  _assertSftpHost(host) {
    if ((host.transport || 'ssh') !== 'ssh') {
      throw new HttpError(400, '只有 SSH 接入方式支持 SFTP 文件管理');
    }
  }

  async _openSftp(host) {
    this._assertSftpHost(host);
    if (!SshClient) {
      throw new HttpError(
        503,
        '缺少 ssh2 依赖，无法使用 SFTP。请在项目目录执行 `npm install`。',
        ssh2LoadError ? String(ssh2LoadError.message) : null
      );
    }
    const client = await this._getClient(host);
    return new Promise((resolve, reject) => {
      client.sftp((err, channel) => {
        if (err) {
          reject(new HttpError(502, `SSH 无法打开 SFTP 通道：${err.message}`));
          return;
        }
        // 避免通道级错误变成未处理的 EventEmitter error；具体操作各自监听回调。
        channel.on('error', () => { /* 由具体操作处理 */ });
        resolve({ client, sftp: channel });
      });
    });
  }

  async _sftpHome(sftp) {
    try {
      return await sftpCall(sftp, 'realpath', '.');
    } catch (_) {
      return '/';
    }
  }

  async sftpList(host, rawPath = '') {
    const { sftp } = await this._openSftp(host);
    try {
      const home = await this._sftpHome(sftp);
      const wanted = sftpResolvePath(rawPath, home);
      let resolved;
      try {
        resolved = await sftpCall(sftp, 'realpath', wanted);
      } catch (err) {
        throw sftpError('读取目录', wanted, err);
      }
      let stats;
      try {
        stats = await sftpCall(sftp, 'stat', resolved);
      } catch (err) {
        throw sftpError('读取目录', resolved, err);
      }
      if (!stats.isDirectory()) throw new HttpError(400, `这不是目录：${resolved}`);
      let rawEntries;
      try {
        rawEntries = await sftpCall(sftp, 'readdir', resolved);
      } catch (err) {
        throw sftpError('读取目录', resolved, err);
      }
      const entries = (Array.isArray(rawEntries) ? rawEntries : [])
        .map((entry) => {
          const attrs = entry.attrs || {};
          const name = String(entry.filename || '');
          const type = sftpEntryType(attrs);
          return {
            name,
            path: path.posix.join(resolved, name),
            type,
            size: Number.isFinite(attrs.size) ? attrs.size : (type === 'dir' ? 0 : null),
            mode: Number.isFinite(attrs.mode) ? attrs.mode : null,
            modeText: sftpModeText(attrs.mode, attrs),
            mtime: attrs.mtime ? new Date(attrs.mtime * 1000).toISOString() : null,
            uid: attrs.uid,
            gid: attrs.gid
          };
        })
        .filter((entry) => entry.name && entry.name !== '.' && entry.name !== '..');
      entries.sort((a, b) => {
        const dirRank = (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1);
        return dirRank || a.name.localeCompare(b.name, 'zh-CN', { numeric: true, sensitivity: 'base' });
      });
      return {
        path: resolved,
        home,
        parent: resolved === '/' ? '/' : path.posix.dirname(resolved),
        entries
      };
    } finally {
      try { sftp.end(); } catch (_) { /* ignore */ }
    }
  }

  async sftpDownload(host, rawPath, res) {
    const { sftp } = await this._openSftp(host);
    try {
      const home = await this._sftpHome(sftp);
      const remotePath = sftpResolvePath(rawPath, home);
      let stats;
      try {
        stats = await sftpCall(sftp, 'stat', remotePath);
      } catch (err) {
        throw sftpError('下载', remotePath, err);
      }
      if (stats.isDirectory()) throw new HttpError(400, `不能下载目录：${remotePath}`);
      const name = path.posix.basename(remotePath) || 'download';
      const asciiName = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
      const encodedName = encodeURIComponent(name).replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
      let stream;
      try {
        stream = sftp.createReadStream(remotePath);
      } catch (err) {
        throw new HttpError(502, `无法打开文件：${err.message}`, err.message);
      }
      await new Promise((resolve, reject) => {
        let settled = false;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          if (err) {
            try { stream.destroy(); } catch (_) { /* ignore */ }
            if (res.headersSent) {
              try { res.destroy(err); } catch (_) { /* ignore */ }
              resolve();
            } else {
              reject(err);
            }
          } else {
            resolve();
          }
        };
        stream.on('error', (err) => {
          finish(new HttpError(502, `读取远程文件失败：${err.message}`, err.message));
        });
        stream.on('close', () => finish(null));
        res.on('close', () => {
          if (!res.writableEnded) {
            try { stream.destroy(); } catch (_) { /* ignore */ }
          }
        });
        const headers = {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="${asciiName}"; filename*=UTF-8''${encodedName}`,
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff'
        };
        if (Number.isFinite(stats.size) && stats.size >= 0) headers['Content-Length'] = stats.size;
        try {
          res.writeHead(200, headers);
          stream.pipe(res);
        } catch (err) {
          finish(new HttpError(502, `发送文件失败：${err.message}`, err.message));
        }
      });
    } finally {
      try { sftp.end(); } catch (_) { /* ignore */ }
    }
  }

  async sftpUpload(host, req, dir, name, opts = {}) {
    const filename = sftpSafeName(name);
    const { sftp } = await this._openSftp(host);
    try {
      const home = await this._sftpHome(sftp);
      const remoteDir = sftpResolvePath(dir, home);
      let dirStats;
      try {
        dirStats = await sftpCall(sftp, 'stat', remoteDir);
      } catch (err) {
        throw sftpError('上传', remoteDir, err);
      }
      if (!dirStats.isDirectory()) throw new HttpError(400, `目标不是目录：${remoteDir}`);
      const target = path.posix.join(remoteDir, filename);

      let existing = null;
      try {
        existing = await sftpCall(sftp, 'stat', target);
      } catch (err) {
        if (!sftpIsMissing(err)) throw sftpError('上传', target, err);
      }
      if (existing && existing.isDirectory()) throw new HttpError(400, `同名目录已存在：${filename}`);
      if (existing && !opts.overwrite) {
        throw new HttpError(409, `远程目录中已存在文件「${filename}」，未允许覆盖`);
      }
      if (req.aborted) throw new HttpError(400, '上传已中断');

      const bytes = await new Promise((resolve, reject) => {
        let settled = false;
        let received = 0;
        let out = null;
        const total = Number(opts.total || (req.headers && req.headers['content-length'])) || 0;
        const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
        const finish = (err, value) => {
          if (settled) return;
          settled = true;
          if (err) {
            try { if (out) req.unpipe(out); } catch (_) { /* ignore */ }
            try { if (out) out.destroy(); } catch (_) { /* ignore */ }
            try { req.resume(); } catch (_) { /* ignore */ }
            reject(err);
          } else {
            resolve(value);
          }
        };
        try {
          out = sftp.createWriteStream(target, {
            mode: existing && Number.isFinite(existing.mode) ? existing.mode & 0o777 : 0o644
          });
        } catch (err) {
          finish(new HttpError(502, `无法创建远程文件：${err.message}`, err.message));
          return;
        }
        out.on('error', (err) => {
          finish(new HttpError(502, `写入远程文件失败：${err.message}`, err.message));
        });
        out.on('close', () => {
          if (!req.readableEnded) finish(new HttpError(400, '上传已中断'));
          else finish(null, received);
        });
        if (opts.onStart) {
          try {
            opts.onStart(() => finish(new HttpError(499, '上传已取消')));
          } catch (_) { /* ignore */ }
        }
        req.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) {
            try { onProgress({ received, total }); } catch (_) { /* 进度回调异常不影响上传 */ }
          }
        });
        req.on('aborted', () => finish(new HttpError(400, '上传已中断')));
        req.on('error', (err) => finish(new HttpError(400, `读取上传内容失败：${err.message}`, err.message)));
        try {
          req.pipe(out);
        } catch (err) {
          finish(new HttpError(400, `读取上传内容失败：${err.message}`, err.message));
        }
      });
      return { name: filename, path: target, size: bytes };
    } finally {
      try { sftp.end(); } catch (_) { /* ignore */ }
    }
  }

  // 把远程文件下载到控制端本地文件，支持进度回调与取消（用于导出镜像 tar 等需要跟踪的场景）。
  async downloadToFile(host, rawPath, localPath, opts = {}) {
    if ((host.transport || 'ssh') !== 'ssh') {
      throw new HttpError(400, '只有 SSH 接入方式支持下载远程文件');
    }
    const { sftp } = await this._openSftp(host);
    const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
    let stream = null;
    try {
      const home = await this._sftpHome(sftp);
      const remotePath = sftpResolvePath(rawPath, home);
      let stats;
      try {
        stats = await sftpCall(sftp, 'stat', remotePath);
      } catch (err) {
        throw sftpError('下载', remotePath, err);
      }
      if (stats.isDirectory()) throw new HttpError(400, `不能下载目录：${remotePath}`);
      const total = Number(stats.size) || 0;
      await new Promise((resolve, reject) => {
        let settled = false;
        let received = 0;
        let out = null;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          if (err) {
            try { if (stream) stream.destroy(); } catch (_) { /* ignore */ }
            try { if (out) out.destroy(); } catch (_) { /* ignore */ }
            try { fs.rmSync(localPath, { force: true }); } catch (_) { /* ignore */ }
            reject(err);
          } else {
            resolve();
          }
        };
        try {
          stream = sftp.createReadStream(remotePath);
          out = fs.createWriteStream(localPath);
        } catch (err) {
          finish(new HttpError(502, `无法读取远程文件：${err.message}`, err.message));
          return;
        }
        if (opts.onStart) {
          try {
            opts.onStart(() => finish(new HttpError(499, '操作已取消')));
          } catch (_) { /* ignore */ }
        }
        stream.on('data', (chunk) => {
          received += chunk.length;
          if (onProgress) {
            try { onProgress({ received, total }); } catch (_) { /* ignore */ }
          }
        });
        stream.on('error', (err) => {
          finish(new HttpError(502, `读取远程文件失败：${err.message}`, err.message));
        });
        out.on('error', (err) => {
          finish(new HttpError(502, `写入本地文件失败：${err.message}`, err.message));
        });
        out.on('close', () => finish(null));
        stream.pipe(out);
      });
      return { path: localPath, size: Number(stats.size) || 0 };
    } finally {
      try { sftp.end(); } catch (_) { /* ignore */ }
    }
  }

  async _execSsh(host, command, opts = {}) {
    if (!SshClient) {
      throw new HttpError(
        503,
        '缺少 ssh2 依赖，SSH 功能不可用。请在项目目录执行 `npm install`（或改用 kubeconfig 模式）。',
        ssh2LoadError ? String(ssh2LoadError.message) : null
      );
    }
    const client = await this._getClient(host);
    try {
      return await this._execOnClient(client, command, opts);
    } catch (err) {
      if (err && err.code === 'CONNECTION_LOST') {
        this._dropClient(host.id);
        const fresh = await this._getClient(host);
        return this._execOnClient(fresh, command, opts);
      }
      throw err;
    }
  }

  async openSshExec(host, command, opts = {}) {
    if (!SshClient) {
      throw new HttpError(
        503,
        '缺少 ssh2 依赖，SSH 功能不可用。请在项目目录执行 `npm install`。',
        ssh2LoadError ? String(ssh2LoadError.message) : null
      );
    }
    const client = await this._getClient(host);
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = Math.max(1000, Number(opts.timeout) || 20000);
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new HttpError(504, `SSH 终端通道打开超时（${timeout}ms）`));
      }, timeout);
      const execOptions = {};
      if (opts.pty) {
        execOptions.pty = opts.pty === true
          ? { term: 'xterm-256color', rows: 30, cols: 120 }
          : opts.pty;
      }
      client.exec(command, execOptions, (err, stream) => {
        if (settled) {
          try { if (stream) stream.close(); } catch (_) { /* ignore */ }
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (err) {
          if (/Channel open failure|Administratively prohibited/i.test(err.message || '')) {
            reject(new HttpError(502, 'SSH 拒绝打开终端通道，可能达到 MaxSessions 限制'));
          } else {
            reject(new HttpError(502, `SSH 终端启动失败：${err.message}`));
          }
          return;
        }
        resolve(stream);
      });
    });
  }

  async readShellCwd(host, cwdFile) {
    const file = String(cwdFile || '');
    if (!/^\/tmp\/\.k3s-cwd-[a-f0-9]+\.pid$/.test(file)) {
      throw new HttpError(400, '终端目录标记无效');
    }
    const result = await this.execScript(
      host,
      `pid=$(cat ${sq(file)} 2>/dev/null) || exit 3; ` +
      `case "$pid" in ''|*[!0-9]*) exit 4;; esac; ` +
      `readlink -f /proc/$pid/cwd 2>/dev/null || readlink /proc/$pid/cwd 2>/dev/null || exit 5`,
      { timeout: 5000 }
    );
    const lines = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const cwd = lines[lines.length - 1] || '';
    if (result.code !== 0 || !cwd.startsWith('/')) {
      throw new HttpError(404, '无法读取终端当前目录');
    }
    return cwd;
  }

  async openSshShell(host) {
    const kind = host.transport || 'ssh';
    if (kind !== 'ssh') throw new HttpError(400, '只有 SSH 接入方式支持远程终端');
    // 把登录 shell 的 PID 留在远端临时文件里；之后可用 /proc/<pid>/cwd
    // 读取该终端“此刻”的工作目录，供 SFTP 跟随。
    const cwdFile = `/tmp/.k3s-cwd-${crypto.randomBytes(8).toString('hex')}.pid`;
    const command = `(umask 077; : > ${sq(cwdFile)}) 2>/dev/null; printf '%s' "$$" > ${sq(cwdFile)} 2>/dev/null; if [ -x "$SHELL" ]; then exec "$SHELL" -l; else exec /bin/sh -l; fi`;
    const stream = await this.openSshExec(host, command, { pty: true });
    let closed = false;
    return {
      tty: true,
      cwdFile,
      write: (data) => {
        if (closed) return false;
        try { stream.write(data); return true; } catch (_) { return false; }
      },
      close: () => {
        if (closed) return;
        closed = true;
        // end() 只发送 EOF，交互式 shell 可能仍挂在 PTY 上；必须 close() 关闭通道，
        // 让 sshd 结束 pty 并向登录 shell 发送 SIGHUP。
        try { stream.close(); } catch (_) {
          try { stream.end(); } catch (_) { /* ignore */ }
        }
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
      onError: (fn) => stream.on('error', fn),
      cleanup: () => {
        this.execScript(host, `rm -f ${sq(cwdFile)}`, { timeout: 3000 }).catch(() => {});
      }
    };
  }

  async _getClient(host) {
    const existing = this.clients.get(host.id);
    if (existing && existing.client && !existing.dead) return existing.client;
    if (existing && existing.promise && !existing.dead) return existing.promise;

    // 把“连接 + 失效校验 + 写回缓存”合并成同一个 promise，所有并发调用共享它；
    // 这样连接期间发生配置/主机变更时，不会有人拿到未经过校验的旧客户端。
    const task = this._connect(host).then((client) => {
      const current = this.clients.get(host.id);
      if (!current || current.dead || current.promise !== task) {
        try { client.end(); } catch (_) { /* ignore */ }
        throw new HttpError(499, 'SSH 连接已重置');
      }
      this.clients.set(host.id, { client, dead: false });
      return client;
    }).catch((err) => {
      const current = this.clients.get(host.id);
      if (current && current.promise === task) this.clients.delete(host.id);
      throw err;
    });
    this.clients.set(host.id, { promise: task });
    return task;
  }

  _dropClient(id) {
    const entry = this.clients.get(id);
    if (entry && entry.client) {
      entry.dead = true;
      try { entry.client.end(); } catch (_) { /* ignore */ }
    }
    this.clients.delete(id);
  }

  _connect(host) {
    const ssh = this.sshConfig;
    const port = Number(host.port || ssh.defaultPort || 22);
    const username = host.user || ssh.defaultUser || 'root';
    const timeout = Number(host.connectTimeoutMs || ssh.connectTimeoutMs || 12000);

    return new Promise((resolve, reject) => {
      const client = new SshClient();
      // 认证参数在 connect 前就可能抛错；先挂一个空监听，避免 end() 时出现未处理的 error 事件。
      client.on('error', () => { /* 由下方正式监听器处理 */ });
      let settled = false;
      let timer = null;
      let hostKeyError = null;

      const finish = (err) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) {
          try { client.end(); } catch (_) { /* ignore */ }
          reject(err);
        } else {
          resolve(client);
        }
      };

      const options = {
        host: host.host,
        port,
        username,
        readyTimeout: timeout,
        keepaliveInterval: 15000,
        keepaliveCountMax: 4,
        hostVerifier: (key) => {
          try {
            const ok = this._verifyHostKey(host, port, key);
            if (!ok) hostKeyError = this._lastHostKeyError;
            return ok;
          } catch (err) {
            hostKeyError = err;
            return false;
          }
        }
      };

      try {
        Object.assign(options, this._authOptions(host));
      } catch (err) {
        finish(err);
        return;
      }

      timer = setTimeout(() => {
        finish(new HttpError(504, `连接 ${host.host}:${port} 超时（${timeout}ms），请检查网络、防火墙或 SSH 端口`));
      }, timeout + 4000);

      client.on('ready', () => {
        logDebug('ssh ready', host.id, `${username}@${host.host}:${port}`);
        finish(null);
      });
      client.on('error', (err) => {
        const message = this._friendlySshError(err, host, port, hostKeyError);
        finish(new HttpError(502, message, err && err.message));
      });
      client.on('close', () => {
        const entry = this.clients.get(host.id);
        if (entry && entry.client === client) {
          entry.dead = true;
          this.clients.delete(host.id);
        }
      });

      try {
        client.connect(options);
      } catch (err) {
        finish(new HttpError(502, `SSH 连接失败：${err.message}`));
      }
    });
  }

  _authOptions(host) {
    const ssh = this.sshConfig;
    const auth = host.auth || {};
    const type = auth.type || (auth.password ? 'password' : (auth.privateKeyPath || auth.privateKey) ? 'key' : null);
    const options = {};

    if (type === 'password') {
      if (!auth.password) throw new HttpError(400, `主机 ${host.id} 未配置 SSH 密码`);
      options.password = auth.password;
      return options;
    }
    if (type === 'key') {
      let keyData = auth.privateKey || null;
      if (!keyData) {
        const keyPath = expandHome(auth.privateKeyPath || ssh.privateKeyPath || '');
        if (keyPath) {
          if (!fs.existsSync(keyPath)) throw new HttpError(400, `SSH 私钥文件不存在：${keyPath}`);
          keyData = fs.readFileSync(keyPath);
        }
      }
      if (keyData) {
        options.privateKey = keyData;
        if (auth.passphrase) options.passphrase = auth.passphrase;
        return options;
      }
      // 未指定私钥路径时继续尝试 ssh.defaultKeyPaths
    }
    if (type === 'agent') {
      options.agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
      return options;
    }
    if (type === 'none') {
      return options;
    }

    // 未显式配置认证方式时，尝试默认私钥，再尝试 agent
    const candidates = [];
    if (ssh.privateKeyPath) candidates.push(expandHome(ssh.privateKeyPath));
    for (const p of ssh.defaultKeyPaths || DEFAULT_KEY_PATHS) candidates.push(expandHome(p));
    for (const candidate of candidates) {
      if (candidate && fs.existsSync(candidate)) {
        options.privateKey = fs.readFileSync(candidate);
        if (auth.passphrase) options.passphrase = auth.passphrase;
        return options;
      }
    }
    if (process.env.SSH_AUTH_SOCK) {
      options.agent = process.env.SSH_AUTH_SOCK;
      return options;
    }
    throw new HttpError(400, `主机 ${host.id} 未配置认证方式，请在 config.json 中填写 auth.password 或 auth.privateKeyPath`);
  }

  _execOnClient(client, command, opts = {}) {
    const timeout = this.timeoutFor(opts);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let killTimer = null;
      let timedOut = false;
      let killedByUser = false;
      let channel = null;

      const cleanup = () => {
        if (timer) clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
      };

      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve(result);
      };

      const kill = (reason) => {
        if (settled) return;
        if (reason === 'user') killedByUser = true;
        if (!channel) {
          finish(new HttpError(killedByUser ? 499 : 504, killedByUser ? '操作已取消' : `命令执行超时（${timeout}ms）`));
          return;
        }
        try { if (channel) channel.signal('KILL'); } catch (_) { /* ignore */ }
        killTimer = setTimeout(() => {
          try { if (channel) channel.close(); } catch (_) { /* ignore */ }
          finish(new HttpError(killedByUser ? 499 : 504, killedByUser ? '操作已取消' : `命令执行超时（${timeout}ms）`));
        }, 2500);
      };

      // 从发起 exec 前就计时，避免连接在回调前异常导致 Promise 永久悬挂。
      timer = setTimeout(() => {
        timedOut = true;
        kill('timeout');
      }, timeout);

      if (opts.onStart) {
        try { opts.onStart(() => kill('user')); } catch (_) { /* ignore */ }
      }

      client.exec(command, (err, stream) => {
        if (settled) {
          try { stream.close(); } catch (_) { /* ignore */ }
          return;
        }
        if (err) {
          if (/Channel open failure|Administratively prohibited/i.test(err.message || '')) {
            finish(new HttpError(502, 'SSH 拒绝打开命令通道，可能达到 MaxSessions 限制'));
          } else {
            finish(new HttpError(502, `SSH 命令执行失败：${err.message}`));
          }
          return;
        }
        channel = stream;
        const outChunks = [];
        const errChunks = [];
        let outLen = 0;
        let errLen = 0;
        const maxBytes = Number(opts.maxBytes || 8 * 1024 * 1024);
        const onLine = typeof opts.onLine === 'function' ? opts.onLine : null;
        const outSplitter = onLine ? lineSplitter(onLine, 'stdout') : null;
        const errSplitter = onLine ? lineSplitter(onLine, 'stderr') : null;

        stream.on('data', (data) => {
          outLen += data.length;
          if (outLen <= maxBytes) outChunks.push(data);
          if (outSplitter) outSplitter.push(data.toString('utf8'));
        });
        stream.stderr.on('data', (data) => {
          errLen += data.length;
          if (errLen <= maxBytes) errChunks.push(data);
          if (errSplitter) errSplitter.push(data.toString('utf8'));
        });
        stream.on('close', (code) => {
          if (settled) return;
          if (outSplitter) outSplitter.end();
          if (errSplitter) errSplitter.end();
          const stdout = Buffer.concat(outChunks).toString('utf8');
          const stderr = Buffer.concat(errChunks).toString('utf8');
          if (timedOut) {
            finish(new HttpError(504, `命令执行超时（${timeout}ms）`, stderr.slice(-2000)));
            return;
          }
          if (killedByUser) {
            finish(new HttpError(499, '操作已取消'));
            return;
          }
          finish(null, { code: code === undefined ? 0 : code, stdout, stderr, truncated: outLen > maxBytes });
        });
        stream.on('error', (streamErr) => {
          if (/ECONNRESET|EPIPE/.test(streamErr.message || '')) {
            finish(new HttpError(502, 'SSH 连接中断', streamErr.message));
          } else {
            finish(new HttpError(502, `SSH 通道错误：${streamErr.message}`));
          }
        });

        if (opts.input !== null && opts.input !== undefined) {
          stream.end(opts.input);
        } else {
          stream.end();
        }
      });
    });
  }

  _friendlySshError(err, host, port, hostKeyError) {
    const message = (err && err.message) || '未知错误';
    if (hostKeyError) {
      return `SSH 主机密钥校验失败：${hostKeyError.message || hostKeyError}`;
    }
    if (err && (err.code === 'ECONNREFUSED')) return `无法连接 ${host.host}:${port}：端口未开放或 SSH 服务未启动`;
    if (err && (err.code === 'ETIMEDOUT' || err.code === 'EHOSTUNREACH')) return `无法连接 ${host.host}:${port}：网络不可达或超时`;
    if (err && err.code === 'ENOTFOUND') return `无法解析主机名：${host.host}`;
    if (/All configured authentication methods failed/i.test(message)) {
      return `SSH 认证失败（${host.user || 'root'}@${host.host}）：端口已连通，但服务器拒绝了登录。请确认密码是否已变更；若服务器禁用了 root 密码登录，请改用可 sudo 的普通用户并勾选“使用 sudo”，或改用私钥认证。`;
    }
    if (/Host verification failed|verification failed/i.test(message)) {
      return `SSH 主机密钥校验失败：${hostKeyError ? hostKeyError.message : '与 known_hosts 记录不一致'}`;
    }
    return `SSH 连接 ${host.host}:${port} 失败：${message}`;
  }

  _verifyHostKey(host, port, key) {
    const ssh = this.sshConfig;
    const policy = host.hostKeyPolicy || ssh.hostKeyPolicy || 'accept-new';
    this._lastHostKeyError = null;
    if (policy === 'insecure' || policy === 'off') return true;

    const hostname = String(host.host || '');
    const entryHost = port === 22 ? hostname : `[${hostname}]:${port}`;
    const knownHosts = expandHome(ssh.knownHostsPath || '~/.ssh/known_hosts');
    const { type: keyType, blob: keyBlob } = this._hostKeyInfo(key);

    let lines = [];
    try {
      lines = fs.readFileSync(knownHosts, 'utf8').split(/\r?\n/);
    } catch (_) { /* 文件不存在时视为空 */ }

    let foundHost = false;
    let foundSameType = false;
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const parts = line.split(/\s+/);
      if (parts.length < 3) continue;
      const [hostsPart, type, blob] = parts;
      const matches = hostsPart.split(',').some((h) => this._matchKnownHost(h, hostname, port));
      if (!matches) continue;
      foundHost = true;
      if (type !== keyType) continue;
      foundSameType = true;
      if (blob === keyBlob) return true;
    }

    if (foundSameType) {
      // 同一种密钥类型但内容不同：服务器换了密钥（重装）或中间人，必须拒绝
      this._lastHostKeyError = new Error(
        `known_hosts 中 ${entryHost} 的 ${keyType} 主机密钥与当前服务器不一致。若确认服务器已重装，请删除该行后重试。`
      );
      return false;
    }
    if (foundHost && policy === 'strict') {
      // 主机有记录，但记录的是别的密钥类型（例如旧记录只有 ECDSA，这次协商到 ED25519）
      this._lastHostKeyError = new Error(`known_hosts 中没有 ${entryHost} 的 ${keyType} 主机密钥（strict 策略拒绝）`);
      return false;
    }
    if (!foundHost && policy === 'strict') {
      this._lastHostKeyError = new Error(`known_hosts 中没有 ${entryHost} 的记录（strict 策略拒绝首次连接）`);
      return false;
    }
    try {
      fs.mkdirSync(path.dirname(knownHosts), { recursive: true });
      fs.appendFileSync(knownHosts, `${entryHost} ${keyType} ${keyBlob}\n`, { mode: 0o600 });
    } catch (err) {
      logDebug('append known_hosts failed', err.message);
    }
    return true;
  }

  /**
   * ssh2 v1.x 的 hostVerifier 传入的是原始公钥 Buffer（SSH wire format），
   * 旧版本传入的是已解析的 key 对象；这里同时兼容两种形式。
   */
  _hostKeyInfo(key) {
    if (Buffer.isBuffer(key)) {
      if (key.length < 4) throw new Error('主机公钥数据长度不足');
      const typeLen = key.readUInt32BE(0);
      if (typeLen <= 0 || typeLen > key.length - 4) throw new Error('主机公钥数据格式不正确');
      return {
        type: key.slice(4, 4 + typeLen).toString('ascii'),
        blob: key.toString('base64')
      };
    }
    if (key && typeof key.getPublicSSH === 'function') {
      return { type: key.type, blob: key.getPublicSSH().toString('base64') };
    }
    throw new Error('无法识别的主机公钥格式');
  }

  _matchKnownHost(pattern, hostname, port) {
    if (pattern.startsWith('|1|')) {
      const parts = pattern.split('|');
      if (parts.length !== 4) return false;
      const salt = Buffer.from(parts[2], 'base64');
      const expected = parts[3];
      const digest = crypto.createHmac('sha1', salt).update(hostname).digest('base64');
      return digest === expected;
    }
    if (pattern.startsWith('!')) return false;
    if (pattern === hostname) return true;
    if (port !== 22 && pattern === `[${hostname}]:${port}`) return true;
    if (pattern.includes('*') || pattern.includes('?')) {
      const rx = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
      return rx.test(hostname);
    }
    return false;
  }

  // ------------------------------------------------------------------ local

  /** 本地接入 = 控制端即节点，k3s 只有 Linux 版本，因此只在 Linux 控制端成立。
   *  入口（创建/编辑主机）已经拦住，这里是兜底：历史数据里残留的 local 主机也不会在别的平台执行。 */
  _assertLocalSupported() {
    if (process.platform !== 'linux') {
      throw new HttpError(
        400,
        `本地接入仅支持 Linux 控制端（当前控制端是 ${process.platform}），请改用 SSH 或 kubeconfig`
      );
    }
  }

  _execLocal(argv, env, input, opts = {}) {
    const timeout = this.timeoutFor(opts);
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      let timedOut = false;
      let killedByUser = false;

      const finish = (err, result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) reject(err);
        else resolve(result);
      };

      let child;
      try {
        child = spawn(argv[0], argv.slice(1), {
          env: { ...process.env, LANG: 'C', LC_ALL: 'C', ...env },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } catch (err) {
        finish(new HttpError(502, `无法启动命令 ${argv[0]}：${err.message}`));
        return;
      }

      if (opts.onStart) {
        try {
          opts.onStart(() => {
            killedByUser = true;
            try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
          });
        } catch (_) { /* ignore */ }
      }

      const outChunks = [];
      const errChunks = [];
      const maxBytes = Math.max(64 * 1024, Number(opts.maxBytes) || 8 * 1024 * 1024);
      let outBytes = 0;
      let errBytes = 0;
      let truncated = false;
      const onLine = typeof opts.onLine === 'function' ? opts.onLine : null;
      const outSplitter = onLine ? lineSplitter(onLine, 'stdout') : null;
      const errSplitter = onLine ? lineSplitter(onLine, 'stderr') : null;

      timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGKILL'); } catch (_) { /* ignore */ }
      }, timeout);

      child.stdout.on('data', (d) => {
        outBytes += d.length;
        if (outBytes <= maxBytes) outChunks.push(d);
        else truncated = true;
        if (outSplitter) outSplitter.push(d.toString('utf8'));
      });
      child.stderr.on('data', (d) => {
        errBytes += d.length;
        if (errBytes <= maxBytes) errChunks.push(d);
        else truncated = true;
        if (errSplitter) errSplitter.push(d.toString('utf8'));
      });
      child.on('error', (err) => {
        if (err.code === 'ENOENT') {
          finish(new HttpError(502, `本机找不到命令：${argv[0]}，请安装或在 config.json 中配置 kubectl 路径`));
        } else {
          finish(new HttpError(502, `本机命令执行失败：${err.message}`));
        }
      });
      child.on('close', (code) => {
        if (outSplitter) outSplitter.end();
        if (errSplitter) errSplitter.end();
        const stdout = Buffer.concat(outChunks).toString('utf8');
        const stderr = Buffer.concat(errChunks).toString('utf8');
        if (timedOut) return finish(new HttpError(504, `命令执行超时（${timeout}ms）`, stderr.slice(-2000)));
        if (killedByUser) return finish(new HttpError(499, '操作已取消'));
        finish(null, { code: code === null ? -1 : code, stdout, stderr, truncated });
      });

      if (input !== null && input !== undefined) child.stdin.end(input);
      else child.stdin.end();
    });
  }

  // ------------------------------------------------------------------ misc

  async testConnection(host) {
    const started = Date.now();
    if (host.transport === 'kubeconfig') {
      const result = await this.execCommand(host, {
        argv: this._kubeconfigArgv(host, ['version', '--client', '-o', 'json'])
      });
      const latency = Date.now() - started;
      return { ok: result.code === 0, latency, output: (result.stdout || result.stderr || '').trim() };
    }
    const result = await this.execScript(
      host,
      'echo "@@HOST@@"\nhostname 2>/dev/null || true\necho "@@OS@@"\nuname -srm 2>/dev/null || true\necho "@@USER@@"\nid -un 2>/dev/null || whoami\necho "@@OK@@"',
      { timeout: 20000 }
    );
    const latency = Date.now() - started;
    const text = result.stdout + result.stderr;
    if (result.code !== 0) {
      throw new HttpError(502, `命令返回非 0 退出码（${result.code}）`, text.slice(-1500));
    }
    return { ok: true, latency, output: text.trim() };
  }

  _kubeconfigArgv(host, args) {
    const kubectl = host.kubectlPath || 'kubectl';
    const argv = [kubectl];
    if (host.kubeconfig) argv.push('--kubeconfig', expandHome(host.kubeconfig));
    if (host.context) argv.push('--context', host.context);
    return argv.concat(args);
  }

  dispose() {
    for (const [id] of this.clients) this._dropClient(id);
  }
}

module.exports = { Transport, hasSsh2: () => !!SshClient };
