// Gate everything under /land/ behind HTTP Basic auth.
//
// The password lives in the LAND_PASSWORD environment variable, set in the
// Cloudflare Pages dashboard (Settings -> Environment variables) — never in
// this repo. LAND_USER is optional and defaults to "nakas".
//
// If LAND_PASSWORD is unset the section stays closed rather than falling open,
// so a misconfigured deploy can't quietly publish the documents.

const REALM = 'Lot 175';

function unauthorized(message) {
  return new Response(message, {
    status: 401,
    headers: {
      // A quoted realm keeps Safari and Firefox from re-prompting on every asset.
      'WWW-Authenticate': `Basic realm="${REALM}", charset="UTF-8"`,
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

// Compare in fixed time so a wrong guess can't be narrowed down by timing.
function safeEqual(a, b) {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  // Length alone is not secret enough to leak, but keep the loop constant anyway.
  let diff = ea.length ^ eb.length;
  const n = Math.max(ea.length, eb.length);
  for (let i = 0; i < n; i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  const expected = env.LAND_PASSWORD;

  if (!expected) {
    return new Response(
      'This section is not configured yet. Set LAND_PASSWORD in the Pages project settings.',
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const header = request.headers.get('Authorization') || '';
  if (!header.startsWith('Basic ')) return unauthorized('Authentication required.');

  let decoded;
  try {
    decoded = atob(header.slice(6));
  } catch {
    return unauthorized('Malformed credentials.');
  }

  // Only the first colon separates user from password; passwords may contain colons.
  const sep = decoded.indexOf(':');
  const user = sep === -1 ? '' : decoded.slice(0, sep);
  const pass = sep === -1 ? decoded : decoded.slice(sep + 1);

  const userOk = safeEqual(user, env.LAND_USER || 'nakas');
  const passOk = safeEqual(pass, expected);
  if (!(userOk && passOk)) return unauthorized('Incorrect username or password.');

  const response = await next();
  const out = new Response(response.body, response);
  // Private documents: never cache at the edge or in shared proxies, never index.
  out.headers.set('Cache-Control', 'private, no-store');
  out.headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  out.headers.set('Referrer-Policy', 'no-referrer');
  out.headers.set('X-Content-Type-Options', 'nosniff');
  return out;
}
