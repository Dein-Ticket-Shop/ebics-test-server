import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import { compareNames, verifyPayee } from '../../src/banking/vop.js';
import { calculateIban } from '../../src/banking/iban.js';

describe('Verification of Payee', () => {
  describe('compareNames', () => {
    it('matches identical names ignoring case and whitespace', () => {
      expect(compareNames('Max Mustermann', 'Max Mustermann')).toBe('RCVC');
      expect(compareNames('  max   MUSTERMANN ', 'Max Mustermann')).toBe('RCVC');
    });

    it('treats umlauts, legal forms, token order and small typos as a close match', () => {
      expect(compareNames('Mueller', 'Müller')).toBe('RVMC');
      expect(compareNames('Musterfirma', 'Musterfirma GmbH')).toBe('RVMC');
      expect(compareNames('Mustermann Max', 'Max Mustermann')).toBe('RVMC');
      expect(compareNames('Max Musterman', 'Max Mustermann')).toBe('RVMC');
    });

    it('reports different names as no match', () => {
      expect(compareNames('Erika Musterfrau', 'Max Mustermann')).toBe('RVNM');
      expect(compareNames('!!!', 'Max Mustermann')).toBe('RVNM');
    });
  });

  describe('verifyPayee', () => {
    let store: SqliteStore;
    let heldIban: string;
    const foreignIban = calculateIban('37040044', '0532013000');
    const saved = process.env['EBICS_VOP_DEFAULT'];

    beforeEach(() => {
      store = new SqliteStore(':memory:');
      const bob = store.createPerson({ name: 'Bob Mustermann', country: 'DE' });
      heldIban = calculateIban('10020030', '0000000001');
      store.createAccount({ personId: bob.id, iban: heldIban, accountNumber: '0000000001', currency: 'EUR', name: 'Konto' });
      delete process.env['EBICS_VOP_DEFAULT'];
    });

    afterEach(() => {
      if (saved === undefined) delete process.env['EBICS_VOP_DEFAULT'];
      else process.env['EBICS_VOP_DEFAULT'] = saved;
    });

    it('checks creditors held here against the account owner', () => {
      expect(verifyPayee(store, heldIban, 'Bob Mustermann')).toEqual({ status: 'RCVC' });
      expect(verifyPayee(store, heldIban, 'Mustermann Bob')).toEqual({ status: 'RVMC', correctedName: 'Bob Mustermann' });
      expect(verifyPayee(store, heldIban, 'Alice Wunderland')).toEqual({ status: 'RVNM' });
      expect(verifyPayee(store, heldIban, undefined)).toEqual({ status: 'RVNM' });
    });

    it('normalises the IBAN before looking up the account', () => {
      const spaced = heldIban.toLowerCase().replace(/(.{4})/g, '$1 ');
      expect(verifyPayee(store, spaced, 'Bob Mustermann')).toEqual({ status: 'RCVC' });
    });

    it('is not applicable without a creditor IBAN', () => {
      expect(verifyPayee(store, undefined, 'Bob')).toEqual({ status: 'RVNA' });
    });

    it('uses EBICS_VOP_DEFAULT for creditors at other banks', () => {
      expect(verifyPayee(store, foreignIban, 'Somebody')).toEqual({ status: 'RCVC' });
      process.env['EBICS_VOP_DEFAULT'] = 'RVNM';
      expect(verifyPayee(store, foreignIban, 'Somebody')).toEqual({ status: 'RVNM' });
      process.env['EBICS_VOP_DEFAULT'] = 'RVMC';
      expect(verifyPayee(store, foreignIban, 'Somebody')).toEqual({ status: 'RVMC', correctedName: 'Somebody' });
      process.env['EBICS_VOP_DEFAULT'] = 'nonsense';
      expect(verifyPayee(store, foreignIban, 'Somebody')).toEqual({ status: 'RCVC' });
    });
  });
});
