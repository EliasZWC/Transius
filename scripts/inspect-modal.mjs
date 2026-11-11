/**
 * 打开「新建连接」弹窗并截图，验证弹窗/输入框/按钮的 House Style 落地。
 */
import { writeFileSync } from 'node:fs';

const HOST = 'http://127.0.0.1:9222';
const res = await fetch(`${HOST}/json`);
const targets = await res.json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
if (!page) throw new Error('未找到渲染进程页面');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r, j) => {
  ws.addEventListener('open', r, { once: true });
  ws.addEventListener('error', j, { once: true });
});

let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    pending.get(m.id)(m.result);
    pending.delete(m.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

// 1. 切到英文，验证文案全大写的规范
await send('Runtime.evaluate', {
  expression: `[...document.querySelectorAll('.topbar .btn')].find(b => b.textContent.includes('EN'))?.click()`,
});
await new Promise((r) => setTimeout(r, 400));

// 2. 点「新建连接」
await send('Runtime.evaluate', {
  expression: `document.querySelector('.sidebar-head .btn')?.click()`,
});
await new Promise((r) => setTimeout(r, 500));

const probe = await send('Runtime.evaluate', {
  expression: `(() => {
    const modal = document.querySelector('.modal');
    const cs = modal ? getComputedStyle(modal) : null;
    const btns = [...document.querySelectorAll('.modal-foot .btn')].map(b => ({
      text: b.textContent.trim(),
      bg: getComputedStyle(b).backgroundColor,
      color: getComputedStyle(b).color,
    }));
    const input = document.querySelector('.modal .input');
    return JSON.stringify({
      modal: cs ? { bg: cs.backgroundColor, radius: cs.borderRadius, width: cs.width } : null,
      buttons: btns,
      inputShadow: input ? getComputedStyle(input).boxShadow : null,
      groupTitleTransform: getComputedStyle(document.querySelector('.sidebar-head')).textTransform,
      title: document.querySelector('.modal-head span')?.textContent,
    }, null, 2);
  })()`,
  returnByValue: true,
});
console.log(probe.result.value);

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('scripts/ui-modal.png', Buffer.from(shot.data, 'base64'));
console.log('弹窗截图: scripts/ui-modal.png');

ws.close();
