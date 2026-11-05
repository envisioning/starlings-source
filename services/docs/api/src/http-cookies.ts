// Cookie + redirect plumbing for the OAuth flow.
//
// Response.redirect() returns a response with immutable headers in workerd, so
// appending set-cookie to it throws at runtime. Every redirect that carries a
// cookie must be built by hand — use redirectWithCookies for all of them.

export function redirectWithCookies(location: string, cookies: string[]): Response {
  const headers = new Headers({ location });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status: 302, headers });
}

export function cookie(name: string, value: string, maxAge: number): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Same cookie without `Secure`, for `wrangler dev` over plain http. Only the
 * dev-session route uses it, and that route refuses to run in production.
 */
export function devCookie(name: string, value: string, maxAge = 43_200): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax`;
}

export function expiredCookie(name: string): string {
  return `${name}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export function readCookie(request: Request, name: string): string | null {
  const raw = request.headers.get('cookie');
  if (!raw) return null;
  for (const pair of raw.split(';')) {
    const [key, ...rest] = pair.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

export function safeReturnPath(value: string | null): string {
  return value?.startsWith('/') && !value.startsWith('//') ? value : '/';
}
