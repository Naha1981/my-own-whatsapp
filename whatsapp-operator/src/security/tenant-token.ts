import { createHash, randomBytes } from 'node:crypto';

export const TENANT_TOKEN_HEADER = 'x-nahalabs-tenant-token';

/**
 * Opaque credential used by a NahaLabs product backend to operate only on
 * one app + tenant scope. The plaintext token is returned only at issuance.
 * The database stores only its SHA-256 hash.
 */
export function generateTenantToken(): string {
  return `nlt_${randomBytes(32).toString('base64url')}`;
}

export function hashTenantToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
