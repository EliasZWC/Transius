import { useEffect, useState } from 'react';
import type { WindowState } from '@shared/types';
import { useI18n } from '../i18n/context';
import { useAppActions, useAppState } from '../state/context';
import { IconSettings, IconClose, Logo } from './icons';

/** Windows 11 标题栏按钮的几何尺寸（单位 px，跟随系统一致） */
const BTN_W = 46;
const BAR_H = 32;

/**
 * 自绘标题栏。
 *
 * Windows 风格要点：
 * · 高度 32px，按钮 46×32 贴右边缘，无圆角、无内边距
 * · 关闭按钮悬停变红 #C42B1C，按下更深 #B2271B（这是 Windows 的硬约定）
 * · 最小化/最大化悬停是极淡的白遮罩（深色主题下约 4.5%）
 * · 拖拽区必须避开按钮：按钮设 -webkit-app-region: no-drag
 * · 双击标题栏空白处 = 切换最大化（由 app-region: drag 自动实现）
 */
export function TitleBar() {
  const { t, lang, setLang } = useI18n();
  const { connected, host } = useAppState();
  const { updateSettings } = useAppActions();
  const [state, setState] = useState<WindowState>({
    maximized: false,
    fullscreen: false,
    focused: true,
  });

  useEffect(() => {
    // 首帧主动查询一次，避免图标闪一下
    void window.transius.win.queryState().then((r) => {
      if (r.ok) setState(r.data);
    });
    return window.transius.win.onState(setState);
  }, []);

  const toggleLang = () => {
    const next = lang === 'zh' ? 'en' : 'zh';
    setLang(next);
    void updateSettings({ language: next });
  };

  const isMax = state.maximized;

  return (
    <header
      className={`titlebar${state.focused ? '' : ' is-blurred'}`}
      style={{ height: BAR_H }}
      onDoubleClick={(e) => {
        // 双击按钮区域不应触发最大化
        if ((e.target as HTMLElement).closest('.titlebar-btn')) return;
        void window.transius.win.toggleMaximize();
      }}
    >
      {/* 品牌区：随标题栏一起可拖动 */}
      <div className="titlebar-brand">
        <Logo size={16} />
        <span className="titlebar-title">{t('app.name')}</span>
      </div>

      <div className="titlebar-drag" />

      {/* 连接状态：紧凑显示，不抢主视觉 */}
      <div className={`titlebar-status${connected ? ' on' : ''}`}>
        <span className="dot" />
        <span className="label">
          {connected ? t('conn.connected') : t('conn.disconnected')}
        </span>
        {connected && host && <span className="host">{host}</span>}
      </div>

      {/* 语言切换与设置：放在标题栏，与 Windows 应用的紧凑工具区一致 */}
      <button
        className="titlebar-tool"
        onClick={toggleLang}
        title={t('settings.language')}
        tabIndex={-1}
      >
        {lang === 'zh' ? 'EN' : '中'}
      </button>
      <button
        className="titlebar-tool"
        title={t('settings.title')}
        tabIndex={-1}
      >
        <IconSettings size={14} />
      </button>

      {/* 窗口控制按钮组 */}
      <div className="titlebar-controls">
        <button
          className="titlebar-btn"
          style={{ width: BTN_W, height: BAR_H }}
          onClick={() => void window.transius.win.minimize()}
          title={t('win.minimize')}
          aria-label={t('win.minimize')}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>

        <button
          className="titlebar-btn"
          style={{ width: BTN_W, height: BAR_H }}
          onClick={() => void window.transius.win.toggleMaximize()}
          title={isMax ? t('win.restore') : t('win.maximize')}
          aria-label={isMax ? t('win.restore') : t('win.maximize')}
        >
          {isMax ? (
            // 还原图标：两个叠放的方框
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect
                x="0.5"
                y="2.5"
                width="7"
                height="7"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
              <path
                d="M2.5 2.5V0.5h7v7h-2"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          ) : (
            // 最大化图标：单方框
            <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
              <rect
                x="0.5"
                y="0.5"
                width="9"
                height="9"
                fill="none"
                stroke="currentColor"
                strokeWidth="1"
              />
            </svg>
          )}
        </button>

        <button
          className="titlebar-btn close"
          style={{ width: BTN_W, height: BAR_H }}
          onClick={() => void window.transius.win.close()}
          title={t('win.close')}
          aria-label={t('win.close')}
        >
          <IconClose size={12} />
        </button>
      </div>
    </header>
  );
}
