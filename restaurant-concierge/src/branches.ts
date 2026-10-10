import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const menuItemSchema = z.object({
  name: z.string().min(1),
  price: z.string().optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const dayHoursSchema = z.record(z.string(), z.array(z.string()));

export const branchConfigSchema = z.object({
  /** Stable slug. Adding a branch = adding one JSON file with a unique branchId. */
  branchId: z.string().regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits, dashes'),
  displayName: z.string().min(1),

  /**
   * test  — inbound can be simulated via /v1/test/inbound; replies are recorded
   *         but NEVER sent to the Operator (no real WhatsApp traffic).
   * live  — inbound arrives from the Operator webhook; replies go out through
   *         the Operator as the branch's WhatsApp.
   */
  mode: z.enum(['test', 'live']).default('test'),

  /** Operator binding scope. tenantId must equal the tenantId used in /accounts/bootstrap. */
  appId: z.string().min(1).default('restaurant-concierge'),
  tenantId: z.string().min(1),

  /** Operator WhatsApp account id (from /accounts/bootstrap). null until paired. */
  waAccountId: z.string().min(1).nullable().default(null),

  menu: z.array(menuItemSchema).default([]),

  /** e.g. { "mon": ["09:00-21:00"], "sun": ["10:00-15:00"] }. Days: mon..sun. */
  tradingHours: dayHoursSchema.default({}),

  bookingRules: z.object({
    maxPartySize: z.number().int().positive().default(8),
    advanceDays: z.number().int().nonnegative().default(30),
    slotMinutes: z.number().int().positive().default(90),
    requiresDeposit: z.boolean().default(false),
    notes: z.string().optional(),
  }).default(() => ({ maxPartySize: 8, advanceDays: 30, slotMinutes: 90, requiresDeposit: false })),

  escalation: z.object({
    name: z.string().default(''),
    phone: z.string().default(''),
    notes: z.string().optional(),
  }).default(() => ({ name: '', phone: '' })),

  voice: z.object({
    tone: z.string().default('warm and helpful'),
    language: z.string().default('English'),
    signoff: z.string().optional(),
    notes: z.string().optional(),
  }).default(() => ({ tone: 'warm and helpful', language: 'English' })),
});

export type BranchConfig = z.infer<typeof branchConfigSchema>;

export function loadBranches(dir: string): Map<string, BranchConfig> {
  const branches = new Map<string, BranchConfig>();
  if (!fs.existsSync(dir)) return branches;

  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.json') || file.startsWith('_')) continue;
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const parsed = branchConfigSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(`Invalid branch config ${file}: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
    }
    const branch = parsed.data;
    if (branches.has(branch.branchId)) {
      throw new Error(`Duplicate branchId ${branch.branchId} (${file})`);
    }
    branches.set(branch.branchId, branch);
  }
  return branches;
}

/** Resolve which branch an inbound Operator event belongs to. */
export function resolveBranch(
  branches: Map<string, BranchConfig>,
  tenantId: unknown,
  waAccountId: unknown,
): BranchConfig | null {
  for (const branch of branches.values()) {
    if (typeof tenantId === 'string' && branch.tenantId === tenantId && branch.appId) return branch;
    if (typeof waAccountId === 'string' && branch.waAccountId === waAccountId) return branch;
  }
  return null;
}
