import type { TransiusApi } from '@shared/types';

declare global {
  interface Window {
    transius: TransiusApi;
  }
}

export {};
