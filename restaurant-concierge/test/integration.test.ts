import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import type { Server } from 'node:http';

process.env.DATABASE_URL = 'postgres://unused-in-tests';
process.env.WEBHOOK_SECRET = 'test-secret';
process.env.CONCIERGE_API_KEY = 'test-key';
process.env.OPERATOR_BASE_URL = 'http://127.0.0.1:1';
process.env.OPERATOR_API_KEY = 'op-key';
process.env.NOTIFIER = 'none';

const { loadBranches } = await import('../src/branches.js');
const { webhookRouter } = await import('../src/routes/webhook.js');
const { apiRouter } = await import('../src/routes/api.js');
const { default: express } = await import('express');
type StoredMessage = import('../src/db.js').StoredMessage;

// ---- in-memory Store ----
let seq = 0;
const rows: StoredMessage[] = [];
const store = {
  async storeInbound(m: { branchId: string; customerPhone: string; pushName: string | null; text: string | null; messageType: string | null; waMessageId: string | null; payload: unknown }) {
    if (m.waMessageId && rows.some((r) => r.wa_message_id === m.waMessageId)) return null;
    const row = { id: ++seq, branch_id: m.branchId, direction: 'in' as const, customer_phone: m.customerPhone, push_name: m.pushName, text: m.text, message_type: m.messageType, wa_message_id: m.waMessageId, status: 'pending', payload: m.payload, created_at: new Date().toISOString() };
    rows.push(row);
    return row;
  },
  async storeOutbound(m: { branchId: string; customerPhone: string; text: string; status: 'sent' | 'simulated' | 'failed'; payload: unknown }) {
    const row = { id: ++seq, branch_id: m.branchId, direction: 'out' as const, customer_phone: m.customerPhone, push_name: null, text: m.text, message_type: 'text', wa_message_id: null, status: m.status, payload: m.payload, created_at: new Date().toISOString() };
    rows.push(row);
    return row;
  },
  async listInbox(p: { branchId?: string; status?: string; limit: number }) {
    return rows.filter((r) => r.direction === 'in' && (!p.branchId || r.branch_id === p.branchId) && (p.status === undefined || r.status === p.status)).slice(0, p.limit);
  },
  async listConversation(branchId: string, phone: string, limit: number) {
    return rows.filter((r) => r.branch_id === branchId && r.customer_phone === phone).slice(0, limit);
  },
  async listOutbound(branchId: string, phone: string | null, limit: number) {
    return rows.filter((r) => r.branch_id === branchId && r.direction === 'out' && (!phone || r.customer_phone === phone)).slice(0, limit);
  },
  async setMessageStatus(id: number, status: string) {
    const row = rows.find((r) => r.id === id);
    if (row) row.status = status;
    return row ?? null;
  },
  async markConversationReplied(branchId: string, phone: string) {
    for (const r of rows) if (r.branch_id === branchId && r.customer_phone === phone && r.direction === 'in' && r.status === 'pending') r.status = 'replied';
  },
};

let server: Server;
let base: string;
const KEY = { 'X-API-Key': 'test-key' };

function sign(body: string, secret = 'test-secret'): string {
  return crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function operatorPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: 1,
    waAccountId: 'wacc-soweto-test',
    appId: 'restaurant-concierge',
    tenantId: 'soweto-test',
    event: 'message',
    data: {
      messageId: 'WAM-1',
      chatId: '27761234567@s.whatsapp.net',
      senderId: '27761234567@s.whatsapp.net',
      fromMe: false,
      pushName: 'Test Customer',
      timestamp: 1760000000,
      messageType: 'conversation',
      text: 'Hi, do you have a table for 2 tonight?',
      media: null,
      quotedMessageId: null,
      quotedParticipant: null,
    },
    deliveredAt: new Date().toISOString(),
    ...overrides,
  });
}

before(async () => {
  const branches = loadBranches('branches');
  const app = express();
  app.use((req, res, next) => {
    if (req.path.startsWith('/webhooks/')) return next();
    return express.json({ limit: '1mb' })(req, res, next);
  });
  app.use('/webhooks', webhookRouter(branches, store));
  app.use('/v1', apiRouter(branches, store));
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (typeof address === 'object' && address) base = `http://127.0.0.1:${address.port}`;
});

after(() => server?.close());

test('signed webhook stores the customer message', async () => {
  const body = operatorPayload();
  const res = await fetch(`${base}/webhooks/operator`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sign(body) }, body });
  assert.equal(res.status, 200);
  const json = await res.json() as { ok: boolean; duplicate: boolean; id: number };
  assert.equal(json.ok, true);
  assert.equal(json.duplicate, false);
  assert.ok(json.id > 0);
});

