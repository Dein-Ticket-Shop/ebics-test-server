import { Hono } from 'hono';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createEbicsRoute, type EbicsRouteConfig } from './routes/ebics.js';
import { createAdminRoute } from './routes/admin.js';
import type { AppStore } from './store/types.js';
import { SqliteStore } from './store/sqlite-store.js';
import { generateBankKeys } from './bank/bank-keys.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const ADMIN_BUILD = join(__dirname, '../../admin-ui/build');

export interface ServerConfig {
  hostId: string;
  store?: AppStore;
  dbPath?: string;
  validateRequests?: boolean;
  validateResponses?: boolean;
}

export function createApp(config: ServerConfig) {
  const app = new Hono();

  const store = config.store ?? new SqliteStore(config.dbPath);

  if (!store.getHostConfig()) {
    const bankKeys = generateBankKeys(config.hostId);
    store.setHostConfig({ hostId: config.hostId, bankKeys });
  }

  const ebicsConfig: EbicsRouteConfig = {
    dispatcher: { hostId: config.hostId, store },
    validateRequests: config.validateRequests ?? true,
    validateResponses: config.validateResponses ?? true,
  };

  app.route('/ebics', createEbicsRoute(ebicsConfig));
  app.route('/api', createAdminRoute(store, config.hostId));

  app.get('/health', (c) => c.json({ status: 'ok' }));

  if (existsSync(ADMIN_BUILD)) {
    app.use('/admin/*', serveStatic({
      root: ADMIN_BUILD,
      rewriteRequestPath: (path) => path.replace(/^\/admin/, ''),
    }));

    app.get('/admin/*', (c) => {
      return c.html(readFileSync(join(ADMIN_BUILD, 'index.html'), 'utf8'));
    });

    app.get('/admin', (c) => {
      return c.html(readFileSync(join(ADMIN_BUILD, 'index.html'), 'utf8'));
    });
  }

  return app;
}
