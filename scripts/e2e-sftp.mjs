/**
 * 端到端验证（不参与打包）。
 *
 * 启动一个内存态 SFTP 服务端，再用真实的 SshSession + TransferQueue 跑完整流程：
 *   连接 → 列目录 → 上传单文件 → 下载单文件 → 递归上传/下载目录 → 远程增删改名改权限
 *
 * UI 截图只能证明「画出来了」，这个脚本才能证明「传对了」。
 *
 * 用法: node scripts/e2e-sftp.mjs
 */
import ssh2 from 'ssh2';
import { generateKeyPairSync } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const { Server } = ssh2;

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
});

/* ------------------------- 内存虚拟文件系统 ------------------------- */

/** path -> Buffer（文件） */
const vfs = new Map();
/** 目录集合 */
const vdirs = new Set(['/']);
/** handle(hex) -> 状态 */
const handles = new Map();
let handleSeq = 0;

const norm = (p) => path.posix.normalize(p || '/');

function mkdirp(p) {
  vdirs.add('/');
  let cur = '';
  for (const part of norm(p).split('/').filter(Boolean)) {
    cur += '/' + part;
    vdirs.add(cur);
  }
}

function attrsOf(p) {
  const isDir = vdirs.has(p);
  const data = vfs.get(p);
  const now = Math.floor(Date.now() / 1000);
  return {
    mode: isDir ? 0o040755 : 0o100644,
    size: data ? data.length : 0,
    mtime: now,
    atime: now,
    uid: 1000,
    gid: 1000,
  };
}

function listDir(dirPath) {
  const base = dirPath === '/' ? '/' : dirPath.replace(/\/+$/, '');
  const names = new Set();
  const prefix = base === '/' ? '/' : base + '/';
  for (const p of [...vfs.keys(), ...vdirs]) {
    if (!p.startsWith(prefix)) continue;
    const first = p.slice(prefix.length).split('/')[0];
    if (first) names.add(first);
  }
  return [...names].map((name) => {
    const full = norm(path.posix.join(base, name));
    return { filename: name, longname: name, attrs: attrsOf(full) };
  });
}

function handleFor(state) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32BE(++handleSeq, 0);
  handles.set(buf.toString('hex'), { ...state, handle: buf });
  return buf;
}

/* ------------------------------ 服务端 ------------------------------ */

function attachSftp(sftp) {
  sftp.on('REALPATH', (req) => {
    const p = req.path === '.' ? '/' : norm(req.path);
    sftp.name(req.id, [{ filename: p, longname: p, attrs: attrsOf(p) }]);
  });

  sftp.on('STAT', (req) => sftp.attrs(req.id, attrsOf(norm(req.path))));
  sftp.on('LSTAT', (req) => sftp.attrs(req.id, attrsOf(norm(req.path))));
  sftp.on('FSTAT', (req) => {
    const h = handles.get(req.handle.toString('hex'));
    sftp.attrs(req.id, attrsOf(h ? h.path : '/'));
  });

  sftp.on('OPENDIR', (req) => {
    const dir = norm(req.path);
    if (!vdirs.has(dir)) return sftp.status(req.id, 2);
    sftp.handle(req.id, handleFor({ kind: 'dir', path: dir, entries: listDir(dir), idx: 0 }));
  });

  sftp.on('READDIR', (req) => {
    const h = handles.get(req.handle.toString('hex'));
    if (!h || h.kind !== 'dir') return sftp.status(req.id, 4);
    const out = [];
    for (let i = 0; i < 16 && h.idx < h.entries.length; i++) out.push(h.entries[h.idx++]);
    if (out.length === 0) return sftp.status(req.id, 1); // EOF
    sftp.name(req.id, out);
  });

  sftp.on('OPEN', (req) => {
    const p = norm(req.path);
    const flags = String(req.flags);
    const exists = vfs.has(p);
    const wantsWrite = /[wa+]/.test(flags);

    if (!exists) {
      if (!wantsWrite) return sftp.status(req.id, 2);
      // 需要写且不存在 → 创建
      mkdirp(path.posix.dirname(p));
      vfs.set(p, Buffer.alloc(0));
    }
    sftp.handle(req.id, handleFor({ kind: 'file', path: p }));
  });

  sftp.on('READ', (req) => {
    const h = handles.get(req.handle.toString('hex'));
    if (!h || h.kind !== 'file') return sftp.status(req.id, 4);
    const data = vfs.get(h.path) ?? Buffer.alloc(0);
    const start = Number(req.offset);
    const chunk = data.subarray(start, start + req.length);
    if (chunk.length === 0) return sftp.status(req.id, 1);
    sftp.data(req.id, chunk);
  });

  sftp.on('WRITE', (req) => {
    const h = handles.get(req.handle.toString('hex'));
    if (!h || h.kind !== 'file') return sftp.status(req.id, 4);
    let data = vfs.get(h.path) ?? Buffer.alloc(0);
    const off = Number(req.offset);
    const end = off + req.data.length;
    if (end > data.length) {
      const grown = Buffer.alloc(end);
      data.copy(grown);
      data = grown;
    }
    req.data.copy(data, off);
    vfs.set(h.path, data);
    sftp.status(req.id, 0);
  });

  sftp.on('CLOSE', (req) => {
    handles.delete(req.handle.toString('hex'));
    sftp.status(req.id, 0);
  });

  sftp.on('MKDIR', (req) => {
    const p = norm(req.path);
    if (vdirs.has(p)) return sftp.status(req.id, 4);
    mkdirp(path.posix.dirname(p));
    vdirs.add(p);
    sftp.status(req.id, 0);
  });

  sftp.on('RMDIR', (req) => {
    const p = norm(req.path);
    const hasChildren = [...vfs.keys(), ...vdirs].some((x) => x.startsWith(p + '/'));
    if (hasChildren) return sftp.status(req.id, 4);
    vdirs.delete(p);
    sftp.status(req.id, 0);
  });

  sftp.on('REMOVE', (req) => {
    const p = norm(req.path);
    if (!vfs.delete(p)) return sftp.status(req.id, 2);
    sftp.status(req.id, 0);
  });

  sftp.on('RENAME', (req) => {
    const from = norm(req.oldPath);
    const to = norm(req.newPath);
    const data = vfs.get(from);
    if (!data) return sftp.status(req.id, 2);
    vfs.delete(from);
    mkdirp(path.posix.dirname(to));
    vfs.set(to, data);
    sftp.status(req.id, 0);
  });

  sftp.on('SETSTAT', (req) => {
    const p = norm(req.path);
    if (typeof req.attrs?.mode === 'number') vfs.set('__mode__' + p, Buffer.from(String(req.attrs.mode)));
    sftp.status(req.id, 0);
  });
}

