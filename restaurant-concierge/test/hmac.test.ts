import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { verifyWebhookSignature, hasValidApiKey } from '../src/hmac.js';

test('verifies a signature computed the Operator way (HMAC over the exact body string)', () => {
  const secret = 'test-secret';
  const payload = { schemaVersion: 1, waAccountId: 'abc', appId: 'restaurant-concierge', tenantId: 'soweto-test', event: 'message', data: { text: 'hi' }, deliveredAt: '2026-10-10T00:00:00.000Z' };
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyWebhookSignature(secret, body, signature), true);
});

test('rejects wrong secret, tampered body and malformed signature', () => {
  const secret = 'test-secret';
  const body = JSON.stringify({ event: 'message' });
  const signature = crypto.createHmac('sha256', secret).update(body).digest('hex');
  assert.equal(verifyWebhookSignature('other-secret', body, signature), false);
  assert.equal(verifyWebhookSignature(secret, body + ' ', signature), false);
  assert.equal(verifyWebhookSignature(secret, body, 'not-hex'), false);
  assert.equal(verifyWebhookSignature(secret, body, ''), false);
});

test('api key check is exact and length-safe', () => {
  assert.equal(hasValidApiKey('abc123', 'abc123'), true);
  assert.equal(hasValidApiKey('abc123', 'abc124'), false);
  assert.equal(hasValidApiKey('abc', 'abc123'), false);
  assert.equal(hasValidApiKey('', 'abc123'), false);
});
