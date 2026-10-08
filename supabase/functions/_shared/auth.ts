// Shared-secret check for send-push and tick (both deployed with --no-verify-jwt).
// Only `Authorization: Bearer <FUNCTION_SECRET>` is accepted (CONTRACT A6).

const enc = new TextEncoder();

/** Constant-time comparison: the time taken does not depend on where the strings differ. */
export function timingSafeEqual(a: string, b: string): boolean {
  const x = enc.encode(a);
  const y = enc.encode(b);
  const n = Math.max(x.length, y.length);
  let diff = x.length ^ y.length;
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export function isAuthorized(req: Request, secret = Deno.env.get('FUNCTION_SECRET') ?? ''): boolean {
  if (!secret) return false;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.get('authorization') ?? '');
  return !!m && timingSafeEqual(m[1], secret);
}

export function unauthorized(fn: string, req: Request): Response {
  // Never log the received value; only whether a header was present.
  console.warn(`[${fn}] 401 secret mismatch: authorization header ${req.headers.has('authorization') ? 'present but wrong' : 'missing'}`
    + (Deno.env.get('FUNCTION_SECRET') ? '' : ' (FUNCTION_SECRET is not set on this project!)'));
  return json({ error: 'unauthorized' }, 401);
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
