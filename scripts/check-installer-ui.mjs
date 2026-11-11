/**
 * 检查安装器 UI 的渲染状态与计算样式（是否符合 HouseStyle）。
 * 用法: node scripts/check-installer-ui.mjs [port]
 */
import { writeFileSync } from 'node:fs';

const port = process.argv[2] || '9333';
const HOST = `http://127.0.0.1:${port}`;

const targets = await (await fetch(`${HOST}/json`)).json();
const page = targets.find((t) => t.type === 'page');
if (!page) throw new Error('未找到安装器页面');

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

await new Promise((r) => setTimeout(r, 1200));

const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const pick = (s, props) => {
      const el = document.querySelector(s);
      if (!el) return { selector: s, missing: true };
      const cs = getComputedStyle(el);
      const out = { selector: s };
      for (const k of props) out[k] = cs[k];
      return out;
    };
    const parse = (v) => {
      const m = /rgba?(\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(v);
      return m ? [+m[1],+m[2],+m[3]] : null;
    };
    const sat = (rgb) => {
      const [r,g,b] = rgb.map(x=>x/255);
      const mx = Math.max(r,g,b), mn = Math.min(r,g,b);
      if (mx===mn) return 0;
      const l=(mx+mn)/2, d=mx-mn;
      return l>0.5 ? d/(2-mx-mn) : d/(mx+mn);
    };
    const bad = new Map();
    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      for (const p of ['color','backgroundColor']) {
        const v = cs[p];
        if (!v || v==='rgba(0, 0, 0, 0)' || v==='transparent') continue;
        const rgb = parse(v);
        if (rgb && sat(rgb) > 0.15) bad.set(v, (bad.get(v)||0)+1);
      }
    }
    const bar = document.querySelector('.titlebar');
    const btns = [...document.querySelectorAll('.titlebar-btn')].map(b => {
      const r = b.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), cls: b.className };
    });
    return {
      body: pick('body', ['backgroundColor','color','fontFamily','fontSize']),
      titlebar: bar ? { h: Math.round(bar.getBoundingClientRect().height), bg: getComputedStyle(bar).backgroundColor } : null,
      btns,
      mainBtn: pick('.btn.primary', ['backgroundColor','color','fontWeight']),
      progressFill: pick('.progress-fill', ['backgroundColor','height']),
      headTitle: document.querySelector('.head-title')?.textContent,
      headSub: document.querySelector('.head-sub')?.textContent,
      path: document.querySelector('#installPath')?.value,
      spaceInfo: document.querySelector('#spaceInfo')?.innerText,
      options: [...document.querySelectorAll('.option span')].map(s=>s.textContent),
      saturated: [...bad.entries()],
    };
  })()`,
  returnByValue: true,
});

console.log(JSON.stringify(r.result.value, null, 2));

const shot = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync('scripts/installer-shot.png', Buffer.from(shot.data, 'base64'));
console.log('\n截图: scripts/installer-shot.png');
ws.close();
