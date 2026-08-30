import { createHmac, timingSafeEqual } from 'crypto';

export type UserSession = {
  userId: string;
  accountId?: string | null;
  role?: string;
  scopes?: string[];
  iat: number;
  exp: number;
};

const SESSION_HEADER = { alg: 'HS256', typ: 'session' };
const DEFAULT_TTL_MS = 60 * 60 * 1000;

function getSessionSecret(): string {
  return process.env.SESSION_SECRET || process.env.API_AUTH_TOKEN || 'investpal-dev-session-secret';
}

function toBase64Url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function fromBase64Url(value: string): string {
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
}

function signSessionSegment(segment: string): string {
  return createHmac('sha256', getSessionSecret())
    .update(segment)
    .digest('base64url');
}

export function createUserSession(
  userId: string,
  options: {
    accountId?: string | null;
    role?: string;
    scopes?: string[];
    ttlMs?: number;
  } = {},
): string {
  if (!userId || typeof userId !== 'string') {
    throw new Error('userId is required to create a user session');
  }

  const now = Date.now();
  const ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  const payload: UserSession = {
    userId,
    accountId: options.accountId ?? null,
    role: options.role ?? 'user',
    scopes: Array.isArray(options.scopes) ? options.scopes : [],
    iat: Math.floor(now / 1000),
    exp: Math.floor((now + ttlMs) / 1000),
  };

  if (ttlMs <= 0) {
    payload.exp = Math.floor(now / 1000);
  }

  const headerSegment = toBase64Url(JSON.stringify(SESSION_HEADER));
  const payloadSegment = toBase64Url(JSON.stringify(payload));
  const signature = signSessionSegment(`${headerSegment}.${payloadSegment}`);

  return `${headerSegment}.${payloadSegment}.${signature}`;
}

export function getSessionFromToken(token: string | null | undefined): UserSession | null {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [headerSegment, payloadSegment, signature] = parts;
  const expectedSignature = signSessionSegment(`${headerSegment}.${payloadSegment}`);

  try {
    const signatureBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expectedSignature);
    if (signatureBuffer.length !== expectedBuffer.length || !timingSafeEqual(signatureBuffer, expectedBuffer)) {
      return null;
    }
  } catch {
    return null;
  }

  try {
    const payloadRaw = fromBase64Url(payloadSegment);
    const payload = JSON.parse(payloadRaw) as Partial<UserSession>;

    if (!payload.userId || typeof payload.userId !== 'string') {
      return null;
    }

    const now = Math.floor(Date.now() / 1000);
    if (typeof payload.exp === 'number' && now >= payload.exp) {
      return null;
    }

    return {
      userId: payload.userId,
      accountId: payload.accountId ?? null,
      role: payload.role ?? 'user',
      scopes: Array.isArray(payload.scopes) ? payload.scopes : [],
      iat: payload.iat ?? now,
      exp: payload.exp ?? now + 60,
    };
  } catch {
    return null;
  }
}

export function parseBearerToken(req: { headers?: Record<string, string | string[] | undefined> }): string | null {
  const authHeader = req.headers?.authorization;
  if (typeof authHeader !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(authHeader.trim());
  return match ? match[1] : null;
}

export function getRequestSession(req: { headers?: Record<string, string | string[] | undefined> }): UserSession | null {
  const bearerToken = parseBearerToken(req);
  return bearerToken ? getSessionFromToken(bearerToken) : null;
}
