/**
 * 验证字体是否真正生效（而不是静默回退到 fallback）。
 * 关键手法：用 canvas measureText 比较宽字符与窄字符的宽度比。
 * 等宽字体里「汉」与「a」的宽度比应恰好是 2:1；比例字体则不是。
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
    const fam = getComputedStyle(document.body).fontFamily;
    const c = document.createElement('canvas').getContext('2d');

    const measure = (font) => {
      c.font = font;
      return {
        latin: c.measureText('abcdefghij').width,
        han: c.measureText('汉字测试文本').width,
        singleA: c.measureText('a').width,
        singleHan: c.measureText('汉').width,
      };
    };

    const s = measure('16px ' + fam);
    const ratio = s.singleHan / s.singleA;

    // 用 document.fonts 直接检查字体是否可用
    let installed = false;
    try {
      installed = document.fonts.check('16px "Sarasa Mono SC"');
    } catch (e) {}

    return JSON.stringify({
      fontFamily: fam,
      sarasaCheck: installed,
      singleA: +s.singleA.toFixed(3),
      singleHan: +s.singleHan.toFixed(3),
      hanToLatinRatio: +ratio.toFixed(3),
      isMonospace: Math.abs(ratio - 2) < 0.02,
      bodySize: getComputedStyle(document.body).fontSize,
    }, null, 2);
  })()`,
  returnByValue: true,
});

console.log(r.result.value);
ws.close();
