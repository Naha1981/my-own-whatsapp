import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadBranches, resolveBranch, branchConfigSchema } from '../src/branches.js';

test('loads the bundled soweto-test branch in test mode', () => {
  const branches = loadBranches('branches');
  const branch = branches.get('soweto-test');
  assert.ok(branch, 'soweto-test branch should exist');
  assert.equal(branch.mode, 'test');
  assert.equal(branch.tenantId, 'soweto-test');
  assert.ok(branch.menu.length > 0);
  assert.equal(branch.bookingRules.maxPartySize, 8);
});

test('branchId must be a slug', () => {
  assert.equal(branchConfigSchema.safeParse({ branchId: 'Bad Branch!', displayName: 'x', tenantId: 't' }).success, false);
});

test('tenantId and waAccountId are required-shape but menu/hours/rules/voice get defaults', () => {
  const parsed = branchConfigSchema.parse({ branchId: 'new-branch', displayName: 'New', tenantId: 'new-branch' });
  assert.equal(parsed.mode, 'test');
  assert.equal(parsed.appId, 'restaurant-concierge');
  assert.equal(parsed.waAccountId, null);
  assert.equal(parsed.bookingRules.slotMinutes, 90);
});

test('resolveBranch matches on tenantId first, then waAccountId, else null', () => {
  const branches = loadBranches('branches');
  assert.equal(resolveBranch(branches, 'soweto-test', 'whatever')?.branchId, 'soweto-test');
  assert.equal(resolveBranch(branches, 'nope', 'nope'), null);
});
