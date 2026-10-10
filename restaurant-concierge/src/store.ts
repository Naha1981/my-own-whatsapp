import type { StoredMessage } from './db.js';

/** Persistence contract the routers use. The real implementation is db.ts;
 * tests substitute an in-memory store. */
export interface Store {
  storeInbound(message: {
    branchId: string;
    customerPhone: string;
    pushName: string | null;
    text: string | null;
    messageType: string | null;
    waMessageId: string | null;
    payload: unknown;
  }): Promise<StoredMessage | null>;
  storeOutbound(message: {
    branchId: string;
    customerPhone: string;
    text: string;
    status: 'sent' | 'simulated' | 'failed';
    payload: unknown;
  }): Promise<StoredMessage>;
  listInbox(params: { branchId?: string; status?: string; limit: number }): Promise<StoredMessage[]>;
  listConversation(branchId: string, customerPhone: string, limit: number): Promise<StoredMessage[]>;
  listOutbound(branchId: string, customerPhone: string | null, limit: number): Promise<StoredMessage[]>;
  setMessageStatus(id: number, status: string): Promise<StoredMessage | null>;
  markConversationReplied(branchId: string, customerPhone: string): Promise<void>;
}
