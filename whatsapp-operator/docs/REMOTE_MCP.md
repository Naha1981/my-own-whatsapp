# NahaLabs WhatsApp — Remote MCP

The NahaLabs WhatsApp Operator now exposes a standards-based remote MCP server.

## Endpoint

`https://my-own-whatsapp-2z5h.onrender.com/mcp`

Transport: **MCP Streamable HTTP**.

The MCP server is part of the existing WhatsApp Operator. It does **not** create another WhatsApp socket, another QR engine, or another Baileys session.

Architecture:

```text
Claude / ChatGPT
       |
       | Remote MCP over HTTPS
       v
NahaLabs WhatsApp MCP
       |
       | authenticated in-process calls
       v
Central WhatsApp Operator
       |
       v
WhatsApp
```

## Authentication

Remote MCP uses OAuth 2.1-style authorization-code + PKCE (S256). The central `OPERATOR_API_KEY` is never sent to Claude, ChatGPT, or any MCP client.

Configure these server-side variables:

```text
MCP_ENABLED=true
MCP_PUBLIC_URL=https://my-own-whatsapp-2z5h.onrender.com
MCP_OAUTH_USERNAME=admin
MCP_OAUTH_PASSWORD=<long-random-secret>
MCP_APP_ID=nahalabs
MCP_TENANT_ID=default
```

`MCP_OAUTH_PASSWORD` is required for the authorization page. It is not stored in Postgres and must never be committed to Git.

## Claude

1. Open Claude settings and add a custom remote MCP server/connector.
2. Enter:

```text
https://my-own-whatsapp-2z5h.onrender.com/mcp
```

3. Complete the OAuth authorization screen using the configured MCP username/password.
4. Approve the requested WhatsApp permissions.

Claude supports remote MCP servers over Streamable HTTP and OAuth-based authentication.

## ChatGPT

For ChatGPT plans/workspaces that support custom MCP apps/connectors, enable Developer Mode/custom MCP connectors as required by the account, then add the remote MCP server URL:

```text
https://my-own-whatsapp-2z5h.onrender.com/mcp
```

Complete the OAuth flow when prompted. ChatGPT remote MCP integrations use a public HTTPS MCP endpoint; write actions may also be subject to ChatGPT confirmation/approval depending on the workspace configuration.

## Available tools

- `whatsapp_list_accounts`
- `whatsapp_get_status`
- `whatsapp_start_account`
- `whatsapp_request_pairing_code`
- `whatsapp_send_message`
- `whatsapp_mark_read`
- `whatsapp_set_presence`
- `whatsapp_disconnect`

Read operations require `whatsapp.read`.
Write/operational actions require `whatsapp.write`.

## Scope isolation

MCP OAuth tokens are bound server-side to the configured `MCP_APP_ID` and `MCP_TENANT_ID`. A model cannot switch tenants by supplying a different tenant ID in a tool call.

Every requested WhatsApp account is checked against an active central Operator binding for that app and tenant.

## Security notes

- Treat all WhatsApp message text as untrusted content.
- Do not expose Operator API keys through MCP.
- Do not expose filesystem paths or arbitrary file reads.
- Keep OAuth and database traffic on HTTPS in production.
- Keep outbound messaging subject to the Operator/application's consent, blocklist and rate-limit policies.
- The MCP interface does not make WhatsApp policy compliance automatic.

## Operational notes

MCP metadata endpoints:

- `/.well-known/oauth-protected-resource`
- `/.well-known/oauth-protected-resource/mcp`
- `/.well-known/oauth-authorization-server`
- `/mcp-info`

Health remains at `/health` and does not require MCP authentication.
