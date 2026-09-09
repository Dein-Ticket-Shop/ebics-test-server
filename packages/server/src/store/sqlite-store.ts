import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { EbicsStore, Subscriber, SubscriberKeys, HostConfig, BankKeys, ActivityLogEntry, ProtocolLogEntry, Transaction, TransactionPhase, DownloadData, BankingStore, BankConfig, Person, Account, Booking, AppStore, UploadedOrder } from './types.js';
import { SubscriberState } from './types.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

export class SqliteStore implements AppStore {
  private db: Database.Database;

  constructor(dbPath: string = ':memory:') {
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    const schema = readFileSync(resolve(__dirname, 'schema.sql'), 'utf8');
    this.db.exec(schema);
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
      INSERT INTO transactions (transaction_id, partner_id, user_id, host_id, direction, phase, order_type, num_segments, current_segment, segments, transaction_key, enc_key_digest, signature_data, service_name, msg_name, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      tx.transactionId, tx.partnerId, tx.userId, tx.hostId,
      tx.direction, tx.phase, tx.orderType, tx.numSegments, tx.currentSegment,
      JSON.stringify(tx.segments), tx.transactionKey, tx.encKeyDigest,
      tx.signatureData ?? null, tx.serviceName ?? null, tx.msgName ?? null,
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

  upsertDownloadData(serviceName: string, msgName: string | undefined, content: string, contentType: string): void {
    this.db.prepare(`
      INSERT INTO download_data (service_name, msg_name, content, content_type)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(service_name, msg_name) DO UPDATE SET content = excluded.content, content_type = excluded.content_type
    `).run(serviceName, msgName ?? null, content, contentType);
  }

  getDownloadData(serviceName: string, msgName?: string): DownloadData | undefined {
    const row = msgName
      ? this.db.prepare('SELECT * FROM download_data WHERE service_name = ? AND msg_name = ?').get(serviceName, msgName)
      : this.db.prepare('SELECT * FROM download_data WHERE service_name = ? AND msg_name IS NULL').get(serviceName);
    if (!row) return undefined;
    const r = row as Record<string, string | number | null>;
    return {
      id: r['id'] as number,
      serviceName: r['service_name'] as string,
      msgName: (r['msg_name'] as string) ?? undefined,
      content: r['content'] as string,
      contentType: r['content_type'] as string,
      createdAt: r['created_at'] as string,
    };
  }

  listDownloadData(): DownloadData[] {
    const rows = this.db.prepare('SELECT * FROM download_data ORDER BY id').all() as Record<string, string | number | null>[];
    return rows.map((r) => ({
      id: r['id'] as number,
      serviceName: r['service_name'] as string,
      msgName: (r['msg_name'] as string) ?? undefined,
      content: r['content'] as string,
      contentType: r['content_type'] as string,
      createdAt: r['created_at'] as string,
    }));
  }

  createUploadedOrder(data: Omit<UploadedOrder, 'id' | 'processed' | 'createdAt'>): UploadedOrder {
    const result = this.db.prepare(`
      INSERT INTO uploaded_orders (partner_id, user_id, service_name, msg_name, raw_content)
      VALUES (?, ?, ?, ?, ?)
    `).run(data.partnerId, data.userId, data.serviceName, data.msgName ?? null, data.rawContent);
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
      createdAt: row['created_at'] as string,
    };
  }

  reset(): void {
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
    return this.db.transaction(() => {
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
