import type { StoredTokens } from './auth/tokens';

/**
 * Persistence for OAuth tokens. Implement this to keep tokens wherever you like — e.g.
 * encrypted in a database row per user. Tokens are secrets; encrypt them at rest.
 */
export interface TokenStore {
  /** Return the stored tokens, or null if there are none. */
  load(): Promise<StoredTokens | null>;
  /** Persist tokens (called after login and after every refresh). */
  save(tokens: StoredTokens): Promise<void>;
  /** Remove stored tokens (called on logout and when the session is irrecoverably expired). */
  clear(): Promise<void>;
}

/** Keeps tokens in process memory only. Useful for tests and short-lived scripts. */
export class MemoryTokenStore implements TokenStore {
  private tokens: StoredTokens | null;

  constructor(initial: StoredTokens | null = null) {
    this.tokens = initial ? { ...initial } : null;
  }

  load(): Promise<StoredTokens | null> {
    return Promise.resolve(this.tokens ? { ...this.tokens } : null);
  }

  save(tokens: StoredTokens): Promise<void> {
    this.tokens = { ...tokens };
    return Promise.resolve();
  }

  clear(): Promise<void> {
    this.tokens = null;
    return Promise.resolve();
  }
}
