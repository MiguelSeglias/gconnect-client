/**
 * Minimal in-memory cookie jar for the SSO flow. Supports the subset of RFC 6265 Garmin's
 * SSO uses: Domain, Path, Expires, Max-Age, Secure. It is serialisable so that a pending
 * MFA session can be resumed later.
 */
export interface SerializedCookie {
  name: string;
  value: string;
  domain: string;
  /** True if the cookie had no Domain attribute (exact host match only). */
  hostOnly: boolean;
  path: string;
  /** Epoch ms, or null for session cookies. */
  expiresAt: number | null;
  secure: boolean;
}

export class CookieJar {
  private cookies: SerializedCookie[] = [];

  constructor(cookies: readonly SerializedCookie[] = []) {
    this.cookies = cookies.map((c) => ({ ...c }));
  }

  /** Store all `Set-Cookie` headers of a response received from `url`. */
  storeFromResponse(url: string, headers: Headers, nowMs: number): void {
    for (const header of getSetCookies(headers)) {
      this.setCookie(url, header, nowMs);
    }
  }

  setCookie(url: string, header: string, nowMs: number): void {
    const { hostname, pathname } = new URL(url);
    const [pair, ...attrs] = header.split(';');
    if (pair === undefined) return;
    const eq = pair.indexOf('=');
    if (eq <= 0) return;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    let domain = hostname.toLowerCase();
    let hostOnly = true;
    let path = defaultPath(pathname);
    let expiresAt: number | null = null;
    let maxAgeSeen = false;
    let secure = false;
    for (const attr of attrs) {
      const idx = attr.indexOf('=');
      const key = (idx === -1 ? attr : attr.slice(0, idx)).trim().toLowerCase();
      const val = idx === -1 ? '' : attr.slice(idx + 1).trim();
      if (key === 'domain' && val !== '') {
        const d = val.replace(/^\./, '').toLowerCase();
        if (!domainMatches(hostname.toLowerCase(), d)) return; // reject foreign domain
        domain = d;
        hostOnly = false;
      } else if (key === 'path' && val.startsWith('/')) {
        path = val;
      } else if (key === 'max-age' && /^-?\d+$/.test(val)) {
        expiresAt = nowMs + Number(val) * 1000;
        maxAgeSeen = true;
      } else if (key === 'expires' && !maxAgeSeen) {
        const t = Date.parse(val);
        if (!Number.isNaN(t)) expiresAt = t;
      } else if (key === 'secure') {
        secure = true;
      }
    }
    this.cookies = this.cookies.filter(
      (c) => !(c.name === name && c.domain === domain && c.path === path),
    );
    if (expiresAt !== null && expiresAt <= nowMs) return; // deletion
    this.cookies.push({ name, value, domain, hostOnly, path, expiresAt, secure });
  }

  /** Value for the `Cookie` request header, or undefined if nothing matches. */
  headerFor(url: string, nowMs: number): string | undefined {
    const { hostname, pathname, protocol } = new URL(url);
    const host = hostname.toLowerCase();
    const matching = this.cookies.filter(
      (c) =>
        (c.expiresAt === null || c.expiresAt > nowMs) &&
        (c.hostOnly ? c.domain === host : domainMatches(host, c.domain)) &&
        pathMatches(pathname, c.path) &&
        (!c.secure || protocol === 'https:'),
    );
    if (matching.length === 0) return undefined;
    matching.sort((a, b) => b.path.length - a.path.length);
    return matching.map((c) => `${c.name}=${c.value}`).join('; ');
  }

  toJSON(): SerializedCookie[] {
    return this.cookies.map((c) => ({ ...c }));
  }
}

function getSetCookies(headers: Headers): string[] {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const raw = headers.get('set-cookie');
  return raw === null ? [] : raw.split(/,(?=\s*[^;,=\s]+=)/);
}

function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

function pathMatches(requestPath: string, cookiePath: string): boolean {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
}

function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const idx = pathname.lastIndexOf('/');
  return idx <= 0 ? '/' : pathname.slice(0, idx);
}
