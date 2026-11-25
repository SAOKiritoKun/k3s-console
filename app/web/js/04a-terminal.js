/* ============================================================
 * xterm.js 终端封装：SSH 终端和容器终端共用
 * ============================================================ */

const XTERM_THEME = {
  background: '#03070d',
  foreground: '#c9d6ea',
  cursor: '#6ee7b7',
  cursorAccent: '#03070d',
  selectionBackground: 'rgba(59,130,246,.35)',
  black: '#0b1220',
  red: '#fb7185',
  green: '#6ee7b7',
  yellow: '#fcd34d',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#67e8f9',
  white: '#c9d6ea',
  brightBlack: '#5b6b83',
  brightRed: '#fda4af',
  brightGreen: '#a7f3d0',
  brightYellow: '#fde68a',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#a5f3fc',
  brightWhite: '#f1f5f9'
};

function createTerminalView(el, options = {}) {
  if (!el) throw new Error('终端容器不存在');
  if (typeof Terminal !== 'function') throw new Error('xterm.js 未加载');
  if (typeof FitAddon === 'undefined' || !FitAddon || typeof FitAddon.FitAddon !== 'function') {
    throw new Error('xterm FitAddon 未加载');
  }

  const term = new Terminal({
    cursorBlink: true,
    cursorStyle: 'block',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    lineHeight: 1.15,
    scrollback: 5000,
    convertEol: false,
    allowProposedApi: false,
    macOptionIsMeta: true,
    rightClickSelectsWord: true,
    theme: XTERM_THEME
  });
  const fitAddon = new FitAddon.FitAddon();
  term.loadAddon(fitAddon);
  term.open(el);

  let disposed = false;
  let raf = 0;
  let initialTimer = 0;
  const fit = () => {
    if (disposed) return;
    if (raf) cancelAnimationFrame(raf);
    raf = requestAnimationFrame(() => {
      raf = 0;
      if (disposed) return;
      try { fitAddon.fit(); } catch (_) { /* 容器隐藏时尺寸可能为 0 */ }
    });
  };

  const onData = term.onData((data) => {
    if (!disposed && options.onData) options.onData(data);
  });
  const onResize = term.onResize(({ cols, rows }) => {
    if (!disposed && options.onResize) options.onResize(cols, rows);
  });

  let observer = null;
  if (typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => fit());
    observer.observe(el);
  } else {
    window.addEventListener('resize', fit);
  }
  initialTimer = setTimeout(fit, 60);

  return {
    term,
    write(data) {
      if (!disposed) term.write(data);
    },
    reset() {
      if (!disposed) term.reset();
    },
    clear() {
      if (!disposed) term.clear();
    },
    fit,
    focus() {
      if (!disposed) term.focus();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      if (initialTimer) clearTimeout(initialTimer);
      if (observer) observer.disconnect();
      else window.removeEventListener('resize', fit);
      onData.dispose();
      onResize.dispose();
      term.dispose();
    }
  };
}

function queueTerminalInput(st, data) {
  if (!st || !st.sessionId || st.status !== 'running') return;
  const text = String(data === undefined || data === null ? '' : data);
  if (!text) return;
  // 合并连续按键：首个字符立即发送，上一请求未返回期间的输入合并成下一批，
  // 避免每个按键都占一次 HTTP 往返，同时保持输入顺序。
  st.inputBuffer = (st.inputBuffer || '') + text;
  flushTerminalInput(st);
}

function flushTerminalInput(st) {
  if (!st || st.inputSending || !st.sessionId || st.status !== 'running') return;
  const pending = String(st.inputBuffer || '');
  if (!pending) return;
  let cut = Math.min(8192, pending.length);
  if (cut < pending.length && /[\uD800-\uDBFF]/.test(pending[cut - 1])) cut -= 1;
  const text = pending.slice(0, cut);
  st.inputBuffer = pending.slice(cut);
  const sessionId = st.sessionId;
  st.inputSending = true;
  api(`/shells/${encodeURIComponent(sessionId)}/input`, { method: 'POST', body: { data: text } })
    .catch((err) => {
      if (st.status === 'running' && st.sessionId === sessionId) {
        toast(`终端输入失败：${errorText(err)}`, 'error');
      }
    })
    .finally(() => {
      st.inputSending = false;
      if (st.status === 'running' && st.sessionId === sessionId && st.inputBuffer) {
        flushTerminalInput(st);
      } else if (st.status !== 'running' || st.sessionId !== sessionId) {
        st.inputBuffer = '';
      }
    });
}

function resizeTerminalSession(st, cols, rows) {
  if (!st || !st.sessionId || st.status !== 'running') return;
  api(`/shells/${encodeURIComponent(st.sessionId)}/resize`, {
    method: 'POST',
    body: { cols, rows }
  }).catch(() => { /* 某些非 PTY 终端不支持 resize，忽略 */ });
}
