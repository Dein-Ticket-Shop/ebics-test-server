import type { Server as HttpServer } from 'node:http';
import { serve } from '@hono/node-server';
import { createServerApp } from './server.js';
import { REALTIME_PATH } from './realtime/notifications.js';

const HOST_ID = process.env['EBICS_HOST_ID'] ?? 'TESTHOST';
const PORT = parseInt(process.env['PORT'] ?? '4150', 10);
// Persist to a file so subscribers, bank keys and nonces survive `tsx watch` reloads
// and restarts. Set EBICS_DB_PATH=':memory:' for an ephemeral run.
const DB_PATH = process.env['EBICS_DB_PATH'] ?? './ebics-test.db';

const { app, realtime } = createServerApp({
  hostId: HOST_ID,
  dbPath: DB_PATH,
  validateRequests: true,
  validateResponses: true,
});

const server = serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`EBICS test server running on http://localhost:${info.port}`);
  console.log(`Host ID: ${HOST_ID}`);
  console.log(`EBICS endpoint: POST http://localhost:${info.port}/ebics`);
  console.log(`Real-time notifications: ws://localhost:${info.port}${REALTIME_PATH}`);
  console.log(`DB: ${DB_PATH}`);
});
realtime.attach(server as HttpServer);
