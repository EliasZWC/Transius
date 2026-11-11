/**
 * 通过 CDP 驱动安装器 UI 完成一次真实安装，并校验结果。
 * 用法: node scripts/test-installer-flow.mjs [port] [targetDir]
 */
const port = process.argv[2] || '9333';
const targetDir = process.argv[3] || '';

const HOST = `http://127.0.0.1:${port}`;
const targets = await (await fetch(`${HOST}/json`)).json();
const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
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

const ev = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

console.log('初始状态:');
console.log(
  await ev(`JSON.stringify({
    installVisible: !document.getElementById('stepInstall').hidden,
    progressVisible: !document.getElementById('stepProgress').hidden,
    doneVisible: !document.getElementById('stepDone').hidden,
    errorVisible: !document.getElementById('stepError').hidden,
    mainLabel: document.getElementById('btnMain').textContent,
  })`),
);

// 如有指定目标目录则填入
if (targetDir) {
  await ev(
    `(() => { const i = document.getElementById('installPath'); i.value = ${JSON.stringify(targetDir)}; i.dataset.edited='1'; return i.value; })()`,
  );
  console.log('目标目录已设为:', targetDir);
}

// 取消「启动应用」，避免测试时打开窗口
await ev(`document.getElementById('optLaunch').checked = false`);

console.log('\n点击「安装」…');
await ev(`document.getElementById('btnMain').click()`);

// 轮询进度直到进入完成/错误页
const start = Date.now();
let last = '';
for (;;) {
  const st = await ev(`JSON.stringify({
    stage: document.getElementById('progStage').textContent,
    pct: document.getElementById('progPercent').textContent,
    detail: document.getElementById('progDetail').textContent,
    done: !document.getElementById('stepDone').hidden,
    error: !document.getElementById('stepError').hidden,
    errText: document.getElementById('errDetail')?.textContent || '',
    doneText: document.getElementById('doneSub')?.textContent || '',
  })`);
  const o = JSON.parse(st);
  const line = `${o.pct} ${o.stage} ${o.detail}`;
  if (line !== last) {
    console.log(' ', line);
    last = line;
  }
  if (o.done) {
    console.log('\n✓ 安装完成');
    console.log('  ', o.doneText.replace(/\n/g, ' '));
    break;
  }
  if (o.error) {
    console.log('\n✗ 安装失败:', o.errText);
    process.exitCode = 1;
    break;
  }
  if (Date.now() - start > 300000) {
    console.log('\n✗ 超时');
    process.exitCode = 1;
    break;
  }
  await new Promise((r) => setTimeout(r, 400));
}

ws.close();
