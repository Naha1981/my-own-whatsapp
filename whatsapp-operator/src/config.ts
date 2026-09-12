import 'dotenv/config';

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function booleanEnv(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}

export const config = {
  port: Number(process.env.PORT ?? 3001),
  logLevel: process.env.LOG_LEVEL ?? 'info',
  databaseUrl: required('DATABASE_URL'),
  webhookSecret: required('WEBHOOK_SECRET'),
  operatorApiKey: required('OPERATOR_API_KEY'),

  // Remote MCP is enabled by default, but its OAuth login is deliberately inert
  // until MCP_OAUTH_PASSWORD is configured. This keeps existing deployments safe
  // while allowing a URL-only Claude/ChatGPT connection once configured.
  mcpEnabled: booleanEnv('MCP_ENABLED', true),
  mcpPublicUrl: (process.env.MCP_PUBLIC_URL ?? 'https://my-own-whatsapp-2z5h.onrender.com').replace(/\/$/, ''),
  mcpOauthUsername: process.env.MCP_OAUTH_USERNAME ?? 'admin',
  mcpOauthPassword: process.env.MCP_OAUTH_PASSWORD ?? '',
  mcpAppId: process.env.MCP_APP_ID ?? 'nahalabs',
  mcpTenantId: process.env.MCP_TENANT_ID ?? 'default',
};
