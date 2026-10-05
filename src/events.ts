/**
 * Redacted diagnostic events. They contain only operation metadata — never credentials,
 * tokens, cookies, query strings, request/response bodies or health data.
 */
export type GarminConnectEvent =
  | {
      type: 'request';
      method: string;
      /**
       * URL origin + path without query string or fragment. For API reads this is the
       * endpoint template (no activity ids or display names).
       */
      url: string;
      status: number | null;
      durationMs: number;
      attempt: number;
    }
  | { type: 'retry'; url: string; attempt: number; delayMs: number; reason: string }
  | { type: 'login_strategy'; strategy: string; outcome: string }
  | { type: 'token_exchange'; clientId: string; outcome: 'success' | 'rejected' }
  | { type: 'token_refresh'; outcome: 'success' | 'failed' };

/** Receives redacted events. Exceptions thrown by the listener are swallowed. */
export type EventListener = (event: GarminConnectEvent) => void;

export function emit(listener: EventListener | undefined, event: GarminConnectEvent): void {
  if (!listener) return;
  try {
    listener(event);
  } catch {
    // A faulty listener must never break a request.
  }
}

/** Strip query string and fragment from a URL for logging. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0] ?? '';
  }
}
