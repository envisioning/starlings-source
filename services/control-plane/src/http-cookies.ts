// Shared cookie + redirect plumbing for the OAuth flows in auth.ts and calendar.ts.
//
// Response.redirect() returns a response with immutable headers in workerd, so
// appending set-cookie to it throws at runtime. Every redirect that carries a
// cookie must be built by hand — use redirectWithCookies for all of them.

export function redirectWithCookies(location: string, cookies: string[]): Response {
  const headers = new Headers({ location });
  for (const value of cookies) headers.append('set-cookie', value);
  return new Response(null, { status: 302, headers });
}

export function cookie(name: string, value: string, maxAge: number, secure = true): string {
  return `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; HttpOnly${secure ? '; Secure' : ''}; SameSite=Lax`;
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

/** A local path only. A backslash or a control character can turn a path into another host in some browsers. */
export function safeReturnPath(value: string | null): string {
  return value?.startsWith('/') && !value.startsWith('//') && !/[\\\u0000-\u001f\u007f]/u.test(value) ? value : '/';
}
