/**
 * 开发期 UI 验证脚本（不参与打包）。
 * 通过 Chrome DevTools Protocol 连接正在运行的 Electron 渲染进程，
 * 抓取 DOM 状态并截图，用于人眼核对布局是否正确。
 *
 * 用法：先启动应用（--remote-debugging-port=9222），再执行 node scripts/inspect-ui.mjs
 */
import { writeFileSync } from 'node:fs';

const HOST = 'http://127.0.0.1:9222';

async function findPage() {
  const res = await fetch(`${HOST}/json`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
  if (!page) throw new Error('未找到 Transius 渲染进程页面');
  return page;
}

function cdp(ws) {
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  });
  return (method, params = {}) =>
    new Promise((resolve, reject) => {
      const msgId = ++id;
      pending.set(msgId, { resolve, reject });
      ws.send(JSON.stringify({ id: msgId, method, params }));
    });
}

const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', j, { once: true });
});
const send = cdp(ws);

const probe = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    rootChildren: document.getElementById('root')?.childElementCount ?? 0,
    panes: document.querySelectorAll('.pane').length,
    paneTitles: [...document.querySelectorAll('.pane-title')].map(e => e.textContent),
    fileRows: document.querySelectorAll('.file-row').length,
    transferPanel: !!document.querySelector('.transfer-panel'),
    sidebarProfiles: document.querySelectorAll('.profile-item').length,
    emptyHints: [...document.querySelectorAll('.pane-empty,.empty-hint')].map(e => e.textContent?.trim()).slice(0,4),
    bodyHeight: document.body.getBoundingClientRect().height,
    firstRowText: document.querySelector('.file-row .file-name')?.textContent ?? null,
    toolbarButtons: [...document.querySelectorAll('.pane-toolbar .btn')].map(b => b.textContent?.trim())
  })`,
  returnByValue: true,
});
console.log('DOM 探测结果:');
console.log(JSON.stringify(JSON.parse(probe.result.value), null, 2));

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('scripts/ui-screenshot.png', Buffer.from(shot.data, 'base64'));
console.log('\n截图已保存: scripts/ui-screenshot.png');

ws.close();
