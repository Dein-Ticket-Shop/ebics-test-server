import { serve } from '@hono/node-server';
import { createApp } from './server.js';
import { logServer } from './logger.js';

const HOST_ID = process.env['EBICS_HOST_ID'] ?? 'TESTHOST';
const PORT = parseInt(process.env['PORT'] ?? '4150', 10);
// Persist to a file so subscribers, bank keys and nonces survive `tsx watch` reloads
// and restarts. Set EBICS_DB_PATH=':memory:' for an ephemeral run.
const DB_PATH = process.env['EBICS_DB_PATH'] ?? './ebics-test.db';

const app = createApp({
  hostId: HOST_ID,
  dbPath: DB_PATH,
  validateRequests: true,
  validateResponses: true,
});

serve({ fetch: app.fetch, port: PORT }, (info) => {
  logServer(`EBICS test server running on http://localhost:${info.port}`);
  logServer(`Host ID: ${HOST_ID}  |  endpoint: POST http://localhost:${info.port}/ebics`);
  logServer(`DB: ${DB_PATH}`);
});
