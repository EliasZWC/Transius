import { createContext, useContext } from 'react';
import type { DictKey } from './dict';
import type { Lang } from './dict';

export interface I18nContextValue {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: DictKey, vars?: Record<string, string | number>) => string;
  /** 把主进程返回的 `CODE: message` 转成可读文案 */
  tError: (raw: string) => string;
}

export const I18nContext = createContext<I18nContextValue | null>(null);

export function useI18n(): I18nContextValue {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error('useI18n must be used inside I18nProvider');
  return ctx;
}
