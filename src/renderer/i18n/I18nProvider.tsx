import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { dict, type DictKey, type Lang } from './dict';
import { I18nContext, type I18nContextValue } from './context';

/** 已知的错误码，用于 tError 判断 */
const ERROR_CODES = new Set<string>([
  'NO_PROFILE',
  'AUTH_FAILED',
  'NETWORK',
  'HANDSHAKE',
  'NOT_CONNECTED',
  'SFTP',
  'LOCAL_IO',
  'ENOENT',
  'EACCES',
  'ENOSPC',
  'UNKNOWN',
  'REQUIRED',
  'AUTH_REQUIRED',
]);

export function I18nProvider({
  initialLang = 'zh',
  children,
}: {
  initialLang?: Lang;
  children: ReactNode;
}) {
  const [lang, setLang] = useState<Lang>(initialLang);

  const t = useCallback(
    (key: DictKey, vars?: Record<string, string | number>) => {
      const entry = dict[key];
      let text: string = entry ? entry[lang] : key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          text = text.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
        }
      }
      return text;
    },
    [lang],
  );

  const tError = useCallback(
    (raw: string) => {
      if (!raw) return '';
      // 主进程格式："CODE: detail"
      const m = /^([A-Z_]+):\s*([\s\S]*)$/.exec(raw);
      if (m && ERROR_CODES.has(m[1])) {
        const key = `err.${m[1]}` as DictKey;
        if (dict[key]) {
          const base = dict[key][lang];
          // NT 类错误附上原始细节，方便排查
          return m[2] && m[2] !== raw ? `${base} (${m[2].slice(0, 200)})` : base;
        }
      }
      return raw;
    },
    [lang],
  );

  const value = useMemo<I18nContextValue>(
    () => ({ lang, setLang, t, tError }),
    [lang, t, tError],
  );

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}
