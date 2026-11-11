# Transius

**Version:** 0.1.0

桌面端 SSH 文件传输客户端。双栏本地 ↔ 远程浏览、拖拽传输、带进度/暂停/续传的传输队列。

视觉规范遵循 [`../HouseStyle`](../HouseStyle)（深色灰阶 + 自绘 Windows 标题栏 +
等宽更纱黑体）；桌面端增补见 [`../HouseStyle/desktop.md`](../HouseStyle/desktop.md)。

---

## 运行

```bash
npm install
npm run dev        # 开发（Vite HMR + Electron）
npm start          # 生产构建后启动
npm run package    # 打包安装程序（electron-builder）
```

## 功能

- **连接管理**：密码 / 私钥认证，配置持久化，密码经 Electron `safeStorage` 加密
- **双栏浏览**：本地 ↔ 远程，路径栏可编辑、支持 `~`、隐藏文件开关
- **传输队列**：并发上限可配、实时速度、暂停/续传/重试/取消
- **断点续传**：取消或暂停后从已完成字节继续
- **目录递归**：拖拽目录自动展开为文件任务并建好远端目录树
- **远程操作**：新建目录、重命名、删除（递归）、修改权限
- **拖拽传输**：从任一侧拖到另一侧
- **中英双语**：标题栏右侧 `EN / 中` 切换

## 架构

```
src/
  shared/          两侧共用：类型契约、IPC 通道名、POSIX/本地路径工具
  main/            Electron 主进程
    index.ts       窗口创建 + IPC 注册
    ssh.ts         SshSession：连接、SFTP 列目录/增删改/流式读写
    transfer.ts    TransferQueue：并发调度、进度节流、断点续传
    config.ts      连接配置 + 加密凭据 + 应用设置
  preload/         contextBridge 白名单 API
  renderer/        React UI
    components/    TitleBar / Sidebar / FilePane / TransferPanel / ProfileDialog
    state/         AppProvider：所有副作用集中于此
    i18n/          扁平字典 + Provider
```

**渲染进程不直接访问 Node**：`contextIsolation: true`、`nodeIntegration: false`，
所有文件与网络操作都经 preload 白名单走 IPC。

## 验证脚本

这些脚本不属于打包产物，用于验证核心功能。**都需先启动应用并开放调试端口**：

```bash
npx electron . --remote-debugging-port=9222   # 另开一个终端

node scripts/check-house-style.mjs   # 计算样式是否符合 House Style（含全页高饱和色扫描）
node scripts/check-font.mjs          # 等宽字体是否真正生效（汉/ASCII 宽度比 = 2.00）
node scripts/check-titlebar.mjs      # 标题栏尺寸 + 最小化/最大化/还原
node scripts/inspect-ui.mjs          # DOM 结构探测 + 截图
node scripts/e2e-sftp.mjs            # 端到端：起本地 SFTP 服务，跑完上传/下载/递归/增删改
```

`e2e-sftp.mjs` 不需要调试端口，直接运行即可 —— 它自带服务端。

## 已知限制

- 本地文件删除未实现（只提供「在系统中打开 / 显示位置」），避免误删
- 远程新建文件不支持（只能上传）
- 不记忆窗口尺寸与位置
