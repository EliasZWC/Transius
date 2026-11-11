/**
 * 校验实际渲染的计算样式是否符合 House Style。
 * 用法: node scripts/check-house-style.mjs  （需先启动应用并开 9222 端口）
 */
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

const r = await send('Runtime.evaluate', {
  expression: `(() => {
    const px = (el) => el ? getComputedStyle(el) : null;
    const pick = (s, props) => {
      const el = document.querySelector(s);
      if (!el) return { selector: s, missing: true };
      const cs = getComputedStyle(el);
      const out = { selector: s };
      for (const key of props) out[key] = cs[key];
      return out;
    };

    // 统计全页出现的所有颜色，检查是否有高饱和色
    const colorSet = new Map();
    const parse = (v) => {
      const m = /rgba?(\\d+),\\s*(\\d+),\\s*(\\d+)/.exec(v);
      if (m) return [+m[1], +m[2], +m[3]];
      const h = /^#([0-9a-f]{6})$/i.exec(v);
      if (h) return [parseInt(h[1].slice(0,2),16), parseInt(h[1].slice(2,4),16), parseInt(h[1].slice(4,6),16)];
      return null;
    };
    const sat = (rgb) => {
      const [r,g,b] = rgb.map(x => x/255);
      const max = Math.max(r,g,b), min = Math.min(r,g,b);
      if (max === min) return 0;
      const l = (max+min)/2;
      const d = max-min;
      return l > 0.5 ? d/(2-max-min) : d/(max+min);
    };

    for (const el of document.querySelectorAll('*')) {
      const cs = getComputedStyle(el);
      for (const prop of ['color','backgroundColor','borderTopColor']) {
        const v = cs[prop];
        if (!v || v === 'rgba(0, 0, 0, 0)' || v === 'transparent') continue;
        const rgb = parse(v);
        if (!rgb) continue;
        if (sat(rgb) > 0.15) colorSet.set(v, (colorSet.get(v)||0)+1);
      }
    }

    return JSON.stringify({
      body: pick('body', ['backgroundColor','color','fontFamily','fontSize']),
      topbar: pick('.topbar', ['backgroundColor','height']),
      sidebar: pick('.sidebar', ['backgroundColor','width']),
      paneA: pick('.pane', ['backgroundColor']),
      selected: pick('.file-row.selected', ['backgroundColor']),
      primaryBtn: pick('.btn.primary', ['backgroundColor','color','fontWeight']),
      progressFill: pick('.progress-fill', ['backgroundColor','height']),
      modalRadius: pick('.modal', ['borderRadius']),
      saturatedColors: [...colorSet.entries()],
    }, null, 2);
  })()`,
  returnByValue: true,
});

console.log(r.result.value);
ws.close();
