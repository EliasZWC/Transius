import { createContext, useContext } from 'react';
import type {
  AppSettings,
  ConnectRequest,
  ConnectionProfile,
  ConnectionProfileInput,
  DirectoryListing,
  TransferItem,
} from '@shared/types';

export type Side = 'local' | 'remote';

export interface DropItem {
  path: string;
  name: string;
  isDirectory: boolean;
  size: number;
}

export interface AppState {
  connected: boolean;
  host?: string;
  profiles: ConnectionProfile[];
  settings: AppSettings;
  local: DirectoryListing | null;
  remote: DirectoryListing | null;
  transfers: TransferItem[];
  busy: boolean;
  toast: { kind: 'error' | 'info'; text: string } | null;
}

export interface AppActions {
  refreshProfiles: () => Promise<void>;
  saveProfile: (input: ConnectionProfileInput) => Promise<boolean>;
  deleteProfile: (id: string) => Promise<void>;
  connect: (req: ConnectRequest) => Promise<boolean>;
  disconnect: () => Promise<void>;
  /** 已建立连接后，重新同步连接状态与两个目录面板 */
  refreshConnection: () => Promise<void>;

  navigateLocal: (dir: string | null) => Promise<void>;
  navigateRemote: (dir: string | null) => Promise<void>;
  refreshBoth: () => Promise<void>;

  enqueueUpload: (localPaths: string[]) => Promise<void>;
  enqueueDownload: (remoteNames: string[]) => Promise<void>;
  enqueueDrop: (from: Side, items: DropItem[]) => Promise<void>;

  pauseTransfer: (id: string) => Promise<void>;
  resumeTransfer: (id: string) => Promise<void>;
  cancelTransfer: (id: string) => Promise<void>;
  retryTransfer: (id: string) => Promise<void>;
  removeTransfer: (id: string) => Promise<void>;
  clearFinished: () => Promise<void>;

  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  showError: (text: string) => void;
  showInfo: (text: string) => void;
  clearToast: () => void;
}

export const AppStateContext = createContext<AppState | null>(null);
export const AppActionsContext = createContext<AppActions | null>(null);

export function useAppState(): AppState {
  const ctx = useContext(AppStateContext);
  if (!ctx) throw new Error('useAppState must be used inside AppProvider');
  return ctx;
}

export function useAppActions(): AppActions {
  const ctx = useContext(AppActionsContext);
  if (!ctx) throw new Error('useAppActions must be used inside AppProvider');
  return ctx;
}
