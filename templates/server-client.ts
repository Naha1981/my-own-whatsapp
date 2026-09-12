/*
 * NahaLabs WhatsApp server-side integration template.
 *
 * Copy into the consuming application and adapt it to the app's framework.
 * Never expose OPERATOR_API_KEY to browser/client code.
 */

export type OperatorConfig = {
  baseUrl: string;
  apiKey: string;
  appId: string;
  tenantId: string;
};

export type BootstrapResult = {
  waAccountId: string;
  status: string;
  appId: string;
  tenantId: string;
  created: boolean;
  webhookConfigured: boolean;
};

export type SendTextInput = {
  waAccountId: string;
  to: string;
  text: string;
};

export class NahaLabsWhatsApp {
  constructor(private readonly config: OperatorConfig) {}

  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('X-API-Key', this.config.apiKey);
    headers.set('X-App-Id', this.config.appId);
    headers.set('X-Tenant-Id', this.config.tenantId);
    if (init.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');

    const response = await fetch(`${this.config.baseUrl.replace(/\/$/, '')}${path}`, {
      ...init,
      headers,
    });

    const text = await response.text();
    let body: unknown = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }

    if (!response.ok) {
      const message = typeof body === 'object' && body && 'message' in body
        ? String((body as { message?: unknown }).message)
        : `Operator request failed with HTTP ${response.status}`;
      throw new Error(message);
    }

    return body as T;
  }

  async bootstrap(webhookUrl?: string): Promise<BootstrapResult> {
    return this.request<BootstrapResult>('/accounts/bootstrap', {
      method: 'POST',
      body: JSON.stringify({
        label: `${this.config.appId} WhatsApp`,
        appId: this.config.appId,
        tenantId: this.config.tenantId,
        ...(webhookUrl ? { webhookUrl } : {}),
      }),
    });
  }

  async connect(waAccountId: string): Promise<unknown> {
    return this.request(`/accounts/${encodeURIComponent(waAccountId)}/connect`, { method: 'POST' });
  }

  async status(waAccountId: string): Promise<unknown> {
    return this.request(`/accounts/${encodeURIComponent(waAccountId)}/status`);
  }

  async qr(waAccountId: string): Promise<unknown> {
    return this.request(`/accounts/${encodeURIComponent(waAccountId)}/qr`);
  }

  async pairingCode(waAccountId: string, phoneNumber: string): Promise<unknown> {
    return this.request(`/accounts/${encodeURIComponent(waAccountId)}/pairing-code`, {
      method: 'POST',
      body: JSON.stringify({ phoneNumber }),
    });
  }

  async sendText(input: SendTextInput): Promise<unknown> {
    return this.request('/send', {
      method: 'POST',
      body: JSON.stringify({ ...input, type: 'text' }),
    });
  }

  async sendMedia(waAccountId: string, to: string, type: 'image' | 'video' | 'audio' | 'document' | 'sticker', url: string, extra: Record<string, unknown> = {}) {
    return this.request('/send', {
      method: 'POST',
      body: JSON.stringify({ waAccountId, to, type, url, ...extra }),
    });
  }

  async reset(waAccountId: string): Promise<unknown> {
    return this.request(`/accounts/${encodeURIComponent(waAccountId)}/reset`, { method: 'POST' });
  }

  async disconnect(waAccountId: string): Promise<unknown> {
    return this.request(`/accounts/${encodeURIComponent(waAccountId)}/disconnect`, { method: 'POST' });
  }
}
