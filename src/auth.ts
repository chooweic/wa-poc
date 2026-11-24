// HTTP Basic Auth for every admin-only page (/admin, /mock-wa, /mock-app, /evidence).
// Any username is accepted; the password must equal ADMIN_PASSWORD.

import type { Env } from './env';
import { timingSafeEqual } from './util';

/** Returns a Response to send back when the request is NOT allowed, or null when it is. */
export function requireAdmin(request: Request, env: Env): Response | null {
  if (!env.ADMIN_PASSWORD) {
    return new Response('ADMIN_PASSWORD is not set. Add it to .dev.vars (local) or as a Worker secret.', {
      status: 503,
    });
  }
  const header = request.headers.get('authorization') ?? '';
  if (header.toLowerCase().startsWith('basic ')) {
    try {
      const decoded = atob(header.slice(6).trim());
      const password = decoded.slice(decoded.indexOf(':') + 1);
      if (timingSafeEqual(password, env.ADMIN_PASSWORD)) return null;
    } catch {
      // fall through to the 401 below
    }
  }
  return new Response('Authentication required', {
    status: 401,
    headers: { 'www-authenticate': 'Basic realm="wa-poc admin", charset="UTF-8"' },
  });
}

/**
 * Blocks cross-site form posts: a browser that is logged in with Basic Auth
 * would otherwise send the password along with a form submitted from another site.
 */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return true; // non-browser clients (curl, tests) send no Origin
  return origin === new URL(request.url).origin;
}