test('identical redelivery is deduplicated on the WhatsApp message id', async () => {
  const body = operatorPayload();
  const res = await fetch(`${base}/webhooks/operator`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sign(body) }, body });
  const json = await res.json() as { duplicate: boolean };
  assert.equal(json.duplicate, true);
});

test('bad signature is rejected', async () => {
  const body = operatorPayload({ data: { messageId: 'WAM-2', chatId: '27769999999@s.whatsapp.net', fromMe: false, text: 'hi' } });
  const res = await fetch(`${base}/webhooks/operator`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sign(body, 'wrong-secret') }, body });
  assert.equal(res.status, 401);
});

test('events for other tenants are acked but ignored (shared Operator stays safe)', async () => {
  const body = operatorPayload({ tenantId: 'flavourly', data: { messageId: 'WAM-3', chatId: '27761111111@s.whatsapp.net', fromMe: false, text: 'flavourly traffic' } });
  const res = await fetch(`${base}/webhooks/operator`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sign(body) }, body });
  const json = await res.json() as { ignored: string };
  assert.equal(json.ignored, 'unknown-branch');
});

test('own messages, groups and status broadcasts are ignored', async () => {
  for (const [label, data] of [
    ['fromMe', { messageId: 'WAM-4', chatId: '27761234567@s.whatsapp.net', fromMe: true, text: 'own' }],
    ['group', { messageId: 'WAM-5', chatId: '12345@g.us', fromMe: false, text: 'group' }],
    ['status', { messageId: 'WAM-6', chatId: 'status@broadcast', fromMe: false, text: 'status' }],
  ] as const) {
    const body = operatorPayload({ data });
    const res = await fetch(`${base}/webhooks/operator`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': sign(body) }, body });
    const json = await res.json() as { ignored: string };
    assert.equal(json.ignored, 'not-a-customer-dm', label);
  }
});

test('agent API requires the concierge key', async () => {
  const res = await fetch(`${base}/v1/branches`);
  assert.equal(res.status, 401);
});

test('agent can discover branches, read the inbox and reply in test mode (no real WhatsApp)', async () => {
  const branchesRes = await fetch(`${base}/v1/branches`, { headers: KEY });
  const branchesJson = await branchesRes.json() as { branches: { branchId: string; mode: string }[] };
  assert.ok(branchesJson.branches.some((b) => b.branchId === 'soweto-test' && b.mode === 'test'));

  const inboxRes = await fetch(`${base}/v1/inbox?branchId=soweto-test&status=pending`, { headers: KEY });
  const inbox = await inboxRes.json() as { count: number; messages: { customer_phone: string }[] };
  assert.equal(inbox.count, 1);
  assert.equal(inbox.messages[0].customer_phone, '+27761234567');

  const replyRes = await fetch(`${base}/v1/replies`, { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ branchId: 'soweto-test', to: '+27761234567', text: 'Yes! 7pm work for you?' }) });
  const reply = await replyRes.json() as { ok: boolean; simulated: boolean };
  assert.equal(reply.ok, true);
  assert.equal(reply.simulated, true);

  const outboxRes = await fetch(`${base}/v1/test/outbox/soweto-test?customer=%2B27761234567`, { headers: KEY });
  const outbox = await outboxRes.json() as { outbound: { text: string; status: string }[] };
  assert.equal(outbox.outbound.length, 1);
  assert.equal(outbox.outbound[0].status, 'simulated');

  const inboxAfter = await fetch(`${base}/v1/inbox?branchId=soweto-test&status=pending`, { headers: KEY });
  assert.equal((await inboxAfter.json() as { count: number }).count, 0);
});

test('simulated inbound runs the same pipeline and is refused for unknown branches', async () => {
  const sim = await fetch(`${base}/v1/test/inbound`, { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ branchId: 'soweto-test', from: '+27765550000', text: 'How much is the full house kota?' }) });
  assert.equal(sim.status, 201);

  const unknown = await fetch(`${base}/v1/test/inbound`, { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ branchId: 'nope', from: '+2776', text: 'x' }) });
  assert.equal(unknown.status, 404);
});

test('messages can be archived', async () => {
  const inboxRes = await fetch(`${base}/v1/inbox?branchId=soweto-test&status=pending`, { headers: KEY });
  const inbox = await inboxRes.json() as { messages: { id: number }[] };
  assert.ok(inbox.messages.length > 0);
  const res = await fetch(`${base}/v1/messages/${inbox.messages[0].id}/status`, { method: 'POST', headers: { ...KEY, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'archived' }) });
  assert.equal(res.status, 200);
  const after1 = await fetch(`${base}/v1/inbox?branchId=soweto-test&status=pending`, { headers: KEY });
  assert.equal((await after1.json() as { count: number }).count, 0);
});
