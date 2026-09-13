import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import { createTestApp, postEbics, PARTNER_ID, USER_ID } from '../helpers/test-server.js';
import { enrolSubscriber, downloadOrder, type EbicsSession } from '../helpers/ebics-session.js';
import type { DownloadParams } from '../helpers/test-client.js';

function withTempDir(run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'ebics-download-data-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('seeded download data per ServiceOption', () => {
  describe('store', () => {
    let store: SqliteStore;

    beforeEach(() => {
      store = new SqliteStore(':memory:');
    });

    it('prefers the entry for the exact ServiceOption over one without option', () => {
      store.upsertDownloadData('STM', 'camt.054', 'GENERIC', 'text');
      store.upsertDownloadData('STM', 'camt.054', 'SCI ONLY', 'text', 'SCI');
      store.upsertDownloadData('STM', 'camt.054', 'URG ONLY', 'text', 'URG');

      expect(store.listDownloadData()).toHaveLength(3);
      expect(store.getDownloadData('STM', 'camt.054', 'SCI')).toMatchObject({ content: 'SCI ONLY', serviceOption: 'SCI', msgName: 'camt.054' });
      expect(store.getDownloadData('STM', 'camt.054', 'URG')!.content).toBe('URG ONLY');
      expect(store.getDownloadData('STM', 'camt.054', 'COR')!.content).toBe('GENERIC');
      const generic = store.getDownloadData('STM', 'camt.054')!;
      expect(generic.content).toBe('GENERIC');
      expect(generic.serviceOption).toBeUndefined();
    });

    it('serves an option-specific entry only to requests with that option', () => {
      store.upsertDownloadData('REP', 'pain.002', 'VOP ONLY', 'text', 'VOP');
      expect(store.getDownloadData('REP', 'pain.002')).toBeUndefined();
      expect(store.getDownloadData('REP', 'pain.002', 'SCI')).toBeUndefined();
      expect(store.getDownloadData('REP', 'pain.002', 'VOP')!.content).toBe('VOP ONLY');
      expect(store.getDownloadData('REP', 'camt.054', 'VOP')).toBeUndefined();
      expect(store.getDownloadData('STM', 'pain.002', 'VOP')).toBeUndefined();
    });

    it('updates the entry with the same service name, option and message name', () => {
      store.upsertDownloadData('STM', 'camt.054', 'v1', 'text');
      store.upsertDownloadData('STM', 'camt.054', 'sci v1', 'text', 'SCI');
      const [generic, sci] = store.listDownloadData();

      store.upsertDownloadData('STM', 'camt.054', 'v2', 'base64');
      store.upsertDownloadData('STM', 'camt.054', 'sci v2', 'text', 'SCI');

      const entries = store.listDownloadData();
      expect(entries).toHaveLength(2);
      expect(entries[0]).toMatchObject({ id: generic!.id, content: 'v2', contentType: 'base64' });
      expect(entries[1]).toMatchObject({ id: sci!.id, content: 'sci v2', contentType: 'text', serviceOption: 'SCI' });
    });

    it('treats a missing message name as a key of its own', () => {
      store.upsertDownloadData('STA', undefined, 'NO MSG', 'text');
      store.upsertDownloadData('STA', undefined, 'NO MSG v2', 'text');
      store.upsertDownloadData('STA', 'mt940', 'MT940', 'text');

      expect(store.listDownloadData()).toHaveLength(2);
      expect(store.getDownloadData('STA')).toMatchObject({ content: 'NO MSG v2', msgName: undefined });
      expect(store.getDownloadData('STA', 'mt940')!.content).toBe('MT940');
      expect(store.getDownloadData('STA', 'camt.053')).toBeUndefined();
    });

    it('deletes single entries and then falls back to the entry without option', () => {
      store.upsertDownloadData('STM', 'camt.054', 'GENERIC', 'text');
      store.upsertDownloadData('STM', 'camt.054', 'SCI ONLY', 'text', 'SCI');
      const sci = store.getDownloadData('STM', 'camt.054', 'SCI')!;

      store.deleteDownloadData(sci.id);
      expect(store.listDownloadData().map((d) => d.content)).toEqual(['GENERIC']);
      expect(store.getDownloadData('STM', 'camt.054', 'SCI')!.content).toBe('GENERIC');

      store.deleteDownloadData(store.getDownloadData('STM', 'camt.054')!.id);
      expect(store.getDownloadData('STM', 'camt.054', 'SCI')).toBeUndefined();

      // Unknown IDs are ignored
      expect(() => store.deleteDownloadData(9999)).not.toThrow();
    });

    it('is cleared by reset', () => {
      store.upsertDownloadData('STM', 'camt.054', 'SCI ONLY', 'text', 'SCI');
      store.reset();
      expect(store.listDownloadData()).toEqual([]);
    });
  });

  describe('schema', () => {
    it('enforces one entry per service name, option and message name with idx_download_data_service', () => {
      withTempDir((dir) => {
        const path = join(dir, 'new.db');
        new SqliteStore(path);

        const db = new Database(path);
        try {
          const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'download_data'").all() as { name: string }[]).map((r) => r.name);
          expect(indexes).toContain('idx_download_data_service');

          const insert = db.prepare('INSERT INTO download_data (service_name, service_option, msg_name, content) VALUES (?, ?, ?, ?)');
          insert.run('STA', null, null, 'a');
          expect(() => insert.run('STA', null, null, 'b')).toThrow(/UNIQUE/);
          insert.run('STA', 'SCI', null, 'c');
          expect(() => insert.run('STA', 'SCI', null, 'd')).toThrow(/UNIQUE/);
          insert.run('STA', null, 'mt940', 'e');
          insert.run('STA', 'SCI', 'mt940', 'f');
          expect(() => insert.run('STA', 'SCI', 'mt940', 'g')).toThrow(/UNIQUE/);
        } finally {
          db.close();
        }
      });
    });
  });

  describe('migration', () => {
    it('rebuilds an old download_data table that was UNIQUE(service_name, msg_name)', () => {
      withTempDir((dir) => {
        const path = join(dir, 'old.db');
        const old = new Database(path);
        old.exec(`
          CREATE TABLE download_data (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            service_name TEXT NOT NULL,
            msg_name TEXT,
            content TEXT NOT NULL,
            content_type TEXT NOT NULL DEFAULT 'text',
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(service_name, msg_name)
          );
          INSERT INTO download_data (id, service_name, msg_name, content, content_type, created_at)
            VALUES (3, 'STA', 'mt940', ':20:OLD', 'text', '2024-01-01 10:00:00');
          INSERT INTO download_data (id, service_name, msg_name, content, content_type, created_at)
            VALUES (7, 'EOP', 'camt.053', 'PERvY3VtZW50Lz4=', 'base64', '2024-01-02 11:00:00');
        `);
        old.close();

        const migrated = new SqliteStore(path);
        expect(migrated.listDownloadData()).toEqual([
          { id: 3, serviceName: 'STA', msgName: 'mt940', content: ':20:OLD', contentType: 'text', createdAt: '2024-01-01 10:00:00' },
          { id: 7, serviceName: 'EOP', msgName: 'camt.053', content: 'PERvY3VtZW50Lz4=', contentType: 'base64', createdAt: '2024-01-02 11:00:00' },
        ]);
        expect(migrated.listDownloadData().every((d) => d.serviceOption === undefined)).toBe(true);

        // The old unique constraint would refuse a second STA/mt940 entry
        migrated.upsertDownloadData('STA', 'mt940', ':20:SCI', 'text', 'SCI');
        expect(migrated.getDownloadData('STA', 'mt940', 'SCI')!.content).toBe(':20:SCI');
        expect(migrated.getDownloadData('STA', 'mt940')!.content).toBe(':20:OLD');
        const added = migrated.listDownloadData().find((d) => d.serviceOption === 'SCI')!;
        expect(added.id).toBeGreaterThan(7);

        const db = new Database(path);
        try {
          const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'download_data'").get() as { sql: string };
          expect(table.sql).toContain('service_option');
          expect(table.sql).not.toMatch(/UNIQUE/i);
          expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'download_data_new'").get()).toBeUndefined();
          const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'download_data'").all() as { name: string }[]).map((r) => r.name);
          expect(indexes).toContain('idx_download_data_service');
        } finally {
          db.close();
        }

        // Opening again is idempotent and keeps the data
        const reopened = new SqliteStore(path);
        expect(reopened.listDownloadData()).toHaveLength(3);
        expect(reopened.getDownloadData('STA', 'mt940', 'SCI')!.content).toBe(':20:SCI');
      });
    });
  });

  describe('admin routes and BTD lookup', () => {
    it('seeds, lists and deletes entries and serves the one for the requested ServiceOption', async () => {
      const { app, store } = createTestApp();
      const session: EbicsSession = await enrolSubscriber({
        post: async (xml) => (await postEbics(app, xml)).text(),
        activate: (partnerId, userId) => app.request(`/api/subscribers/${partnerId}/${userId}/activate`, { method: 'POST' }),
        store,
        partnerId: PARTNER_ID,
        userId: USER_ID,
      });

      const request = async (method: string, path: string, body?: unknown) => {
        const res = await app.request(`/api${path}`, {
          method,
          headers: { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: res.status, json: (await res.json()) as any };
      };
      const btd = async (serviceOption?: string) => {
        const params: DownloadParams = { serviceName: 'STM', scope: 'DE', msgName: 'camt.054', ...(serviceOption ? { serviceOption } : {}) };
        const result = await downloadOrder(session, 'BTD', params);
        return result.code === '000000' ? result.data!.toString('utf8') : result.code;
      };

      expect(await request('POST', '/download-data', { serviceName: 'STM', msgName: 'camt.054', content: 'GENERIC' })).toEqual({
        status: 200,
        json: { status: 'ok', serviceName: 'STM' },
      });
      expect((await request('POST', '/download-data', { serviceName: 'STM', serviceOption: 'SCI', msgName: 'camt.054', content: 'OPTION SCI' })).status).toBe(200);
      expect((await request('POST', '/download-data', { serviceName: 'STM', msgName: 'camt.054' })).status).toBe(400);
      expect((await request('POST', '/download-data', { msgName: 'camt.054', content: 'x' })).status).toBe(400);

      const listed = (await request('GET', '/download-data')).json as { id: number; serviceOption?: string; content: string }[];
      expect(listed).toHaveLength(2);
      const sci = listed.find((d) => d.serviceOption === 'SCI')!;
      expect(sci.content).toBe('OPTION SCI');
      expect(listed.find((d) => d.serviceOption === undefined)!.content).toBe('GENERIC');

      expect(await btd('SCI')).toBe('OPTION SCI');
      expect(await btd()).toBe('GENERIC');
      expect(await btd('URG')).toBe('GENERIC');

      // An empty serviceOption addresses the entry without option
      await request('POST', '/download-data', { serviceName: 'STM', serviceOption: '', msgName: 'camt.054', content: 'GENERIC v2' });
      expect(store.listDownloadData()).toHaveLength(2);
      expect(await btd()).toBe('GENERIC v2');

      expect(await request('DELETE', `/download-data/${sci.id}`)).toEqual({ status: 200, json: { status: 'deleted' } });
      expect(await btd('SCI')).toBe('GENERIC v2');

      // Without seeded data the dynamic camt.054 generation answers (no bookings yet)
      await request('DELETE', `/download-data/${store.getDownloadData('STM', 'camt.054')!.id}`);
      expect((await request('GET', '/download-data')).json).toEqual([]);
      expect(await btd('SCI')).toBe('090005');
    });
  });
});
