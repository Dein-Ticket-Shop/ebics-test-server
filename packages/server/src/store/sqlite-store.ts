import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EbicsStore, Subscriber, SubscriberKeys, HostConfig, BankKeys, ActivityLogEntry, ProtocolLogEntry, Transaction, TransactionPhase, DownloadData, BankingStore, BankConfig, Person, Account, Booking, AppStore, UploadedOrder } from './types.js';
import type {
  DateFilter,
  DeliveryKind,
  HacEvent,
  NewHacEvent,
  NewPaymentOrder,
  NewPaymentTransaction,
  OrderSignature,
  OrderSignatureKind,
  PaymentOrder,
  PaymentOrderStatus,
  PaymentStatusCode,
  PaymentStatusEvent,
  PaymentTransaction,
  VopStatus,
} from './types.js';
import { SubscriberState } from './types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export class SqliteStore implements AppStore {
  private db: Database.Database;
  readonly events = new EventEmitter();

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf8');
    this.db.exec(schema);
    this.migrate();
  }

  /** Adds columns introduced after the first release to databases created by an older schema.sql */
  private migrate(): void {
    this.ensureColumn('transactions', 'order_id', 'TEXT');
    this.ensureColumn('transactions', 'service_option', 'TEXT');
    this.ensureColumn('transactions', 'request_eds', 'INTEGER NOT NULL DEFAULT 0');
    this.ensureColumn('transactions', 'delivery_kind', 'TEXT');
    this.ensureColumn('transactions', 'delivery_keys', 'TEXT');
    this.ensureColumn('uploaded_orders', 'order_id', 'TEXT');
    this.ensureColumn('payment_orders', 'signatures_required', 'INTEGER NOT NULL DEFAULT 1');
    this.ensureColumn('payment_orders', 'vop_confirmation_required', 'INTEGER NOT NULL DEFAULT 0');
    this.migrateDownloadDataServiceOption();
  }

  /** download_data used to be UNIQUE(service_name, msg_name); rebuild it with the optional service_option */
  private migrateDownloadDataServiceOption(): void {
    const table = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'download_data'").get() as { sql: string };
    if (!table.sql.includes('service_option')) {
      this.db.transaction(() => {
        this.db.exec(`
          CREATE TABLE download_data_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            service_name TEXT NOT NULL,
            service_option TEXT,
            msg_name TEXT,
            content TEXT NOT NULL,
            content_type TEXT NOT NULL DEFAULT 'text',
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
        this.db.exec(`
          INSERT INTO download_data_new (id, service_name, msg_name, content, content_type, created_at)
          SELECT id, service_name, msg_name, content, content_type, created_at FROM download_data
        `);
        this.db.exec('DROP TABLE download_data');
        this.db.exec('ALTER TABLE download_data_new RENAME TO download_data');
      })();
    }
    this.db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_download_data_service ON download_data(service_name, COALESCE(service_option, ''), COALESCE(msg_name, ''))",
    );
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
    if (!columns.some((c) => c.name === column)) {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }

  getHostConfig(): HostConfig | undefined {
    const row = this.db.prepare('SELECT * FROM host_config WHERE id = 1').get() as Record<string, string> | undefined;
    if (!row) return undefined;
    return {
      hostId: row['host_id'],
      bankKeys: {
        authenticationPrivateKey: row['auth_private_key'],
        authenticationCertificate: row['auth_certificate'],
        authenticationVersion: row['auth_version'],
        encryptionPrivateKey: row['enc_private_key'],
        encryptionCertificate: row['enc_certificate'],
        encryptionVersion: row['enc_version'],
      },
    };
  }

  setHostConfig(config: HostConfig): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO host_config (id, host_id, auth_private_key, auth_certificate, auth_version, enc_private_key, enc_certificate, enc_version)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      config.hostId,
      config.bankKeys.authenticationPrivateKey,
      config.bankKeys.authenticationCertificate,
      config.bankKeys.authenticationVersion,
      config.bankKeys.encryptionPrivateKey,
      config.bankKeys.encryptionCertificate,
      config.bankKeys.encryptionVersion,
    );
  }

  createSubscriber(partnerId: string, userId: string): Subscriber {
    this.db.prepare(`
      INSERT INTO subscribers (partner_id, user_id, state)
      VALUES (?, ?, ?)
    `).run(partnerId, userId, SubscriberState.NEW);

    return this.getSubscriber(partnerId, userId)!;
  }

  getSubscriber(partnerId: string, userId: string): Subscriber | undefined {
    const row = this.db.prepare(
      'SELECT * FROM subscribers WHERE partner_id = ? AND user_id = ?',
    ).get(partnerId, userId) as Record<string, string | null> | undefined;

    if (!row) return undefined;
    return this.rowToSubscriber(row);
  }

  listSubscribers(): Subscriber[] {
    const rows = this.db.prepare('SELECT * FROM subscribers').all() as Record<string, string | null>[];
    return rows.map((r) => this.rowToSubscriber(r));
  }

  updateSubscriberState(partnerId: string, userId: string, state: SubscriberState): void {
    this.db.prepare(`
      UPDATE subscribers SET state = ?, updated_at = datetime('now')
      WHERE partner_id = ? AND user_id = ?
    `).run(state, partnerId, userId);
  }

  updateSubscriberKeys(partnerId: string, userId: string, keys: Partial<SubscriberKeys>): void {
    const sets: string[] = [];
    const values: (string | undefined)[] = [];

    if (keys.signatureVersion !== undefined) { sets.push('signature_version = ?'); values.push(keys.signatureVersion); }
    if (keys.signatureCertificate !== undefined) { sets.push('signature_certificate = ?'); values.push(keys.signatureCertificate); }
    if (keys.authenticationVersion !== undefined) { sets.push('authentication_version = ?'); values.push(keys.authenticationVersion); }
    if (keys.authenticationCertificate !== undefined) { sets.push('authentication_certificate = ?'); values.push(keys.authenticationCertificate); }
    if (keys.encryptionVersion !== undefined) { sets.push('encryption_version = ?'); values.push(keys.encryptionVersion); }
    if (keys.encryptionCertificate !== undefined) { sets.push('encryption_certificate = ?'); values.push(keys.encryptionCertificate); }

    if (sets.length === 0) return;

    sets.push("updated_at = datetime('now')");
    this.db.prepare(
      `UPDATE subscribers SET ${sets.join(', ')} WHERE partner_id = ? AND user_id = ?`,
    ).run(...values, partnerId, userId);
  }

  deleteSubscriber(partnerId: string, userId: string): void {
    this.db.prepare('DELETE FROM subscribers WHERE partner_id = ? AND user_id = ?').run(partnerId, userId);
  }

  storeNonce(nonce: string, timestamp: string): void {
    this.db.prepare('INSERT OR IGNORE INTO nonces (nonce, timestamp) VALUES (?, ?)').run(nonce, timestamp);
  }

  hasNonce(nonce: string): boolean {
    const row = this.db.prepare('SELECT 1 FROM nonces WHERE nonce = ?').get(nonce);
    return row !== undefined;
  }

  cleanExpiredNonces(): void {
    this.db.prepare("DELETE FROM nonces WHERE created_at < datetime('now', '-12 hours')").run();
  }

  logActivity(entry: Omit<ActivityLogEntry, 'id' | 'createdAt'>): void {
    this.db.prepare(`
      INSERT INTO activity_log (event_type, partner_id, user_id, order_type, result_code, details)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      entry.eventType,
      entry.partnerId ?? null,
      entry.userId ?? null,
      entry.orderType ?? null,
      entry.resultCode ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
    );
  }

  getActivityLog(limit: number = 50, offset: number = 0): ActivityLogEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM activity_log ORDER BY id DESC LIMIT ? OFFSET ?',
    ).all(limit, offset) as Record<string, string | number | null>[];

    return rows.map((row) => ({
      id: row['id'] as number,
      eventType: row['event_type'] as string,
      partnerId: (row['partner_id'] as string) ?? undefined,
      userId: (row['user_id'] as string) ?? undefined,
      orderType: (row['order_type'] as string) ?? undefined,
      resultCode: (row['result_code'] as string) ?? undefined,
      details: row['details'] ? JSON.parse(row['details'] as string) : undefined,
      createdAt: row['created_at'] as string,
    }));
  }

  logProtocol(entry: Omit<ProtocolLogEntry, 'id' | 'createdAt'>): ProtocolLogEntry {
    const result = this.db.prepare(`
      INSERT INTO protocol_log (root_element, order_type, partner_id, user_id, transaction_id, transaction_phase, return_code, request_xml, response_xml, duration_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.rootElement ?? null, entry.orderType ?? null,
      entry.partnerId ?? null, entry.userId ?? null,
      entry.transactionId ?? null, entry.transactionPhase ?? null,
      entry.returnCode ?? null, entry.requestXml, entry.responseXml,
      entry.durationMs ?? null,
    );
    return this.getProtocolLogEntry(Number(result.lastInsertRowid))!;
  }

  getProtocolLog(limit: number = 50, offset: number = 0): ProtocolLogEntry[] {
    const rows = this.db.prepare(
      'SELECT * FROM protocol_log ORDER BY id DESC LIMIT ? OFFSET ?',
    ).all(limit, offset) as Record<string, string | number | null>[];
    return rows.map((r) => this.rowToProtocolLog(r));
  }

  getProtocolLogEntry(id: number): ProtocolLogEntry | undefined {
    const row = this.db.prepare('SELECT * FROM protocol_log WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
    if (!row) return undefined;
    return this.rowToProtocolLog(row);
  }

  private rowToProtocolLog(row: Record<string, string | number | null>): ProtocolLogEntry {
    return {
      id: row['id'] as number,
      rootElement: (row['root_element'] as string) ?? undefined,
      orderType: (row['order_type'] as string) ?? undefined,
      partnerId: (row['partner_id'] as string) ?? undefined,
      userId: (row['user_id'] as string) ?? undefined,
      transactionId: (row['transaction_id'] as string) ?? undefined,
      transactionPhase: (row['transaction_phase'] as string) ?? undefined,
      returnCode: (row['return_code'] as string) ?? undefined,
      requestXml: row['request_xml'] as string,
      responseXml: row['response_xml'] as string,
      durationMs: (row['duration_ms'] as number) ?? undefined,
      createdAt: row['created_at'] as string,
    };
  }

  createTransaction(tx: Omit<Transaction, 'createdAt' | 'expiresAt'>): Transaction {
    const now = new Date().toISOString().replace('T', ' ').replace('Z', '');
    const expires = new Date(Date.now() + 3600_000).toISOString().replace('T', ' ').replace('Z', '');

    this.db.prepare(`
      INSERT INTO transactions (transaction_id, partner_id, user_id, host_id, direction, phase, order_type, num_segments, current_segment, segments, transaction_key, enc_key_digest, signature_data, service_name, msg_name, order_id, service_option, request_eds, delivery_kind, delivery_keys, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tx.transactionId, tx.partnerId, tx.userId, tx.hostId,
      tx.direction, tx.phase, tx.orderType, tx.numSegments, tx.currentSegment,
      JSON.stringify(tx.segments), tx.transactionKey, tx.encKeyDigest,
      tx.signatureData ?? null, tx.serviceName ?? null, tx.msgName ?? null,
      tx.orderId ?? null, tx.serviceOption ?? null, tx.requestEds ? 1 : 0,
      tx.deliveryKind ?? null, tx.deliveryKeys ? JSON.stringify(tx.deliveryKeys) : null,
      now, expires,
    );

    return { ...tx, createdAt: now, expiresAt: expires };
  }

  getTransaction(transactionId: string): Transaction | undefined {
    const row = this.db.prepare('SELECT * FROM transactions WHERE transaction_id = ?').get(transactionId) as Record<string, string | number | null> | undefined;
    if (!row) return undefined;
    return this.rowToTransaction(row);
  }

  updateTransactionPhase(transactionId: string, phase: TransactionPhase): void {
    this.db.prepare('UPDATE transactions SET phase = ? WHERE transaction_id = ?').run(phase, transactionId);
  }

  updateTransactionSegment(transactionId: string, currentSegment: number): void {
    this.db.prepare('UPDATE transactions SET current_segment = ? WHERE transaction_id = ?').run(currentSegment, transactionId);
  }

  deleteTransaction(transactionId: string): void {
    this.db.prepare('DELETE FROM transactions WHERE transaction_id = ?').run(transactionId);
  }

  cleanExpiredTransactions(): void {
    this.db.prepare("DELETE FROM transactions WHERE expires_at < datetime('now')").run();
  }

  appendUploadSegment(transactionId: string, segment: string): void {
    const tx = this.getTransaction(transactionId);
    if (!tx) return;
    const segments = [...tx.segments, segment];
    this.db.prepare(
      'UPDATE transactions SET segments = ?, current_segment = ? WHERE transaction_id = ?',
    ).run(JSON.stringify(segments), segments.length, transactionId);
  }

  upsertDownloadData(serviceName: string, msgName: string | undefined, content: string, contentType: string, serviceOption?: string): void {
    const existing = this.db.prepare(`
      SELECT id FROM download_data
      WHERE service_name = ? AND COALESCE(service_option, '') = COALESCE(?, '') AND COALESCE(msg_name, '') = COALESCE(?, '')
    `).get(serviceName, serviceOption ?? null, msgName ?? null) as { id: number } | undefined;
    if (existing) {
      this.db.prepare('UPDATE download_data SET content = ?, content_type = ? WHERE id = ?').run(content, contentType, existing.id);
      return;
    }
    this.db.prepare(`
      INSERT INTO download_data (service_name, service_option, msg_name, content, content_type) VALUES (?, ?, ?, ?, ?)
    `).run(serviceName, serviceOption ?? null, msgName ?? null, content, contentType);
  }

  /** Seeded data for a BTF: an entry for exactly this ServiceOption wins over one without an option */
  getDownloadData(serviceName: string, msgName?: string, serviceOption?: string): DownloadData | undefined {
    const row = this.db.prepare(`
      SELECT * FROM download_data
      WHERE service_name = ? AND COALESCE(msg_name, '') = COALESCE(?, '') AND (service_option IS NULL OR service_option = ?)
      ORDER BY service_option IS NULL
      LIMIT 1
    `).get(serviceName, msgName ?? null, serviceOption ?? null) as Row | undefined;
    return row ? this.rowToDownloadData(row) : undefined;
  }

  listDownloadData(): DownloadData[] {
    const rows = this.db.prepare('SELECT * FROM download_data ORDER BY id').all() as Row[];
    return rows.map((r) => this.rowToDownloadData(r));
  }

  deleteDownloadData(id: number): void {
    this.db.prepare('DELETE FROM download_data WHERE id = ?').run(id);
  }

  private rowToDownloadData(r: Row): DownloadData {
    return {
      id: r['id'] as number,
      serviceName: r['service_name'] as string,
      serviceOption: (r['service_option'] as string) ?? undefined,
      msgName: (r['msg_name'] as string) ?? undefined,
      content: r['content'] as string,
      contentType: r['content_type'] as string,
      createdAt: r['created_at'] as string,
    };
  }

  createUploadedOrder(data: Omit<UploadedOrder, 'id' | 'processed' | 'createdAt' | 'orderId'> & { orderId?: string }): UploadedOrder {
    const result = this.db.prepare(`
      INSERT INTO uploaded_orders (partner_id, user_id, service_name, msg_name, raw_content, order_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(data.partnerId, data.userId, data.serviceName, data.msgName ?? null, data.rawContent, data.orderId ?? null);
    return this.getUploadedOrder(Number(result.lastInsertRowid))!;
  }

  listUploadedOrders(): UploadedOrder[] {
    const rows = this.db.prepare('SELECT * FROM uploaded_orders ORDER BY id DESC').all() as Record<string, string | number | null>[];
    return rows.map((r) => this.rowToUploadedOrder(r));
  }

  getUploadedOrder(id: number): UploadedOrder | undefined {
    const row = this.db.prepare('SELECT * FROM uploaded_orders WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
    if (!row) return undefined;
    return this.rowToUploadedOrder(row);
  }

  markUploadedOrderProcessed(id: number): void {
    this.db.prepare('UPDATE uploaded_orders SET processed = 1 WHERE id = ?').run(id);
  }

  private rowToUploadedOrder(row: Record<string, string | number | null>): UploadedOrder {
    return {
      id: row['id'] as number,
      partnerId: row['partner_id'] as string,
      userId: row['user_id'] as string,
      serviceName: row['service_name'] as string,
      msgName: (row['msg_name'] as string) ?? undefined,
      rawContent: row['raw_content'] as string,
      processed: (row['processed'] as number) === 1,
      orderId: (row['order_id'] as string) ?? undefined,
      createdAt: row['created_at'] as string,
    };
  }

  reset(): void {
    this.db.exec('DELETE FROM payment_order_signatures');
    this.db.exec('DELETE FROM payment_status_events');
    this.db.exec('DELETE FROM payment_transactions');
    this.db.exec('DELETE FROM payment_orders');
    this.db.exec('DELETE FROM hac_events');
    this.db.exec('DELETE FROM deliveries');
    this.db.exec('DELETE FROM order_id_counters');
    this.db.exec('DELETE FROM protocol_log');
    this.db.exec('DELETE FROM activity_log');
    this.db.exec('DELETE FROM nonces');
    this.db.exec('DELETE FROM transactions');
    this.db.exec('DELETE FROM download_data');
    this.db.exec('DELETE FROM bookings');
    this.db.exec('DELETE FROM partner_account_access');
    this.db.exec('DELETE FROM accounts');
    this.db.exec('DELETE FROM persons');
    this.db.exec('DELETE FROM bank_config');
    this.db.exec('DELETE FROM uploaded_orders');
    this.db.exec('DELETE FROM subscribers');
    this.db.exec('DELETE FROM host_config');
  }

  // Banking methods

  getBankConfig(): BankConfig | undefined {
    const row = this.db.prepare('SELECT * FROM bank_config WHERE id = 1').get() as Record<string, string> | undefined;
    if (!row) return undefined;
    return { blz: row['blz'], name: row['name'], bic: row['bic'] };
  }

  setBankConfig(config: BankConfig): void {
    this.db.prepare('INSERT OR REPLACE INTO bank_config (id, blz, name, bic) VALUES (1, ?, ?, ?)').run(config.blz, config.name, config.bic);
  }

  createPerson(data: Omit<Person, 'id' | 'createdAt'>): Person {
    const result = this.db.prepare(`
      INSERT INTO persons (external_id, name, address_line1, address_line2, country)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      data.externalId ?? null, data.name,
      data.addressLine1 ?? null, data.addressLine2 ?? null,
      data.country,
    );
    return this.getPerson(Number(result.lastInsertRowid))!;
  }

  getPerson(id: number): Person | undefined {
    const row = this.db.prepare('SELECT * FROM persons WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
    if (!row) return undefined;
    return this.rowToPerson(row);
  }

  getPersonByExternalId(externalId: string): Person | undefined {
    const row = this.db.prepare('SELECT * FROM persons WHERE external_id = ?').get(externalId) as Record<string, string | number | null> | undefined;
    if (!row) return undefined;
    return this.rowToPerson(row);
  }

  listPersons(): Person[] {
    const rows = this.db.prepare('SELECT * FROM persons ORDER BY id').all() as Record<string, string | number | null>[];
    return rows.map((r) => this.rowToPerson(r));
  }

  updatePerson(id: number, patch: Partial<Omit<Person, 'id' | 'createdAt'>>): Person | undefined {
    const cols: Record<string, string> = {
      externalId: 'external_id', name: 'name',
      addressLine1: 'address_line1', addressLine2: 'address_line2', country: 'country',
    };
    const sets: string[] = [];
    const params: (string | null)[] = [];
    for (const [key, col] of Object.entries(cols)) {
      if (key in patch) {
        sets.push(`${col} = ?`);
        params.push((patch as Record<string, string | undefined>)[key] ?? null);
      }
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE persons SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return this.getPerson(id);
  }

  deletePerson(id: number): void {
    this.db.transaction(() => {
      const accountIds = this.db.prepare('SELECT id FROM accounts WHERE person_id = ?').all(id) as { id: number }[];
      for (const { id: accountId } of accountIds) this.deleteAccount(accountId);
      this.db.prepare('DELETE FROM persons WHERE id = ?').run(id);
    })();
  }

  createAccount(data: Omit<Account, 'id' | 'currentBalanceCents' | 'createdAt'>): Account {
    const result = this.db.prepare(`
      INSERT INTO accounts (person_id, iban, account_number, currency, name)
      VALUES (?, ?, ?, ?, ?)
    `).run(data.personId, data.iban, data.accountNumber, data.currency, data.name);
    return this.getAccount(Number(result.lastInsertRowid))!;
  }

  getAccount(id: number): Account | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
    if (!row) return undefined;
    return this.rowToAccount(row);
  }

  getAccountByIban(iban: string): Account | undefined {
    const row = this.db.prepare('SELECT * FROM accounts WHERE iban = ?').get(iban) as Record<string, string | number | null> | undefined;
    if (!row) return undefined;
    return this.rowToAccount(row);
  }

  listAccounts(): Account[] {
    const rows = this.db.prepare('SELECT * FROM accounts ORDER BY id').all() as Record<string, string | number | null>[];
    return rows.map((r) => this.rowToAccount(r));
  }

  updateAccount(id: number, patch: { name?: string; currency?: string }): Account | undefined {
    const sets: string[] = [];
    const params: string[] = [];
    if (patch.name !== undefined) { sets.push('name = ?'); params.push(patch.name); }
    if (patch.currency !== undefined) { sets.push('currency = ?'); params.push(patch.currency); }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE accounts SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
    return this.getAccount(id);
  }

  deleteAccount(id: number): void {
    this.db.transaction(() => {
      // bookings have ON DELETE RESTRICT; partner_account_access cascades automatically
      this.db.prepare('DELETE FROM bookings WHERE account_id = ?').run(id);
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id);
    })();
  }

  listAccountsForPerson(personId: number): Account[] {
    const rows = this.db.prepare('SELECT * FROM accounts WHERE person_id = ? ORDER BY id').all(personId) as Record<string, string | number | null>[];
    return rows.map((r) => this.rowToAccount(r));
  }

  listAccountsForPartner(partnerId: string): Account[] {
    const rows = this.db.prepare(`
      SELECT a.* FROM accounts a
      JOIN partner_account_access paa ON a.id = paa.account_id
      WHERE paa.partner_id = ?
      ORDER BY a.id
    `).all(partnerId) as Record<string, string | number | null>[];
    return rows.map((r) => this.rowToAccount(r));
  }

  partnerHasAccountAccess(partnerId: string, accountId: number): boolean {
    const row = this.db.prepare(
      'SELECT 1 FROM partner_account_access WHERE partner_id = ? AND account_id = ? LIMIT 1',
    ).get(partnerId, accountId);
    return row !== undefined;
  }

  grantAccountAccess(partnerId: string, accountId: number): void {
    this.db.prepare('INSERT OR IGNORE INTO partner_account_access (partner_id, account_id) VALUES (?, ?)').run(partnerId, accountId);
  }

  revokeAccountAccess(partnerId: string, accountId: number): void {
    this.db.prepare('DELETE FROM partner_account_access WHERE partner_id = ? AND account_id = ?').run(partnerId, accountId);
  }

  createBooking(data: Omit<Booking, 'id' | 'createdAt'>): Booking {
    const booking = this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO bookings (account_id, amount_cents, currency, value_date, booking_date,
          counterparty_name, counterparty_iban, counterparty_bic,
          remittance_info, end_to_end_id, transaction_code, source_pain_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        data.accountId, data.amountCents, data.currency,
        data.valueDate, data.bookingDate,
        data.counterpartyName ?? null, data.counterpartyIban ?? null, data.counterpartyBic ?? null,
        data.remittanceInfo ?? null, data.endToEndId ?? null,
        data.transactionCode, data.sourcePainId ?? null,
      );

      this.db.prepare('UPDATE accounts SET current_balance_cents = current_balance_cents + ? WHERE id = ?')
        .run(data.amountCents, data.accountId);

      return this.getBooking(Number(result.lastInsertRowid))!;
    })();
    this.events.emit('booking', booking);
    return booking;
  }

  deleteBooking(id: number): void {
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT account_id, amount_cents FROM bookings WHERE id = ?')
        .get(id) as { account_id: number; amount_cents: number } | undefined;
      if (!row) return;
      // Stored balance is maintained incrementally, so reverse this booking's contribution.
      this.db.prepare('UPDATE accounts SET current_balance_cents = current_balance_cents - ? WHERE id = ?')
        .run(row.amount_cents, row.account_id);
      this.db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
    })();
  }

  listBookingsForAccount(accountId: number, fromDate?: string, toDate?: string): Booking[] {
    let sql = 'SELECT * FROM bookings WHERE account_id = ?';
    const params: (string | number)[] = [accountId];

    if (fromDate) {
      sql += ' AND value_date >= ?';
      params.push(fromDate);
    }
    if (toDate) {
      sql += ' AND value_date <= ?';
      params.push(toDate);
    }

    sql += ' ORDER BY value_date, id';
    const rows = this.db.prepare(sql).all(...params) as Record<string, string | number | null>[];
    return rows.map((r) => this.rowToBooking(r));
  }

  getOpeningBalanceCents(accountId: number, beforeDate: string): number {
    const row = this.db.prepare(
      'SELECT COALESCE(SUM(amount_cents), 0) as total FROM bookings WHERE account_id = ? AND value_date < ?',
    ).get(accountId, beforeDate) as { total: number };
    return row.total;
  }

  getNextAccountSequence(): number {
    const row = this.db.prepare(
      "SELECT COALESCE(MAX(CAST(account_number AS INTEGER)), 0) + 1 AS next FROM accounts",
    ).get() as { next: number };
    return row.next;
  }

  private getBooking(id: number): Booking | undefined {
    const row = this.db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as Record<string, string | number | null> | undefined;
    if (!row) return undefined;
    return this.rowToBooking(row);
  }

  private rowToTransaction(row: Record<string, string | number | null>): Transaction {
    return {
      transactionId: row['transaction_id'] as string,
      partnerId: row['partner_id'] as string,
      userId: row['user_id'] as string,
      hostId: row['host_id'] as string,
      direction: (row['direction'] as 'upload' | 'download') ?? 'download',
      phase: row['phase'] as TransactionPhase,
      orderType: row['order_type'] as string,
      numSegments: row['num_segments'] as number,
      currentSegment: row['current_segment'] as number,
      segments: JSON.parse(row['segments'] as string),
      transactionKey: row['transaction_key'] as string,
      encKeyDigest: row['enc_key_digest'] as string,
      signatureData: (row['signature_data'] as string) ?? undefined,
      serviceName: (row['service_name'] as string) ?? undefined,
      msgName: (row['msg_name'] as string) ?? undefined,
      orderId: (row['order_id'] as string) ?? undefined,
      serviceOption: (row['service_option'] as string) ?? undefined,
      requestEds: row['request_eds'] === 1,
      deliveryKind: (row['delivery_kind'] as DeliveryKind) ?? undefined,
      deliveryKeys: row['delivery_keys'] ? JSON.parse(row['delivery_keys'] as string) : undefined,
      createdAt: row['created_at'] as string,
      expiresAt: row['expires_at'] as string,
    };
  }

  private rowToPerson(row: Record<string, string | number | null>): Person {
    return {
      id: row['id'] as number,
      externalId: (row['external_id'] as string) ?? undefined,
      name: row['name'] as string,
      addressLine1: (row['address_line1'] as string) ?? undefined,
      addressLine2: (row['address_line2'] as string) ?? undefined,
      country: row['country'] as string,
      createdAt: row['created_at'] as string,
    };
  }

  private rowToAccount(row: Record<string, string | number | null>): Account {
    return {
      id: row['id'] as number,
      personId: row['person_id'] as number,
      iban: row['iban'] as string,
      accountNumber: row['account_number'] as string,
      currency: row['currency'] as string,
      name: row['name'] as string,
      currentBalanceCents: row['current_balance_cents'] as number,
      createdAt: row['created_at'] as string,
    };
  }

  private rowToBooking(row: Record<string, string | number | null>): Booking {
    return {
      id: row['id'] as number,
      accountId: row['account_id'] as number,
      amountCents: row['amount_cents'] as number,
      currency: row['currency'] as string,
      valueDate: row['value_date'] as string,
      bookingDate: row['booking_date'] as string,
      counterpartyName: (row['counterparty_name'] as string) ?? undefined,
      counterpartyIban: (row['counterparty_iban'] as string) ?? undefined,
      counterpartyBic: (row['counterparty_bic'] as string) ?? undefined,
      remittanceInfo: (row['remittance_info'] as string) ?? undefined,
      endToEndId: (row['end_to_end_id'] as string) ?? undefined,
      transactionCode: row['transaction_code'] as string,
      sourcePainId: (row['source_pain_id'] as number) ?? undefined,
      createdAt: row['created_at'] as string,
    };
  }

  // Order IDs

  nextOrderId(partnerId: string): string {
    return this.db.transaction(() => {
      this.db.prepare('INSERT INTO order_id_counters (partner_id, next) VALUES (?, 0) ON CONFLICT(partner_id) DO NOTHING').run(partnerId);
      const row = this.db.prepare('SELECT next FROM order_id_counters WHERE partner_id = ?').get(partnerId) as { next: number };
      this.db.prepare('UPDATE order_id_counters SET next = next + 1 WHERE partner_id = ?').run(partnerId);
      return formatOrderId(row.next);
    })();
  }

  // HAC event ledger

  appendHacEvent(event: NewHacEvent): HacEvent {
    const appended = this.db.transaction(() => {
      // Strictly increasing per partner: clients use the TimeStamp attribute as idempotency key
      const last = this.db.prepare('SELECT MAX(event_at) AS last FROM hac_events WHERE partner_id = ?').get(event.partnerId) as { last: string | null };
      let eventAt = event.eventAt ?? new Date().toISOString();
      if (last.last && eventAt <= last.last) {
        eventAt = new Date(new Date(last.last).getTime() + 1).toISOString();
      }
      const result = this.db.prepare(`
        INSERT INTO hac_events (partner_id, user_id, order_id, action, admin_order_type, service_name, service_option, scope,
          container_type, msg_name, order_id_ref, admin_order_type_ref, reason_code, additional_info, event_at, uploaded_order_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.partnerId, event.userId ?? null, event.orderId, event.action, event.adminOrderType,
        event.serviceName ?? null, event.serviceOption ?? null, event.scope ?? null, event.containerType ?? null,
        event.msgName ?? null, event.orderIdRef ?? null, event.adminOrderTypeRef ?? null, event.reasonCode ?? null,
        JSON.stringify(event.additionalInfo ?? []), eventAt, event.uploadedOrderId ?? null,
      );
      return this.getHacEvent(Number(result.lastInsertRowid))!;
    })();
    this.events.emit('hacEvent', appended);
    return appended;
  }

  getHacEvent(id: number): HacEvent | undefined {
    const row = this.db.prepare('SELECT * FROM hac_events WHERE id = ?').get(id) as Row | undefined;
    return row ? this.rowToHacEvent(row) : undefined;
  }

  listHacEvents(filter: { partnerId?: string; orderId?: string } & DateFilter = {}): HacEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.partnerId) { where.push('partner_id = ?'); params.push(filter.partnerId); }
    if (filter.orderId) { where.push('(order_id = ? OR order_id_ref = ?)'); params.push(filter.orderId, filter.orderId); }
    if (filter.from) { where.push('substr(event_at, 1, 10) >= ?'); params.push(filter.from); }
    if (filter.to) { where.push('substr(event_at, 1, 10) <= ?'); params.push(filter.to); }
    const sql = `SELECT * FROM hac_events${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY event_at, id`;
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => this.rowToHacEvent(r));
  }

  private rowToHacEvent(row: Row): HacEvent {
    return {
      id: row['id'] as number,
      partnerId: row['partner_id'] as string,
      userId: (row['user_id'] as string) ?? undefined,
      orderId: row['order_id'] as string,
      action: row['action'] as string,
      adminOrderType: row['admin_order_type'] as string,
      serviceName: (row['service_name'] as string) ?? undefined,
      serviceOption: (row['service_option'] as string) ?? undefined,
      scope: (row['scope'] as string) ?? undefined,
      containerType: (row['container_type'] as string) ?? undefined,
      msgName: (row['msg_name'] as string) ?? undefined,
      orderIdRef: (row['order_id_ref'] as string) ?? undefined,
      adminOrderTypeRef: (row['admin_order_type_ref'] as string) ?? undefined,
      reasonCode: (row['reason_code'] as string) ?? undefined,
      additionalInfo: JSON.parse((row['additional_info'] as string) ?? '[]'),
      eventAt: row['event_at'] as string,
      uploadedOrderId: (row['uploaded_order_id'] as number) ?? undefined,
    };
  }

  // Credit transfer orders

  createPaymentOrder(order: NewPaymentOrder, transactions: NewPaymentTransaction[]): PaymentOrder {
    const created = this.db.transaction(() => {
      const result = this.db.prepare(`
        INSERT INTO payment_orders (order_id, uploaded_order_id, partner_id, user_id, service_name, service_option, msg_name,
          msg_id, pmt_inf_id, debtor_name, debtor_iban, requested_eds, signatures_required, vop_confirmation_required, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        order.orderId, order.uploadedOrderId ?? null, order.partnerId, order.userId, order.serviceName,
        order.serviceOption ?? null, order.msgName, order.msgId, order.pmtInfId, order.debtorName ?? null,
        order.debtorIban ?? null, order.requestedEds ? 1 : 0, order.signaturesRequired ?? 1, order.vopConfirmationRequired ? 1 : 0, order.status,
      );
      const id = Number(result.lastInsertRowid);
      const insertTx = this.db.prepare(`
        INSERT INTO payment_transactions (payment_order_id, end_to_end_id, creditor_name, creditor_iban, creditor_bic,
          amount_cents, currency, remittance_info, vop_status, vop_corrected_name, debit_booking_id, credit_booking_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const tx of transactions) {
        insertTx.run(
          id, tx.endToEndId ?? null, tx.creditorName ?? null, tx.creditorIban ?? null, tx.creditorBic ?? null,
          tx.amountCents, tx.currency, tx.remittanceInfo ?? null, tx.vopStatus, tx.vopCorrectedName ?? null,
          tx.debitBookingId ?? null, tx.creditBookingId ?? null,
        );
      }
      return this.getPaymentOrder(id)!;
    })();
    this.events.emit('paymentOrder', created);
    return created;
  }

  getPaymentOrder(id: number): PaymentOrder | undefined {
    const row = this.db.prepare('SELECT * FROM payment_orders WHERE id = ?').get(id) as Row | undefined;
    return row ? this.rowToPaymentOrder(row) : undefined;
  }

  listPaymentOrders(filter: { partnerId?: string; status?: PaymentOrderStatus; orderId?: string; msgId?: string } = {}): PaymentOrder[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.partnerId) { where.push('partner_id = ?'); params.push(filter.partnerId); }
    if (filter.status) { where.push('status = ?'); params.push(filter.status); }
    if (filter.orderId) { where.push('order_id = ?'); params.push(filter.orderId); }
    if (filter.msgId) { where.push('msg_id = ?'); params.push(filter.msgId); }
    const sql = `SELECT * FROM payment_orders${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC`;
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => this.rowToPaymentOrder(r));
  }

  updatePaymentOrderStatus(id: number, status: PaymentOrderStatus): void {
    this.db.prepare(`UPDATE payment_orders SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?`).run(status, id);
  }

  listPaymentTransactions(paymentOrderId: number): PaymentTransaction[] {
    const rows = this.db.prepare('SELECT * FROM payment_transactions WHERE payment_order_id = ? ORDER BY id').all(paymentOrderId) as Row[];
    return rows.map((r) => this.rowToPaymentTransaction(r));
  }

  getPaymentTransaction(id: number): PaymentTransaction | undefined {
    const row = this.db.prepare('SELECT * FROM payment_transactions WHERE id = ?').get(id) as Row | undefined;
    return row ? this.rowToPaymentTransaction(row) : undefined;
  }

  updatePaymentTransaction(
    id: number,
    patch: Partial<Pick<PaymentTransaction, 'vopStatus' | 'vopCorrectedName' | 'debitBookingId' | 'creditBookingId'>>,
  ): void {
    const columns: Record<string, string> = {
      vopStatus: 'vop_status',
      vopCorrectedName: 'vop_corrected_name',
      debitBookingId: 'debit_booking_id',
      creditBookingId: 'credit_booking_id',
    };
    const sets: string[] = [];
    const values: (string | number | null)[] = [];
    for (const [key, column] of Object.entries(columns)) {
      if (key in patch) {
        sets.push(`${column} = ?`);
        values.push((patch as Record<string, string | number | undefined>)[key] ?? null);
      }
    }
    if (sets.length === 0) return;
    this.db.prepare(`UPDATE payment_transactions SET ${sets.join(', ')} WHERE id = ?`).run(...values, id);
  }

  appendPaymentStatusEvent(event: {
    paymentOrderId: number;
    status: PaymentStatusCode;
    reasonCode?: string;
    additionalInfo?: string[];
  }): PaymentStatusEvent {
    const result = this.db.prepare(`
      INSERT INTO payment_status_events (payment_order_id, status, reason_code, additional_info) VALUES (?, ?, ?, ?)
    `).run(event.paymentOrderId, event.status, event.reasonCode ?? null, JSON.stringify(event.additionalInfo ?? []));
    const row = this.db.prepare('SELECT * FROM payment_status_events WHERE id = ?').get(Number(result.lastInsertRowid)) as Row;
    const appended = this.rowToPaymentStatusEvent(row);
    this.events.emit('paymentStatus', appended);
    return appended;
  }

  // VEU signatures

  addOrderSignature(signature: { partnerId: string; orderId: string; userId: string; kind: OrderSignatureKind }): OrderSignature {
    const result = this.db.prepare(`
      INSERT INTO payment_order_signatures (partner_id, order_id, user_id, kind) VALUES (?, ?, ?, ?)
    `).run(signature.partnerId, signature.orderId, signature.userId, signature.kind);
    const row = this.db.prepare('SELECT * FROM payment_order_signatures WHERE id = ?').get(Number(result.lastInsertRowid)) as Row;
    return this.rowToOrderSignature(row);
  }

  listOrderSignatures(partnerId: string, orderId: string): OrderSignature[] {
    const rows = this.db.prepare('SELECT * FROM payment_order_signatures WHERE partner_id = ? AND order_id = ? ORDER BY id').all(partnerId, orderId) as Row[];
    return rows.map((r) => this.rowToOrderSignature(r));
  }

  private rowToOrderSignature(row: Row): OrderSignature {
    return {
      id: row['id'] as number,
      partnerId: row['partner_id'] as string,
      orderId: row['order_id'] as string,
      userId: row['user_id'] as string,
      kind: row['kind'] as OrderSignatureKind,
      signedAt: row['signed_at'] as string,
    };
  }

  listPaymentStatusEvents(filter: { paymentOrderId?: number; partnerId?: string } & DateFilter = {}): PaymentStatusEvent[] {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.paymentOrderId !== undefined) { where.push('e.payment_order_id = ?'); params.push(filter.paymentOrderId); }
    if (filter.partnerId) { where.push('o.partner_id = ?'); params.push(filter.partnerId); }
    if (filter.from) { where.push('substr(e.created_at, 1, 10) >= ?'); params.push(filter.from); }
    if (filter.to) { where.push('substr(e.created_at, 1, 10) <= ?'); params.push(filter.to); }
    const sql = `SELECT e.* FROM payment_status_events e JOIN payment_orders o ON o.id = e.payment_order_id${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY e.id`;
    return (this.db.prepare(sql).all(...params) as Row[]).map((r) => this.rowToPaymentStatusEvent(r));
  }

  private rowToPaymentOrder(row: Row): PaymentOrder {
    return {
      id: row['id'] as number,
      orderId: row['order_id'] as string,
      uploadedOrderId: (row['uploaded_order_id'] as number) ?? undefined,
      partnerId: row['partner_id'] as string,
      userId: row['user_id'] as string,
      serviceName: row['service_name'] as string,
      serviceOption: (row['service_option'] as string) ?? undefined,
      msgName: row['msg_name'] as string,
      msgId: row['msg_id'] as string,
      pmtInfId: row['pmt_inf_id'] as string,
      debtorName: (row['debtor_name'] as string) ?? undefined,
      debtorIban: (row['debtor_iban'] as string) ?? undefined,
      requestedEds: row['requested_eds'] === 1,
      signaturesRequired: row['signatures_required'] as number,
      vopConfirmationRequired: row['vop_confirmation_required'] === 1,
      status: row['status'] as PaymentOrderStatus,
      createdAt: row['created_at'] as string,
      updatedAt: row['updated_at'] as string,
    };
  }

  private rowToPaymentTransaction(row: Row): PaymentTransaction {
    return {
      id: row['id'] as number,
      paymentOrderId: row['payment_order_id'] as number,
      endToEndId: (row['end_to_end_id'] as string) ?? undefined,
      creditorName: (row['creditor_name'] as string) ?? undefined,
      creditorIban: (row['creditor_iban'] as string) ?? undefined,
      creditorBic: (row['creditor_bic'] as string) ?? undefined,
      amountCents: row['amount_cents'] as number,
      currency: row['currency'] as string,
      remittanceInfo: (row['remittance_info'] as string) ?? undefined,
      vopStatus: row['vop_status'] as VopStatus,
      vopCorrectedName: (row['vop_corrected_name'] as string) ?? undefined,
      debitBookingId: (row['debit_booking_id'] as number) ?? undefined,
      creditBookingId: (row['credit_booking_id'] as number) ?? undefined,
    };
  }

  private rowToPaymentStatusEvent(row: Row): PaymentStatusEvent {
    return {
      id: row['id'] as number,
      paymentOrderId: row['payment_order_id'] as number,
      status: row['status'] as PaymentStatusCode,
      reasonCode: (row['reason_code'] as string) ?? undefined,
      additionalInfo: JSON.parse((row['additional_info'] as string) ?? '[]'),
      createdAt: row['created_at'] as string,
    };
  }

  // Download deliveries

  markDelivered(partnerId: string, kind: DeliveryKind, itemKeys: string[]): void {
    const insert = this.db.prepare('INSERT OR IGNORE INTO deliveries (partner_id, kind, item_key) VALUES (?, ?, ?)');
    this.db.transaction(() => {
      for (const key of itemKeys) insert.run(partnerId, kind, key);
    })();
  }

  listDeliveredKeys(partnerId: string, kind: DeliveryKind): Set<string> {
    const rows = this.db.prepare('SELECT item_key FROM deliveries WHERE partner_id = ? AND kind = ?').all(partnerId, kind) as { item_key: string }[];
    return new Set(rows.map((r) => r.item_key));
  }

  resetDeliveries(filter: { partnerId?: string; kind?: DeliveryKind } = {}): number {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.partnerId) { where.push('partner_id = ?'); params.push(filter.partnerId); }
    if (filter.kind) { where.push('kind = ?'); params.push(filter.kind); }
    return this.db.prepare(`DELETE FROM deliveries${where.length ? ` WHERE ${where.join(' AND ')}` : ''}`).run(...params).changes;
  }

  private rowToSubscriber(row: Record<string, string | null>): Subscriber {
    return {
      partnerId: row['partner_id']!,
      userId: row['user_id']!,
      state: row['state'] as SubscriberState,
      keys: {
        signatureVersion: row['signature_version'] ?? undefined,
        signatureCertificate: row['signature_certificate'] ?? undefined,
        authenticationVersion: row['authentication_version'] ?? undefined,
        authenticationCertificate: row['authentication_certificate'] ?? undefined,
        encryptionVersion: row['encryption_version'] ?? undefined,
        encryptionCertificate: row['encryption_certificate'] ?? undefined,
      },
      createdAt: row['created_at']!,
      updatedAt: row['updated_at']!,
    };
  }
}

type Row = Record<string, string | number | null>;

/** OrderIDType is [A-Z][A-Z0-9]{3}: A000…A999, B000…, wrapping after Z999 */
export function formatOrderId(sequence: number): string {
  const letter = String.fromCharCode(65 + (Math.floor(sequence / 1000) % 26));
  return `${letter}${String(sequence % 1000).padStart(3, '0')}`;
}
