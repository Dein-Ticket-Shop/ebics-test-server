import { describe, it, expect, beforeEach } from 'vitest';
import { createTestApp } from '../helpers/test-server.js';

describe('Admin API: account creation with an explicit account number', () => {
  let app: ReturnType<typeof createTestApp>['app'];

  const post = (path: string, body: unknown) =>
    app.request(`/api/banking${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  beforeEach(async () => {
    ({ app } = createTestApp());
    await post('/bank', { blz: '37040044', name: 'Commerzbank', bic: 'COBADEFFXXX' });
  });

  it('recreates the IBAN from bank code and account number', async () => {
    const person = await (await post('/persons', { name: 'Musterfirma GmbH' })).json();
    const res = await post('/accounts', { personId: person.id, name: 'Verrechnungskonto', accountNumber: '532013000' });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ accountNumber: '0532013000', iban: 'DE89370400440532013000' });
  });

  it('keeps allocating sequential account numbers when none is given', async () => {
    const person = await (await post('/persons', { name: 'Max Mustermann' })).json();
    const account = await (await post('/accounts', { personId: person.id, name: 'Girokonto' })).json();
    expect(account.accountNumber).toBe('0000000001');
  });

  it('rejects invalid and duplicate account numbers', async () => {
    const person = await (await post('/persons', { name: 'Erika Mustermann' })).json();
    expect((await post('/accounts', { personId: person.id, name: 'A', accountNumber: '12AB' })).status).toBe(400);
    expect((await post('/accounts', { personId: person.id, name: 'B', accountNumber: '42' })).status).toBe(201);
    expect((await post('/accounts', { personId: person.id, name: 'C', accountNumber: '0000000042' })).status).toBe(409);
  });
});
