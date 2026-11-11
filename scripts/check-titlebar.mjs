/** 验证自绘标题栏的结构、尺寸与窗口控制 IPC。 */
const HOST = 'http://127.0.0.1:9222';

const targets = await (await fetch(`${HOST}/json`)).json();
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

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + (r.result?.description ?? ''));
  return r.result.value;
};

const probe = await ev(`(async () => {
  const bar = document.querySelector('.titlebar');
  const btns = [...document.querySelectorAll('.titlebar-btn')];
  const rect = (el) => { const r = el.getBoundingClientRect(); return {w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y)}; };
  const cs = bar ? getComputedStyle(bar) : null;
  const st = await window.transius.win.queryState();
  return {
    hasBar: !!bar,
    barRect: bar ? rect(bar) : null,
    barBg: cs?.backgroundColor,
    appRegion: cs?.getPropertyValue('-webkit-app-region') || cs?.webkitAppRegion,
    btnCount: btns.length,
    btnRects: btns.map(rect),
    closeBtnHoverClass: btns[btns.length-1]?.className,
    winStateOk: st.ok,
    winState: st.ok ? st.data : null,
    bodyH: Math.round(document.body.getBoundingClientRect().height),
    mainY: Math.round(document.querySelector('.main')?.getBoundingClientRect().y ?? -1),
  };
})()`);

console.log(JSON.stringify(probe, null, 2));

// 实测窗口控制：最小化后恢复
const before = await ev(`window.transius.win.queryState()`);
await ev(`window.transius.win.minimize()`);
await new Promise((r) => setTimeout(r, 500));
console.log('after minimize:', JSON.stringify(await ev(`window.transius.win.queryState()`)));

await ev(`window.transius.win.toggleMaximize()`);
await new Promise((r) => setTimeout(r, 800));
const maxed = await ev(`window.transius.win.queryState()`);
console.log('after maximize:', JSON.stringify(maxed));

await ev(`window.transius.win.toggleMaximize()`);
await new Promise((r) => setTimeout(r, 800));
console.log('after restore:', JSON.stringify(await ev(`window.transius.win.queryState()`)));

void before;
ws.close();
