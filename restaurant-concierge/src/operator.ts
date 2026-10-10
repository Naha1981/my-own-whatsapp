import { config } from './config.js';
import type { BranchConfig } from './branches.js';

function headers(appId: string, tenantId: string): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    'X-API-Key': config.operatorApiKey,
    'X-App-Id': appId,
    'X-Tenant-Id': tenantId,
  };
}

/** Send a WhatsApp text as the branch's connected account, through the Operator. */
export async function sendText(branch: BranchConfig, to: string, text: string): Promise<unknown> {
  if (!branch.waAccountId) throw new Error(`Branch ${branch.branchId} has no waAccountId — pair its WhatsApp first`);

  const response = await fetch(`${config.operatorBaseUrl}/send`, {
    method: 'POST',
    headers: headers(branch.appId, branch.tenantId),
    body: JSON.stringify({ waAccountId: branch.waAccountId, to, type: 'text', text }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Operator /send failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}

/**
 * Provision (or reconfigure) the Operator account + webhook binding for a branch.
 * Safe to re-run: the Operator upserts bindings on (account, appId, tenantId) and
 * never touches other apps' bindings on the same number.
 */
export async function bootstrapAccount(branch: BranchConfig): Promise<unknown> {
  const response = await fetch(`${config.operatorBaseUrl}/accounts/bootstrap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': config.operatorApiKey },
    body: JSON.stringify({
      label: `concierge-${branch.branchId}`,
      appId: branch.appId,
      tenantId: branch.tenantId,
      webhookUrl: config.publicBaseUrl ? `${config.publicBaseUrl}/webhooks/operator` : undefined,
    }),
  });

  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Operator /accounts/bootstrap failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  return body;
}
