import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEYCHAIN_SERVICE = 'LumaFlux Intelligence';
const KEYCHAIN_ACCOUNT = 'lumaflux-vault-master-key';

interface VaultEntry {
  v: number;
  alg: 'aes-256-gcm';
  iv: string;
  tag: string;
  data: string;
}

interface VaultDoc {
  version: number;
  backend: string;
  entries: Record<string, VaultEntry>;
}

function chmodOwnerOnly(filePath: string): void {
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Non-fatal
    }
  }
}

export class CredentialVault {
  public readonly vaultDir: string;
  public readonly vaultPath: string;
  public readonly keyPath: string;
  public readonly dpapiKeyPath: string;

  constructor(vaultDir: string) {
    this.vaultDir = path.resolve(vaultDir);
    fs.mkdirSync(this.vaultDir, { recursive: true });
    this.vaultPath = path.join(this.vaultDir, '.vault.json');
    this.keyPath = path.join(this.vaultDir, '.vault.key');
    this.dpapiKeyPath = path.join(this.vaultDir, '.vault.key.dpapi');
  }

  public get backendName(): string {
    if (process.platform === 'win32' && fs.existsSync(this.dpapiKeyPath)) {
      return 'windows-dpapi+aes-256-gcm';
    }
    if (process.platform === 'darwin') {
      return 'macos-keychain+aes-256-gcm';
    }
    return 'aes-256-gcm-file-key';
  }

  private getOrCreateMasterKey(): Buffer {
    if (process.platform === 'darwin') {
      try {
        const out = execFileSync(
          'security',
          ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w'],
          { timeout: 3000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
        ).trim();
        if (out.length === 64) {
          return Buffer.from(out, 'hex');
        }
      } catch {
        // Fallback below
      }
    }

    if (fs.existsSync(this.keyPath)) {
      const hex = fs.readFileSync(this.keyPath, 'utf8').trim();
      if (hex.length === 64) {
        return Buffer.from(hex, 'hex');
      }
    }

    const masterKey = crypto.randomBytes(32);
    const masterHex = masterKey.toString('hex');

    if (process.platform === 'darwin') {
      try {
        execFileSync(
          'security',
          ['add-generic-password', '-U', '-s', KEYCHAIN_SERVICE, '-a', KEYCHAIN_ACCOUNT, '-w', masterHex],
          { timeout: 3000, stdio: 'ignore' }
        );
        return masterKey;
      } catch {
        // Fallback to file key
      }
    }

    fs.writeFileSync(this.keyPath, masterHex, { encoding: 'utf8', mode: 0o600 });
    chmodOwnerOnly(this.keyPath);
    return masterKey;
  }

  private loadVaultDoc(): VaultDoc {
    if (!fs.existsSync(this.vaultPath)) {
      return { version: 1, backend: this.backendName, entries: {} };
    }
    try {
      const parsed = JSON.parse(fs.readFileSync(this.vaultPath, 'utf8')) as VaultDoc;
      if (parsed && typeof parsed.entries === 'object' && parsed.entries !== null) {
        return parsed;
      }
    } catch {
      // Recover empty structure
    }
    return { version: 1, backend: this.backendName, entries: {} };
  }

  private saveVaultDoc(doc: VaultDoc): void {
    fs.mkdirSync(this.vaultDir, { recursive: true });
    fs.writeFileSync(this.vaultPath, JSON.stringify(doc, null, 2), { encoding: 'utf8', mode: 0o600 });
    chmodOwnerOnly(this.vaultPath);
  }

  public setSecret(ref: string, secretValue: string): string {
    if (!ref) throw new Error('Credential reference id is required.');
    const key = this.getOrCreateMasterKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(Buffer.from(ref, 'utf8'));
    const encrypted = Buffer.concat([cipher.update(secretValue, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();

    const doc = this.loadVaultDoc();
    doc.backend = this.backendName;
    doc.entries[ref] = {
      v: 1,
      alg: 'aes-256-gcm',
      iv: iv.toString('base64'),
      tag: tag.toString('base64'),
      data: encrypted.toString('base64'),
    };
    this.saveVaultDoc(doc);
    return ref;
  }

  public getSecret(ref: string | null | undefined): string | null {
    if (!ref) return null;
    const doc = this.loadVaultDoc();
    const entry = doc.entries?.[ref];
    if (!entry) return null;
    try {
      const key = this.getOrCreateMasterKey();
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(entry.iv, 'base64'));
      decipher.setAAD(Buffer.from(ref, 'utf8'));
      decipher.setAuthTag(Buffer.from(entry.tag, 'base64'));
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(entry.data, 'base64')),
        decipher.final(),
      ]);
      return decrypted.toString('utf8');
    } catch {
      return null;
    }
  }

  public hasSecret(ref: string | null | undefined): boolean {
    if (!ref) return false;
    const doc = this.loadVaultDoc();
    return Boolean(doc.entries && ref in doc.entries);
  }

  public deleteSecret(ref: string | null | undefined): boolean {
    if (!ref) return false;
    const doc = this.loadVaultDoc();
    if (!doc.entries || !(ref in doc.entries)) return false;
    delete doc.entries[ref];
    this.saveVaultDoc(doc);
    return true;
  }
}

export function stripUriCredentials(uri: string): {
  cleanUri: string;
  username: string | null;
  password: string | null;
} {
  const raw = (uri || '').trim();
  if (!raw || !raw.includes('://')) {
    return { cleanUri: raw, username: null, password: null };
  }
  try {
    const parsed = new URL(raw);
    const scheme = parsed.protocol.replace(':', '').toLowerCase();
    if (!['rtsp', 'rtsps', 'http', 'https'].includes(scheme)) {
      return { cleanUri: raw, username: null, password: null };
    }
    const username = parsed.username ? decodeURIComponent(parsed.username) : null;
    const password = parsed.password ? decodeURIComponent(parsed.password) : null;
    if (!username && !password) {
      return { cleanUri: raw, username: null, password: null };
    }
    parsed.username = '';
    parsed.password = '';
    return { cleanUri: parsed.toString(), username, password };
  } catch {
    return { cleanUri: raw, username: null, password: null };
  }
}

export function injectUriCredentials(
  uri: string,
  username: string | null | undefined,
  password: string | null | undefined
): string {
  const raw = (uri || '').trim();
  if (!raw || !raw.includes('://') || (!username && !password)) {
    return raw;
  }
  try {
    const parsed = new URL(raw);
    const scheme = parsed.protocol.replace(':', '').toLowerCase();
    if (!['rtsp', 'rtsps', 'http', 'https'].includes(scheme)) {
      return raw;
    }
    if (parsed.username || parsed.password) {
      return raw;
    }
    if (username) parsed.username = username;
    if (password) parsed.password = password;
    return parsed.toString();
  } catch {
    return raw;
  }
}
