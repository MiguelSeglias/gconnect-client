import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { parseStoredTokens, type StoredTokens } from './auth/tokens';
import type { TokenStore } from './token-store';

/**
 * Node-only token store writing a JSON file with owner-only permissions (0600, parent
 * directory 0700). Writes are atomic (temp file + rename). Symlinked token files are refused.
 * The file is NOT encrypted — for servers prefer a custom {@link TokenStore} that encrypts.
 */
export class FileTokenStore implements TokenStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<StoredTokens | null> {
    try {
      const stat = await lstat(this.filePath);
      if (stat.isSymbolicLink()) throw new Error('Token file must not be a symlink');
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
    const text = await readFile(this.filePath, 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error('Token file is not valid JSON');
    }
    const tokens = parseStoredTokens(parsed);
    if (!tokens) throw new Error('Token file has an unexpected format');
    return tokens;
  }

  async save(tokens: StoredTokens): Promise<void> {
    const dir = dirname(this.filePath);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${basename(this.filePath)}.${randomBytes(8).toString('hex')}.tmp`);
    const handle = await open(tmp, 'wx', 0o600);
    try {
      await handle.writeFile(JSON.stringify(tokens), 'utf8');
    } finally {
      await handle.close();
    }
    try {
      await chmod(tmp, 0o600);
      await rename(tmp, this.filePath);
    } catch (err) {
      await rm(tmp, { force: true });
      throw err;
    }
  }

  async clear(): Promise<void> {
    await rm(this.filePath, { force: true });
  }
}

function isNotFound(err: unknown): boolean {
  return typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT';
}
