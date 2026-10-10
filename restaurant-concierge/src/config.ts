import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export const config = {
  port: Number(process.env.PORT ?? 3002),
  logLevel: process.env.LOG_LEVEL ?? 'info',

  databaseUrl: required('DATABASE_URL'),

  /** Must equal the Operator's WEBHOOK_SECRET — verifies inbound event signatures. */
  webhookSecret: required('WEBHOOK_SECRET'),

  /** Key the AI agent uses on every /v1/* call. */
  conciergeApiKey: required('CONCIERGE_API_KEY'),

  operatorBaseUrl: required('OPERATOR_BASE_URL').replace(/\/+$/, ''),
  operatorApiKey: required('OPERATOR_API_KEY'),

  publicBaseUrl: (process.env.CONCIERGE_PUBLIC_URL ?? '').replace(/\/+$/, ''),

  notifier: (process.env.NOTIFIER ?? 'none') as 'resend' | 'none',
  resendApiKey: process.env.RESEND_API_KEY ?? '',
  notifyFrom: process.env.NOTIFY_FROM ?? 'NahaLabs Concierge <onboarding@resend.dev>',
  notifyTo: process.env.NOTIFY_TO ?? '',

  /** Directory containing per-branch JSON configs. */
  branchesDir: process.env.BRANCHES_DIR ?? 'branches',
};
