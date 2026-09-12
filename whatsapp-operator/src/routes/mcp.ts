import { Router } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { config } from '../config.js';
import {
  authorizationServerMetadata,
  bearerChallenge,
  oauthAuthorize,
  oauthToken,
  protectedResourceMetadata,
  registerOAuthClient,
  verifyAccessToken,
} from '../mcp/oauth.js';
import { createMcpServer } from '../mcp/server.js';

export const mcpRouter = Router();

const handler = createMcpHandler((ctx) => createMcpServer(ctx.http?.authInfo));
const nodeHandler = toNodeHandler(handler);

function jsonNoStore(res: { setHeader(name: string, value: string): void }, body: unknown): void {
  res.setHeader('Cache-Control', 'no-store, max-age=0, must-revalidate');
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

function bearerToken(req: { header(name: string): string | undefined }): string {
  const value = req.header('authorization') ?? '';
  return value.toLowerCase().startsWith('bearer ') ? value.slice(7).trim() : '';
}

async function authenticateMcp(req: Parameters<typeof nodeHandler>[0], res: Parameters<typeof nodeHandler>[1], next: () => void): Promise<void> {
  if (!config.mcpEnabled) {
    res.statusCode = 404;
    res.end('Not found');
    return;
  }

  const token = bearerToken(req as unknown as { header(name: string): string | undefined });
  if (!token) {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', bearerChallenge());
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'invalid_token', error_description: 'Bearer access token required' }));
    return;
  }

  try {
    const verified = await verifyAccessToken(token);
    if (!verified) {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', bearerChallenge());
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'invalid_token', error_description: 'Access token is invalid or expired' }));
      return;
    }

    const auth: AuthInfo = {
      token,
      clientId: verified.clientId,
      scopes: verified.scopes,
      expiresAt: verified.expiresAt,
      extra: {
        appId: verified.appId,
        tenantId: verified.tenantId,
        clientId: verified.clientId,
      },
    };
    (req as unknown as { auth?: AuthInfo }).auth = auth;
    next();
  } catch {
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'server_error' }));
  }
}

mcpRouter.get('/.well-known/oauth-protected-resource', (_req, res) => {
  if (!config.mcpEnabled) return res.status(404).json({ error: 'NOT_FOUND' });
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(protectedResourceMetadata());
});

mcpRouter.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => {
  if (!config.mcpEnabled) return res.status(404).json({ error: 'NOT_FOUND' });
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(protectedResourceMetadata());
});

mcpRouter.get('/.well-known/oauth-authorization-server', (_req, res) => {
  if (!config.mcpEnabled) return res.status(404).json({ error: 'NOT_FOUND' });
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(authorizationServerMetadata());
});

mcpRouter.post('/oauth/register', (req, res, next) => {
  registerOAuthClient(req, res).catch(next);
});

mcpRouter.get('/oauth/authorize', (req, res, next) => {
  oauthAuthorize(req, res).catch(next);
});

mcpRouter.post('/oauth/authorize', (req, res, next) => {
  oauthAuthorize(req, res).catch(next);
});

mcpRouter.post('/oauth/token', (req, res, next) => {
  oauthToken(req, res).catch(next);
});

mcpRouter.all('/mcp', (req, res, next) => {
  authenticateMcp(req as unknown as Parameters<typeof nodeHandler>[0], res as unknown as Parameters<typeof nodeHandler>[1], () => {
    nodeHandler(req as unknown as Parameters<typeof nodeHandler>[0], res as unknown as Parameters<typeof nodeHandler>[1], req.body).catch(next);
  }).catch(next);
});

mcpRouter.get('/mcp-info', (_req, res) => {
  res.json({
    name: 'NahaLabs WhatsApp MCP',
    enabled: config.mcpEnabled,
    endpoint: `${config.mcpPublicUrl.replace(/\/$/, '')}/mcp`,
    transport: 'Streamable HTTP',
    authentication: 'OAuth 2.1 + PKCE (S256)',
    scopes: ['whatsapp.read', 'whatsapp.write'],
  });
});

void jsonNoStore;
