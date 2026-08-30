import assert from 'node:assert/strict';
import test from 'node:test';
import { createUserSession, getSessionFromToken, parseBearerToken } from '../dist/auth.js';

test('creates and resolves a user-scoped session token', () => {
  const token = createUserSession('user-123', {
    accountId: 'VRTC-123',
    role: 'trader',
    scopes: ['trade', 'read:account'],
    ttlMs: 30 * 60 * 1000,
  });

  assert.ok(token);
  const session = getSessionFromToken(token);
  assert.equal(session?.userId, 'user-123');
  assert.equal(session?.accountId, 'VRTC-123');
  assert.equal(session?.role, 'trader');
  assert.deepEqual(session?.scopes, ['trade', 'read:account']);
});

test('expires session tokens when they are stale', () => {
  const token = createUserSession('user-456', { ttlMs: 0 });
  assert.equal(getSessionFromToken(token), null);
});

test('parses bearer tokens from the authorization header', () => {
  assert.equal(parseBearerToken({ headers: { authorization: 'Bearer abc-123' } }), 'abc-123');
  assert.equal(parseBearerToken({ headers: {} }), null);
});
