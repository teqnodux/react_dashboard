/**
 * Only /unsubscribe (with its query string) is a valid post-login return URL.
 * Anything else falls back to "/" so change-password, invites, and normal
 * logins keep their existing destination.
 */
export function getUnsubscribeRedirect(value: string | null): string {
  if (!value) return '/';
  if (!value.startsWith('/unsubscribe') || value.startsWith('//') || value.startsWith('/\\')) {
    return '/';
  }
  try {
    const url = new URL(value, 'http://localhost');
    if (url.pathname !== '/unsubscribe') return '/';
    return `${url.pathname}${url.search}`;
  } catch {
    return '/';
  }
}