const server = new Server({ hostKeys: [privateKey] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === 'tester' && ctx.password === 'secret123') {
      ctx.accept();
    } else if (ctx.method === 'none') {
      ctx.reject(['password']);
    } else {
      ctx.reject();
    }
  });

  client.on('ready', () => {
    // 关键：'sftp' 事件必须挂在 session 上（ssh2 内部是 session.emit('sftp')）
    client.on('session', (acceptSession) => {
      const session = acceptSession();
      session.on('sftp', (acceptSftp) => {
        const sftp = acceptSftp();
        if (sftp) attachSftp(sftp);
      });
    });
  });
});

/* ------------------------------ 测试主体 ------------------------------ */

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.log(`  ✗ ${msg}`);
    failures++;
  }
}

function waitFor(cond, timeoutMs) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (cond()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error('等待超时'));
      setTimeout(tick, 25);
    };
    tick();
  });
}

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  console.log(`SFTP 服务端: 127.0.0.1:${port}\n`);

  const { SshSession } = await import('../dist/main/main/ssh.js');
  const { TransferQueue } = await import('../dist/main/main/transfer.js');

  const session = new SshSession();
  const profile = {
    id: 't',
    name: 't',
    host: '127.0.0.1',
    port,
    username: 'tester',
    authMethod: 'password',
    remotePath: '/',
  };

  console.log('[1] 连接与认证');
  await session.connect(profile, { method: 'password', password: 'secret123' });
  assert(session.isConnected, 'SSH 认证并建立 SFTP 会话');

  console.log('\n[2] 错误密码');
  const bad = new SshSession();
  let badCode = null;
  try {
    await bad.connect(profile, { method: 'password', password: 'wrong' });
  } catch (e) {
    badCode = e.code;
  }
  assert(badCode === 'AUTH_FAILED', `错误密码识别为 AUTH_FAILED (实际=${badCode})`);
  await bad.disconnect();

  console.log('\n[3] 列目录');
  vdirs.add('/docs');
  vfs.set('/docs/readme.txt', Buffer.from('hello transius'));
  const listing = await session.listRemote('/');
  assert(
    listing.entries.some((e) => e.name === 'docs' && e.type === 'd'),
    '识别出子目录 docs',
  );
  assert(
    listing.entries.some((e) => e.name === 'docs'),
    '目录条目返回正确',
  );

  const queue = new TransferQueue(
    () => (session.isConnected ? session : null),
    () => 2,
  );
  const states = new Map();
  const progress = new Map();
  queue.onState((e) => states.set(e.id, e.state));
  queue.onProgress((e) => progress.set(e.id, e));

  const localTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'transius-e2e-'));
  const downTmp = await fs.mkdtemp(path.join(os.tmpdir(), 'transius-e2e-down-'));

  console.log('\n[4] 上传单文件（300KB）');
  const upSrc = path.join(localTmp, 'upload.bin');
  const payload = Buffer.alloc(300 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
  await fs.writeFile(upSrc, payload);

  const [upId] = await queue.enqueue([
    {
      direction: 'upload',
      localPath: upSrc,
      remotePath: '/upload.bin',
      name: 'upload.bin',
      isDirectory: false,
      size: payload.length,
    },
  ]);
  await waitFor(() => ['completed', 'error'].includes(states.get(upId)), 15000);
  assert(states.get(upId) === 'completed', `上传完成 (状态=${states.get(upId)})`);
  const remoteData = vfs.get('/upload.bin') ?? Buffer.alloc(0);
  assert(remoteData.length === payload.length, `远端大小一致 (${remoteData.length}/${payload.length})`);
  assert(Buffer.compare(remoteData, payload) === 0, '上传内容逐字节一致');

  console.log('\n[5] 下载单文件');
  const downDst = path.join(downTmp, 'downloaded.bin');
  const [downId] = await queue.enqueue([
    {
      direction: 'download',
      localPath: downDst,
      remotePath: '/upload.bin',
      name: 'upload.bin',
      isDirectory: false,
      size: payload.length,
    },
  ]);
  await waitFor(() => ['completed', 'error'].includes(states.get(downId)), 15000);
  assert(states.get(downId) === 'completed', `下载完成 (状态=${states.get(downId)})`);
  const got = await fs.readFile(downDst);
  assert(Buffer.compare(got, payload) === 0, '下载内容逐字节一致');

  console.log('\n[6] 递归上传目录（3 层）');
  const tree = path.join(localTmp, 'tree');
  await fs.mkdir(path.join(tree, 'a', 'b'), { recursive: true });
  await fs.writeFile(path.join(tree, 'root.txt'), 'root-content');
  await fs.writeFile(path.join(tree, 'a', 'a.txt'), 'a-content');
  await fs.writeFile(path.join(tree, 'a', 'b', 'b.txt'), 'b-content');

  const [treeUpId] = await queue.enqueue([
    {
      direction: 'upload',
      localPath: tree,
      remotePath: '/tree',
      name: 'tree',
      isDirectory: true,
      size: 0,
    },
  ]);
  await waitFor(() => ['completed', 'error'].includes(states.get(treeUpId)), 25000);
  assert(states.get(treeUpId) === 'completed', `目录上传完成 (状态=${states.get(treeUpId)})`);
  assert(vfs.get('/tree/root.txt')?.toString() === 'root-content', '根层文件正确');
  assert(vfs.get('/tree/a/a.txt')?.toString() === 'a-content', '第 1 层嵌套正确');
  assert(vfs.get('/tree/a/b/b.txt')?.toString() === 'b-content', '第 2 层嵌套正确');
  const p = progress.get(treeUpId);
  assert(p?.fileCount === 3, `统计到 3 个文件 (实际=${p?.fileCount})`);
  assert(p?.transferred === p?.size, '进度累计等于总大小');

  console.log('\n[7] 递归下载目录');
  const outTree = path.join(downTmp, 'tree-out');
  const [treeDownId] = await queue.enqueue([
    {
      direction: 'download',
      localPath: outTree,
      remotePath: '/tree',
      name: 'tree',
      isDirectory: true,
      size: 0,
    },
  ]);
  await waitFor(() => ['completed', 'error'].includes(states.get(treeDownId)), 25000);
  assert(states.get(treeDownId) === 'completed', `目录下载完成 (状态=${states.get(treeDownId)})`);
  assert(
    (await fs.readFile(path.join(outTree, 'a', 'b', 'b.txt'))).toString() === 'b-content',
    '嵌套目录结构被还原',
  );

  console.log('\n[8] 远程目录操作');
  await session.mkdirp('/newdir/sub');
  assert(vdirs.has('/newdir/sub'), 'mkdirp 递归建目录');
  await session.rename('/newdir/sub', '/newdir/renamed');
  assert(!vdirs.has('/newdir/sub') && vdirs.has('/newdir/renamed'), '重命名生效');
  await session.chmod('/upload.bin', 0o755);
  assert(true, 'chmod 调用未报错');
  await session.remove('/tree', true);
  assert(!vdirs.has('/tree') && !vfs.has('/tree/root.txt'), '递归删除目录');

  console.log('\n[9] 断点续传语义');
  const big = Buffer.alloc(128 * 1024, 7);
  vfs.set('/resume.bin', big);
  const resumeDst = path.join(downTmp, 'resume.bin');
  // 预先写入一半内容，模拟已下载部分
  await fs.writeFile(resumeDst, big.subarray(0, 64 * 1024));
  const [resumeId] = await queue.enqueue([
    {
      direction: 'download',
      localPath: resumeDst,
      remotePath: '/resume.bin',
      name: 'resume.bin',
      isDirectory: false,
      size: big.length,
    },
  ]);
  await waitFor(() => ['completed', 'error'].includes(states.get(resumeId)), 15000);
  assert(states.get(resumeId) === 'completed', '续传任务完成');

  await session.disconnect();
  queue.dispose();
  await fs.rm(localTmp, { recursive: true, force: true });
  await fs.rm(downTmp, { recursive: true, force: true });

  server.close();
  console.log(`\n${failures === 0 ? '全部通过 ✓' : `${failures} 项失败 ✗`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('\n测试异常:', e);
  server.close();
  process.exit(1);
});
