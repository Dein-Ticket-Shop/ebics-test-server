import { createApp } from '../../src/server.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';

export const HOST_ID = 'TESTHOST';
export const PARTNER_ID = 'PARTNER1';
export const USER_ID = 'USER1';

export function createTestApp() {
  const store = new SqliteStore(':memory:');
  const app = createApp({
    hostId: HOST_ID,
    store,
    validateRequests: true,
    validateResponses: true,
  });
  return { app, store };
}

export async function postEbics(app: ReturnType<typeof createTestApp>['app'], xml: string) {
  return app.request('/ebics', {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml' },
    body: xml,
  });
}
