import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileTokenStore, MemoryTokenStore, parseStoredTokens, type StoredTokens } from '../src';
import { CookieJar } from '../src/auth/cookie-jar';

const tokens: StoredTokens = {
  version: 1,
  accessToken: 'fake-access-token',
  refreshToken: 'fake-refresh-token',
  clientId: 'FAKE_CLIENT',
  expiresAt: 1_800_000_000,
};

describe('FileTokenStore', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'gconnect-test-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips tokens with 0600 permissions', async () => {
    const file = join(dir, 'nested', 'garmin.tokens.json');
    const store = new FileTokenStore(file);
    expect(await store.load()).toBeNull();
    await store.save(tokens);
    expect(await store.load()).toEqual(tokens);
    if (process.platform !== 'win32') {
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await stat(join(dir, 'nested'))).mode & 0o777).toBe(0o700);
    }
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  it('refuses symlinks and malformed files', async () => {
    const real = join(dir, 'real.json');
    await writeFile(real, JSON.stringify(tokens));
    const link = join(dir, 'link.json');
    await symlink(real, link);
    await expect(new FileTokenStore(link).load()).rejects.toThrow(/symlink/);
    await writeFile(real, '{"version":2}');
    await expect(new FileTokenStore(real).load()).rejects.toThrow(/format/);
    expect(await readFile(real, 'utf8')).toBe('{"version":2}');
  });
});

describe('MemoryTokenStore / parseStoredTokens', () => {
  it('returns copies', async () => {
    const store = new MemoryTokenStore();
    await store.save(tokens);
    const loaded = await store.load();
    if (loaded) loaded.accessToken = 'mutated';
    expect((await store.load())?.accessToken).toBe('fake-access-token');
  });

  it('validates stored token objects', () => {
    expect(parseStoredTokens(tokens)).toEqual(tokens);
    expect(parseStoredTokens({ ...tokens, accessToken: '' })).toBeNull();
    expect(parseStoredTokens('nope')).toBeNull();
  });
});

describe('CookieJar', () => {
  const now = Date.UTC(2026, 0, 1);

  it('matches domain and path, honours expiry and deletion', () => {
    const jar = new CookieJar();
    const url = 'https://sso.garmin.com/sso/signin';
    jar.setCookie(url, 'A=1; Domain=garmin.com; Path=/', now);
    jar.setCookie(url, 'B=2; Path=/sso', now);
    jar.setCookie(url, 'C=3; Max-Age=10', now);
    jar.setCookie(url, 'EVIL=x; Domain=example.invalid', now);
    expect(jar.headerFor('https://sso.garmin.com/sso/embed', now)).toBe('B=2; C=3; A=1');
    expect(jar.headerFor('https://connect.garmin.com/app', now)).toBe('A=1');
    expect(jar.headerFor('https://sso.garmin.com/sso/x', now + 20_000)).toBe('B=2; A=1');
    jar.setCookie(url, 'B=gone; Path=/sso; Max-Age=0', now);
    expect(jar.headerFor('https://sso.garmin.com/sso/x', now)).toBe('C=3; A=1');
    const restored = new CookieJar(JSON.parse(JSON.stringify(jar.toJSON())) as never);
    expect(restored.headerFor('https://sso.garmin.com/sso/x', now)).toBe('C=3; A=1');
  });
});
