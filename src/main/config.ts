import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  AppSettings,
  ConnectionProfile,
  ConnectionProfileInput,
} from '../shared/types';

interface SecretRecord {
  /** 经 safeStorage 加密后的 base64；无法加密时降级为明文并置 plain=true */
  data: string;
  plain?: boolean;
  password?: string;
  passphrase?: string;
  privateKey?: string;
}

interface StoreShape {
  version: 1;
  profiles: ConnectionProfile[];
  /**
   * 秘密仅在内存 + 加密文件中存在，永不返回给渲染进程读取接口。
   * 键为 profileId。
   */
  secrets: Record<string, SecretRecord>;
}

const DEFAULT_SETTINGS: AppSettings = {
  language: 'zh',
  concurrency: 3,
  confirmBeforeOverwrite: true,
  showHiddenFiles: false,
};

/**
 * 简单的 JSON 配置仓库。
 * - profiles：连接配置，明文保存（不含密码）
 * - secrets：密码/口令/私钥，用 Electron safeStorage 加密后单独保存
 */
export class ConfigStore {
  private filePath: string;
  private settingsPath: string;
  private data: StoreShape = { version: 1, profiles: [], secrets: {} };
  private settings: AppSettings = { ...DEFAULT_SETTINGS };
  private loaded = false;
  private writeChain: Promise<void> = Promise.resolve();

  constructor() {
    const dir = app.getPath('userData');
    this.filePath = path.join(dir, 'connections.json');
    this.settingsPath = path.join(dir, 'settings.json');
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Partial<StoreShape>;
      this.data = {
        version: 1,
        profiles: Array.isArray(parsed.profiles) ? parsed.profiles : [],
        secrets: parsed.secrets && typeof parsed.secrets === 'object' ? parsed.secrets : {},
      };
    } catch {
      // 首次启动或文件损坏：使用空数据，不阻断应用启动
      this.data = { version: 1, profiles: [], secrets: {} };
    }
    try {
      const raw = await fs.readFile(this.settingsPath, 'utf8');
      this.settings = { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<AppSettings>) };
    } catch {
      this.settings = { ...DEFAULT_SETTINGS };
    }
  }

  private persist(): Promise<void> {
    // 串行化写入，避免并发写导致文件截断
    this.writeChain = this.writeChain.then(async () => {
      const tmp = `${this.filePath}.tmp`;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      await fs.rename(tmp, this.filePath);
    });
    return this.writeChain;
  }

  listProfiles(): ConnectionProfile[] {
    return this.data.profiles.map((p) => ({ ...p }));
  }

  getProfile(id: string): ConnectionProfile | undefined {
    const p = this.data.profiles.find((x) => x.id === id);
    return p ? { ...p } : undefined;
  }

  async saveProfile(input: ConnectionProfileInput): Promise<ConnectionProfile> {
    const id = input.id ?? randomUUID();
    const existing = this.data.profiles.find((p) => p.id === id);
    const profile: ConnectionProfile = {
      id,
      name: input.name.trim() || input.host,
      host: input.host.trim(),
      port: Number(input.port) || 22,
      username: input.username.trim(),
      authMethod: input.authMethod,
      privateKeyPath: input.privateKeyPath,
      remotePath: input.remotePath || '/',
      localPath: input.localPath,
      lastConnectedAt: existing?.lastConnectedAt,
    };

    if (existing) {
      const idx = this.data.profiles.indexOf(existing);
      this.data.profiles[idx] = profile;
    } else {
      this.data.profiles.push(profile);
    }

    // 仅在本次提供了新秘密时才写入，否则保留旧的
    const hasNewSecret =
      (input.password !== undefined && input.password !== '') ||
      (input.privateKey !== undefined && input.privateKey !== '') ||
      (input.passphrase !== undefined && input.passphrase !== '');
    const existingSecret = this.data.secrets[id];

    if (input.rememberSecret === false) {
      delete this.data.secrets[id];
    } else if (hasNewSecret || existingSecret) {
      this.data.secrets[id] = this.encryptSecrets(id, {
        password: hasNewSecret ? input.password : undefined,
        privateKey: hasNewSecret ? input.privateKey : undefined,
        passphrase: hasNewSecret ? input.passphrase : undefined,
        previous: existingSecret,
      });
    } else {
      delete this.data.secrets[id];
    }

    await this.persist();
    return { ...profile };
  }

  async removeProfile(id: string): Promise<void> {
    this.data.profiles = this.data.profiles.filter((p) => p.id !== id);
    delete this.data.secrets[id];
    await this.persist();
  }

  async touchProfile(id: string): Promise<void> {
    const p = this.data.profiles.find((x) => x.id === id);
    if (!p) return;
    p.lastConnectedAt = Date.now();
    await this.persist();
  }

  /** 读取解密后的秘密，供主进程内部建立连接时使用 */
  getSecrets(id: string): { password?: string; passphrase?: string; privateKey?: string } {
    const rec = this.data.secrets[id];
    if (!rec) return {};
    try {
      if (rec.plain) {
        return { password: rec.password, passphrase: rec.passphrase, privateKey: rec.privateKey };
      }
      if (!safeStorage.isEncryptionAvailable()) return {};
      const json = safeStorage.decryptString(Buffer.from(rec.data, 'base64'));
      return JSON.parse(json) as { password?: string; passphrase?: string; privateKey?: string };
    } catch {
      // 解密失败（如换了机器 / 用户目录），当作没有保存过密码
      return {};
    }
  }

  hasSecrets(id: string): boolean {
    return Boolean(this.data.secrets[id]);
  }

  private encryptSecrets(
    _id: string,
    opts: {
      password?: string;
      passphrase?: string;
      privateKey?: string;
      previous?: SecretRecord;
    },
  ): SecretRecord {
    const prevPlain = opts.previous ? this.getSecretsFromRecord(opts.previous) : {};
    const payload = {
      password: opts.password !== undefined ? opts.password : prevPlain.password,
      passphrase: opts.passphrase !== undefined ? opts.passphrase : prevPlain.passphrase,
      privateKey: opts.privateKey !== undefined ? opts.privateKey : prevPlain.privateKey,
    };
    const json = JSON.stringify(payload);
    if (safeStorage.isEncryptionAvailable()) {
      return { data: safeStorage.encryptString(json).toString('base64') };
    }
    // 系统不支持加密时（部分 Linux 无 keyring），退回明文并明确标记
    return { data: '', plain: true, ...payload };
  }

  private getSecretsFromRecord(rec: SecretRecord) {
    try {
      if (rec.plain) {
        return { password: rec.password, passphrase: rec.passphrase, privateKey: rec.privateKey };
      }
      if (!safeStorage.isEncryptionAvailable()) return {};
      return JSON.parse(
        safeStorage.decryptString(Buffer.from(rec.data, 'base64')),
      ) as { password?: string; passphrase?: string; privateKey?: string };
    } catch {
      return {};
    }
  }

  getSettings(): AppSettings {
    return { ...this.settings };
  }

  async updateSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
    this.settings = { ...this.settings, ...patch };
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
    await fs.writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2), 'utf8');
    return { ...this.settings };
  }
}
