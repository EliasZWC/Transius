/**
 * 测试卸载流程（需以 --uninstall 启动安装器并开放调试端口）。
 * 用法: node scripts/test-uninstall.mjs [port]
 */
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
const ev = async (expr) => {
  const r = await send('Runtime.evaluate', {
    expression: expr,
    returnByValue: true,
    awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text);
  return r.result.value;
};

console.log('模式:', await ev(`document.getElementById('headTitle').textContent`));
console.log('路径:', await ev(`document.getElementById('installPath').value`));

console.log('\n点击「卸载」…');
await ev(`document.getElementById('btnMain').click()`);

for (let i = 0; i < 120; i++) {
  const st = JSON.parse(
    await ev(`JSON.stringify({
      done: !document.getElementById('stepDone').hidden,
      error: !document.getElementById('stepError').hidden,
      doneText: document.getElementById('doneSub').textContent,
      errText: document.getElementById('errDetail').textContent,
      stage: document.getElementById('progStage').textContent,
    })`),
  );
  if (st.done) {
    console.log('✓ 卸载完成:', st.doneText);
    break;
  }
  if (st.error) {
    console.log('✗ 卸载失败:', st.errText);
    process.exitCode = 1;
    break;
  }
  if (i % 4 === 0) console.log(' ', st.stage);
  await new Promise((r) => setTimeout(r, 500));
}

ws.close();
