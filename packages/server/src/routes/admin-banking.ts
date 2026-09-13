import { Hono } from 'hono';
import type { AppStore } from '../store/types.js';
import { calculateIban, validateBic, validateBlz } from '../banking/iban.js';
import { generateCamt053 } from '../banking/generators/camt053.js';
import { generateMt940 } from '../banking/generators/mt940.js';
import { generateCamt052 } from '../banking/generators/camt052.js';
import { generateCamt054 } from '../banking/generators/camt054.js';

export function createBankingAdminRoute(store: AppStore) {
  const app = new Hono();

  // Bank config

  app.get('/bank', (c) => {
    const config = store.getBankConfig();
    if (!config) return c.json({ error: 'Bank not configured' }, 404);
    return c.json(config);
  });

  app.post('/bank', async (c) => {
    const body = await c.req.json<{ blz: string; name: string; bic: string }>();
    if (!validateBlz(body.blz)) {
      return c.json({ error: 'Invalid BLZ: must be 8 digits' }, 400);
    }
    if (!validateBic(body.bic)) {
      return c.json({ error: 'Invalid BIC: must match SWIFT format (8 or 11 chars)' }, 400);
    }
    store.setBankConfig(body);
    return c.json(body);
  });

  // Persons

  app.get('/persons', (c) => {
    return c.json(store.listPersons());
  });

  app.post('/persons', async (c) => {
    const body = await c.req.json<{
      name: string;
      externalId?: string;
      addressLine1?: string;
      addressLine2?: string;
      country?: string;
    }>();
    const person = store.createPerson({
      name: body.name,
      externalId: body.externalId,
      addressLine1: body.addressLine1,
      addressLine2: body.addressLine2,
      country: body.country ?? 'DE',
    });
    return c.json(person, 201);
  });

  app.get('/persons/:id', (c) => {
    const person = store.getPerson(parseInt(c.req.param('id'), 10));
    if (!person) return c.json({ error: 'Not found' }, 404);
    return c.json(person);
  });

  app.patch('/persons/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (!store.getPerson(id)) return c.json({ error: 'Not found' }, 404);
    const body = await c.req.json<{
      name?: string;
      externalId?: string;
      addressLine1?: string;
      addressLine2?: string;
      country?: string;
    }>();
    const person = store.updatePerson(id, body);
    return c.json(person);
  });

  app.delete('/persons/:id', (c) => {
    store.deletePerson(parseInt(c.req.param('id'), 10));
    return c.json({ status: 'deleted' });
  });

  // Accounts

  app.get('/accounts', (c) => {
    return c.json(store.listAccounts());
  });

  app.post('/accounts', async (c) => {
    const body = await c.req.json<{
      personId: number;
      currency?: string;
      name: string;
      /** Optional national account number (up to 10 digits), e.g. to recreate a client's real IBAN */
      accountNumber?: string;
    }>();

    const bankConfig = store.getBankConfig();
    if (!bankConfig) return c.json({ error: 'Bank not configured — call POST /api/banking/bank first' }, 400);

    const person = store.getPerson(body.personId);
    if (!person) return c.json({ error: 'Person not found' }, 404);

    const requested = body.accountNumber?.replace(/\s/g, '');
    if (requested && !/^\d{1,10}$/.test(requested)) {
      return c.json({ error: 'Invalid account number: up to 10 digits' }, 400);
    }
    const accountNumber = (requested || store.getNextAccountSequence().toString()).padStart(10, '0');
    const iban = calculateIban(bankConfig.blz, accountNumber);
    if (store.getAccountByIban(iban)) {
      return c.json({ error: `Account ${iban} already exists` }, 409);
    }

    const account = store.createAccount({
      personId: body.personId,
      iban,
      accountNumber,
      currency: body.currency ?? 'EUR',
      name: body.name,
    });
    return c.json(account, 201);
  });

  app.get('/accounts/:id', (c) => {
    const account = store.getAccount(parseInt(c.req.param('id'), 10));
    if (!account) return c.json({ error: 'Not found' }, 404);
    return c.json(account);
  });

  app.patch('/accounts/:id', async (c) => {
    const id = parseInt(c.req.param('id'), 10);
    if (!store.getAccount(id)) return c.json({ error: 'Not found' }, 404);
    // IBAN and account number are identity / derived — only the display name and currency are editable.
    const body = await c.req.json<{ name?: string; currency?: string }>();
    const account = store.updateAccount(id, { name: body.name, currency: body.currency });
    return c.json(account);
  });

  app.delete('/accounts/:id', (c) => {
    store.deleteAccount(parseInt(c.req.param('id'), 10));
    return c.json({ status: 'deleted' });
  });

  app.get('/persons/:personId/accounts', (c) => {
    return c.json(store.listAccountsForPerson(parseInt(c.req.param('personId'), 10)));
  });

  // Partner access

  app.get('/partners/:partnerId/accounts', (c) => {
    return c.json(store.listAccountsForPartner(c.req.param('partnerId')));
  });

  app.post('/partners/:partnerId/accounts/:accountId', (c) => {
    store.grantAccountAccess(c.req.param('partnerId'), parseInt(c.req.param('accountId'), 10));
    return c.json({ status: 'granted' });
  });

  app.delete('/partners/:partnerId/accounts/:accountId', (c) => {
    store.revokeAccountAccess(c.req.param('partnerId'), parseInt(c.req.param('accountId'), 10));
    return c.json({ status: 'revoked' });
  });

  // Minimum number of bank-technical signatures agreed with the customer, optionally per BTF service (EBICS 3.0.2 chapter 3.5)

  app.get('/partners/:partnerId/minimum-signatures', (c) => {
    return c.json(store.getMinimumSignatureRules(c.req.param('partnerId')));
  });

  /** { minimumSignatures: 1 | 2 | null, serviceName?: "SCI" }: sets the rule of the customer or of one service; null removes it */
  app.put('/partners/:partnerId/minimum-signatures', async (c) => {
    const partnerId = c.req.param('partnerId');
    const body = (await c.req.json().catch(() => ({}))) as { minimumSignatures?: unknown; serviceName?: unknown };
    if (body.minimumSignatures !== 1 && body.minimumSignatures !== 2 && body.minimumSignatures !== null) {
      return c.json({ error: 'minimumSignatures must be 1, 2 or null (removes the rule)' }, 400);
    }
    // ServiceNameStringType: three characters of [A-Z0-9]
    if (body.serviceName !== undefined && (typeof body.serviceName !== 'string' || !/^[A-Z0-9]{3}$/.test(body.serviceName))) {
      return c.json({ error: 'serviceName must be a BTF service name of three characters A-Z or 0-9, e.g. SCI' }, 400);
    }
    store.setMinimumSignatures(partnerId, body.minimumSignatures, body.serviceName);
    return c.json(store.getMinimumSignatureRules(partnerId));
  });

  // Bookings

  app.get('/accounts/:id/bookings', (c) => {
    const accountId = parseInt(c.req.param('id'), 10);
    const from = c.req.query('from');
    const to = c.req.query('to');
    return c.json(store.listBookingsForAccount(accountId, from, to));
  });

  app.post('/accounts/:id/bookings', async (c) => {
    const accountId = parseInt(c.req.param('id'), 10);
    const account = store.getAccount(accountId);
    if (!account) return c.json({ error: 'Account not found' }, 404);

    const body = await c.req.json<{
      amountCents: number;
      valueDate: string;
      bookingDate?: string;
      counterpartyName?: string;
      counterpartyIban?: string;
      counterpartyBic?: string;
      remittanceInfo?: string;
      endToEndId?: string;
      transactionCode?: string;
      currency?: string;
    }>();

    const booking = store.createBooking({
      accountId,
      amountCents: body.amountCents,
      currency: body.currency ?? account.currency,
      valueDate: body.valueDate,
      bookingDate: body.bookingDate ?? body.valueDate,
      counterpartyName: body.counterpartyName,
      counterpartyIban: body.counterpartyIban,
      counterpartyBic: body.counterpartyBic,
      remittanceInfo: body.remittanceInfo,
      endToEndId: body.endToEndId,
      transactionCode: body.transactionCode ?? 'NTRF',
    });
    return c.json(booking, 201);
  });

  app.delete('/accounts/:id/bookings/:bookingId', (c) => {
    store.deleteBooking(parseInt(c.req.param('bookingId'), 10));
    return c.json({ status: 'deleted' });
  });

  // Statement preview

  app.get('/accounts/:id/statement', (c) => {
    const accountId = parseInt(c.req.param('id'), 10);
    const account = store.getAccount(accountId);
    if (!account) return c.json({ error: 'Account not found' }, 404);

    const person = store.getPerson(account.personId);
    if (!person) return c.json({ error: 'Person not found' }, 404);

    const bankConfig = store.getBankConfig();
    if (!bankConfig) return c.json({ error: 'Bank not configured' }, 400);

    const format = c.req.query('format') ?? 'camt.053';
    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 86400_000);
    const fromDate = c.req.query('from') ?? thirtyDaysAgo.toISOString().slice(0, 10);
    const toDate = c.req.query('to') ?? now.toISOString().slice(0, 10);

    const bookings = store.listBookingsForAccount(accountId, fromDate, toDate);
    const openingBalance = store.getOpeningBalanceCents(accountId, fromDate);

    if (format === 'mt940') {
      const content = generateMt940(account, bankConfig, bookings, openingBalance, fromDate, toDate);
      return c.text(content);
    }

    if (format === 'camt.052') {
      const content = generateCamt052([{ account, person, bankConfig, bookings, openingBalanceCents: openingBalance }], fromDate, toDate);
      return c.body(content, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
    }

    if (format === 'camt.054') {
      const content = generateCamt054([{ account, person, bankConfig, bookings }]);
      return c.body(content, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
    }

    const content = generateCamt053(account, person, bankConfig, bookings, openingBalance, fromDate, toDate);
    return c.body(content, 200, { 'Content-Type': 'application/xml; charset=utf-8' });
  });

  // Demo seed

  app.post('/seed/demo', (c) => {
    const bankConfig = { blz: '10020030', name: 'EBICS Test Bank AG', bic: 'ETBADE2AXXX' };
    store.setBankConfig(bankConfig);

    const alice = store.createPerson({ name: 'Alice Mustermann', externalId: 'alice', country: 'DE' });
    const bob = store.createPerson({ name: 'Bob Geschäftsmann', externalId: 'bob', country: 'DE' });

    const aliceAccNum = store.getNextAccountSequence().toString().padStart(10, '0');
    const aliceIban = calculateIban(bankConfig.blz, aliceAccNum);
    const aliceAcc = store.createAccount({
      personId: alice.id, iban: aliceIban, accountNumber: aliceAccNum,
      currency: 'EUR', name: 'Girokonto Alice',
    });

    const bobAccNum = store.getNextAccountSequence().toString().padStart(10, '0');
    const bobIban = calculateIban(bankConfig.blz, bobAccNum);
    const bobAcc = store.createAccount({
      personId: bob.id, iban: bobIban, accountNumber: bobAccNum,
      currency: 'EUR', name: 'Geschäftskonto Bob',
    });

    store.grantAccountAccess('PARTNER1', aliceAcc.id);
    store.grantAccountAccess('PARTNER2', bobAcc.id);

    const today = new Date();
    const d = (daysAgo: number) => {
      const dt = new Date(today.getTime() - daysAgo * 86400_000);
      return dt.toISOString().slice(0, 10);
    };

    const bookings = [
      // Alice's bookings
      store.createBooking({ accountId: aliceAcc.id, amountCents: 500000, currency: 'EUR', valueDate: d(55), bookingDate: d(55), counterpartyName: 'Arbeitgeber GmbH', counterpartyIban: 'DE89370400440532013000', counterpartyBic: 'COBADEFFXXX', remittanceInfo: 'Gehalt November', transactionCode: 'NTRF' }),
      store.createBooking({ accountId: aliceAcc.id, amountCents: -120050, currency: 'EUR', valueDate: d(50), bookingDate: d(50), counterpartyName: 'Hausverwaltung Müller', counterpartyIban: 'DE27100777770209299700', remittanceInfo: 'Miete Dezember', transactionCode: 'NTRF' }),
      store.createBooking({ accountId: aliceAcc.id, amountCents: -3599, currency: 'EUR', valueDate: d(40), bookingDate: d(40), counterpartyName: 'Amazon EU S.a.r.l.', counterpartyIban: 'LU280019400644750000', remittanceInfo: 'Bestellung 302-1234567', transactionCode: 'NTRF' }),
      store.createBooking({ accountId: aliceAcc.id, amountCents: 200000, currency: 'EUR', valueDate: d(30), bookingDate: d(30), counterpartyName: 'Bob Geschäftsmann', counterpartyIban: bobIban, counterpartyBic: bankConfig.bic, remittanceInfo: 'Darlehen', endToEndId: 'E2E-LOAN-001', transactionCode: 'NTRF' }),
      store.createBooking({ accountId: aliceAcc.id, amountCents: -50000, currency: 'EUR', valueDate: d(15), bookingDate: d(15), counterpartyName: 'Sparkasse Sparbuch', counterpartyIban: 'DE44500105175407324931', remittanceInfo: 'Spareinlage', transactionCode: 'NTRF' }),
      // Bob's bookings
      store.createBooking({ accountId: bobAcc.id, amountCents: 1500000, currency: 'EUR', valueDate: d(50), bookingDate: d(50), counterpartyName: 'Kunde AG', counterpartyIban: 'DE89370400440532013000', remittanceInfo: 'Rechnung 2025-001', endToEndId: 'E2E-INV-001', transactionCode: 'NTRF' }),
      store.createBooking({ accountId: bobAcc.id, amountCents: -200000, currency: 'EUR', valueDate: d(30), bookingDate: d(30), counterpartyName: 'Alice Mustermann', counterpartyIban: aliceIban, counterpartyBic: bankConfig.bic, remittanceInfo: 'Darlehen an Alice', endToEndId: 'E2E-LOAN-001', transactionCode: 'NTRF' }),
      store.createBooking({ accountId: bobAcc.id, amountCents: -450000, currency: 'EUR', valueDate: d(20), bookingDate: d(20), counterpartyName: 'Finanzamt Berlin', counterpartyIban: 'DE02120300000000202051', remittanceInfo: 'Umsatzsteuer Q3 2025', transactionCode: 'NTRF' }),
    ];

    return c.json({
      bank: bankConfig,
      persons: [alice, bob],
      accounts: [store.getAccount(aliceAcc.id), store.getAccount(bobAcc.id)],
      bookingCount: bookings.length,
    });
  });

  return app;
}
