'use strict';

const { parentPort } = require('worker_threads');
const offline = require('./offline');

// 离线包检查需要启动 tar 子进程并读取归档，放到 worker 中执行，避免阻塞 HTTP/SSE 事件循环。
parentPort.on('message', (message) => {
  const id = message && message.id;
  try {
    const packages = offline.listPackages(message && message.root);
    parentPort.postMessage({ id, ok: true, packages });
  } catch (err) {
    parentPort.postMessage({ id, ok: false, error: (err && err.message) || String(err) });
  }
});
