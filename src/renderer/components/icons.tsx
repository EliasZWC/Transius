import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement> & { size?: number };

/**
 * 图标规范（House Style）：
 * · 24×24 viewBox
 * · 纯灰阶，颜色继承 currentColor（由 CSS 决定灰阶档位）
 * · 必须显式给 width/height —— 未指定尺寸的 svg 在 flex 里会撑满父元素
 *
 * 线条粗细用 1.8，与 Material Icons 的 2px 视觉重量接近但不显笨重。
 */
function make(path: React.ReactNode) {
  return function Icon({ size = 16, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
        style={{ flexShrink: 0 }}
        {...rest}
      >
        {path}
      </svg>
    );
  };
}

/** 实心版本（用于选中态 / 强调） */
function makeFilled(path: React.ReactNode) {
  return function Icon({ size = 16, ...rest }: IconProps) {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        style={{ flexShrink: 0 }}
        {...rest}
      >
        {path}
      </svg>
    );
  };
}

/* ── Material Icons 线性版本 ─────────────────────────────────────────────── */

export const IconFolder = make(
  <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z" />,
);

export const IconFolderFilled = makeFilled(
  <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z" />,
);

export const IconFile = make(
  <>
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
    <path d="M14 2v6h6" />
  </>,
);

export const IconLink = make(
  <>
    <path d="M10 13a5 5 0 0 0 7 0l2-2a5 5 0 0 0-7-7l-1 1" />
    <path d="M14 11a5 5 0 0 0-7 0l-2 2a5 5 0 0 0 7 7l1-1" />
  </>,
);

export const IconUpload = make(
  <>
    <path d="M12 16V4" />
    <path d="m7 9 5-5 5 5" />
    <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </>,
);

export const IconDownload = make(
  <>
    <path d="M12 4v12" />
    <path d="m7 11 5 5 5-5" />
    <path d="M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3" />
  </>,
);

export const IconRefresh = make(
  <>
    <path d="M21 12a9 9 0 1 1-3-6.7" />
    <path d="M21 4v5h-5" />
  </>,
);

export const IconArrowUp = make(
  <>
    <path d="M12 19V5" />
    <path d="m5 12 7-7 7 7" />
  </>,
);

export const IconHome = make(
  <>
    <path d="M3 10.5 12 3l9 7.5" />
    <path d="M5 10v10h14V10" />
  </>,
);

export const IconAdd = make(
  <>
    <path d="M12 5v14" />
    <path d="M5 12h14" />
  </>,
);

export const IconDelete = make(
  <>
    <path d="M4 7h16" />
    <path d="M9 7V4h6v3" />
    <path d="M6 7v13a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V7" />
    <path d="M10 11v6M14 11v6" />
  </>,
);

export const IconEdit = make(
  <>
    <path d="M12 20h9" />
    <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z" />
  </>,
);

export const IconCreateFolder = make(
  <>
    <path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8z" />
    <path d="M12 11v5M9.5 13.5h5" />
  </>,
);

export const IconPause = makeFilled(
  <>
    <rect x="7" y="5" width="3.6" height="14" rx="1" />
    <rect x="13.4" y="5" width="3.6" height="14" rx="1" />
  </>,
);

export const IconPlay = makeFilled(<path d="M8 5.5v13l11-6.5z" />);

export const IconClose = make(
  <>
    <path d="M6 6l12 12" />
    <path d="M18 6 6 18" />
  </>,
);

export const IconRetry = make(
  <>
    <path d="M21 12a9 9 0 1 1-2.6-6.4" />
    <path d="M21 3v6h-6" />
  </>,
);

export const IconChevronDown = make(<path d="m6 9 6 6 6-6" />);
export const IconChevronRight = make(<path d="m9 6 6 6-6 6" />);
export const IconChevronUp = make(<path d="m6 15 6-6 6 6" />);

export const IconSettings = make(
  <>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
  </>,
);

export const IconServer = make(
  <>
    <rect x="3" y="4" width="18" height="7" rx="1.5" />
    <rect x="3" y="13" width="18" height="7" rx="1.5" />
    <path d="M7 7.5h.01M7 16.5h.01" />
  </>,
);

export const IconPlug = make(
  <>
    <path d="M9 3v6M15 3v6" />
    <path d="M6 9h12v3a6 6 0 0 1-12 0z" />
    <path d="M12 18v3" />
  </>,
);

export const IconLock = make(
  <>
    <rect x="4.5" y="10" width="15" height="10" rx="2" />
    <path d="M8 10V7a4 4 0 0 1 8 0v3" />
  </>,
);

export const IconKey = make(
  <>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 8-8 2 2-2 2 2 2-3 3-2-2-2 2" />
  </>,
);

export const IconLoader = make(<path d="M12 3a9 9 0 1 0 9 9" strokeWidth={2} />);

export const IconTransfer = make(
  <>
    <path d="M4 8h13" />
    <path d="m14 5 3 3-3 3" />
    <path d="M20 16H7" />
    <path d="m10 13-3 3 3 3" />
  </>,
);

export const IconExternal = make(
  <>
    <path d="M14 4h6v6" />
    <path d="M20 4 11 13" />
    <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
  </>,
);

export const IconSearch = make(
  <>
    <circle cx="11" cy="11" r="7" />
    <path d="m20 20-3.5-3.5" />
  </>,
);

export const IconCheck = make(<path d="m4 12 5 5L20 6" />);

/**
 * 品牌标：House Style 不允许高饱和色，因此用两个灰阶层字重
 * 表达「双向传输」的语义，而不是蓝绿渐变。
 */
export const Logo = ({ size = 20 }: { size?: number }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 32 32"
    className="brand-logo"
    aria-hidden="true"
    style={{ flexShrink: 0 }}
  >
    <rect
      x="0.9"
      y="0.9"
      width="30.2"
      height="30.2"
      rx="8"
      fill="#1B1B1B"
      stroke="#333333"
      strokeWidth="1.2"
    />
    <path
      d="M8.5 12.5h11"
      stroke="#ECECEA"
      strokeWidth="2.2"
      strokeLinecap="round"
      fill="none"
    />
    <path
      d="m16.2 8.8 4 3.7-4 3.7"
      stroke="#ECECEA"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
    <path
      d="M23.5 19.5h-11"
      stroke="#9A9A98"
      strokeWidth="2.2"
      strokeLinecap="round"
      fill="none"
    />
    <path
      d="m15.8 15.8-4 3.7 4 3.7"
      stroke="#9A9A98"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
    />
  </svg>
);
