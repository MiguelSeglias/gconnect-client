/**
 * A TokenStore that keeps tokens encrypted (AES-256-GCM) in your own database.
 * `db` is a placeholder for your persistence layer. The key comes from env (32 bytes, base64).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import {
  GarminConnectClient,
  parseStoredTokens,
  type StoredTokens,
  type TokenStore,
} from 'gconnect-client';

interface Db {
  get(userId: string): Promise<string | null>;
  set(userId: string, value: string): Promise<void>;
  delete(userId: string): Promise<void>;
}

class EncryptedDbTokenStore implements TokenStore {
  constructor(
    private readonly db: Db,
    private readonly userId: string,
    private readonly key: Buffer,
  ) {}

  async load(): Promise<StoredTokens | null> {
    const stored = await this.db.get(this.userId);
    if (stored === null) return null;
    const [iv, tag, data] = stored.split('.').map((part) => Buffer.from(part, 'base64'));
    if (!iv || !tag || !data) return null;
    const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    const json = Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    return parseStoredTokens(JSON.parse(json));
  }

  async save(tokens: StoredTokens): Promise<void> {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
    const value = [iv, cipher.getAuthTag(), data].map((b) => b.toString('base64')).join('.');
    await this.db.set(this.userId, value);
  }

  async clear(): Promise<void> {
    await this.db.delete(this.userId);
  }
}

// In-memory stand-in for a real database, so the example runs as-is.
const rows = new Map<string, string>();
const db: Db = {
  get: (id) => Promise.resolve(rows.get(id) ?? null),
  set: (id, value) => Promise.resolve(void rows.set(id, value)),
  delete: (id) => Promise.resolve(void rows.delete(id)),
};

const keyB64 = process.env.TOKEN_ENCRYPTION_KEY;
if (!keyB64) throw new Error('Set TOKEN_ENCRYPTION_KEY (32 random bytes, base64)');

const client = new GarminConnectClient({
  tokenStore: new EncryptedDbTokenStore(db, 'user-123', Buffer.from(keyB64, 'base64')),
});
process.stdout.write(`authenticated: ${String(await client.isAuthenticated())}\n`);
