import { describe, it, expect, beforeEach } from 'vitest';
import { handleHpd } from '../../src/handlers/hpd.js';
import { handleHtd } from '../../src/handlers/htd.js';
import { handleHkd } from '../../src/handlers/hkd.js';
import { handleHaa } from '../../src/handlers/haa.js';
import { handleHac } from '../../src/handlers/hac.js';
import { handleBtd } from '../../src/handlers/btd.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import { SubscriberState } from '../../src/store/types.js';
import type { HandlerContext } from '../../src/handlers/handler-types.js';
import type { Subscriber, HostConfig } from '../../src/store/types.js';
import { parseXml } from '../../src/protocol/xml-parser.js';

function makeCtx(xml: string = '<root/>'): HandlerContext {
  return { rawXml: xml, doc: parseXml(xml), hostId: 'TESTHOST' };
}

const testSubscriber: Subscriber = {
  partnerId: 'PARTNER1',
  userId: 'USER1',
  state: SubscriberState.READY,
  keys: {},
  createdAt: '2026-01-01',
  updatedAt: '2026-01-01',
};

const testHostConfig: HostConfig = {
  hostId: 'TESTHOST',
  bankKeys: {
    authenticationPrivateKey: 'auth-pk',
    authenticationCertificate: 'auth-cert',
    authenticationVersion: 'X002',
    encryptionPrivateKey: 'enc-pk',
    encryptionCertificate: 'enc-cert',
    encryptionVersion: 'E002',
  },
};

describe('Download Handlers', () => {
  let store: SqliteStore;

  beforeEach(() => {
    store = new SqliteStore(':memory:');
  });

  describe('HPD', () => {
    it('should return HPDResponseOrderData XML', () => {
      const xml = handleHpd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('HPDResponseOrderData');
    });

    it('should include access params with host ID', () => {
      const xml = handleHpd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('AccessParams');
      expect(xml).toContain('TESTHOST');
    });

    it('should include protocol version H005', () => {
      const xml = handleHpd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('ProtocolParams');
      expect(xml).toContain('H005');
    });

    it('should include supported algorithms', () => {
      const xml = handleHpd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('X002');
      expect(xml).toContain('E002');
      expect(xml).toContain('A006');
    });

    it('should produce valid XML', () => {
      const xml = handleHpd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(() => parseXml(xml)).not.toThrow();
    });
  });

  describe('HTD', () => {
    it('should return HTDResponseOrderData XML', () => {
      const xml = handleHtd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('HTDResponseOrderData');
    });

    it('should include subscriber user ID', () => {
      const xml = handleHtd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('USER1');
    });

    it('should list supported order types', () => {
      const xml = handleHtd(makeCtx(), testSubscriber, testHostConfig, store);
      for (const ot of ['HPD', 'HTD', 'HKD', 'HAA', 'HAC', 'BTD']) {
        expect(xml).toContain(ot);
      }
    });

    it('should include host ID in bank info', () => {
      const xml = handleHtd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('TESTHOST');
    });

    it('should produce valid XML', () => {
      const xml = handleHtd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(() => parseXml(xml)).not.toThrow();
    });

    it('should report the partner ID as the address name', () => {
      const xml = handleHtd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('PARTNER1');
    });

    it('should derive UserID status from subscriber state', () => {
      const xml = handleHtd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toMatch(/<UserID[^>]*Status="1"/);

      const newSub = { ...testSubscriber, state: SubscriberState.NEW };
      const newXml = handleHtd(makeCtx(), newSub, testHostConfig, store);
      expect(newXml).toMatch(/<UserID[^>]*Status="0"/);
    });

    it('should include a BTF Service for the BTD order type', () => {
      const xml = handleHtd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('Service');
      expect(xml).toContain('ServiceName');
      expect(xml).toContain('camt.053');
    });

    it('should include AccountInfo for accounts the partner can access', () => {
      const person = store.createPerson({ name: 'Acct Holder', country: 'DE' });
      const account = store.createAccount({
        personId: person.id,
        iban: 'DE89370400440532013000',
        accountNumber: '532013000',
        currency: 'EUR',
        name: 'Main Account',
      });
      store.grantAccountAccess(testSubscriber.partnerId, account.id);

      const xml = handleHtd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('AccountInfo');
      expect(xml).toContain('DE89370400440532013000');
      expect(xml).toContain('international="true"');
      expect(xml).toContain('Main Account');
    });
  });

  describe('HKD', () => {
    it('should return HKDResponseOrderData XML', () => {
      const xml = handleHkd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('HKDResponseOrderData');
    });

    it('should list all subscribers for same partner', () => {
      store.createSubscriber('PARTNER1', 'USER1');
      store.createSubscriber('PARTNER1', 'USER2');
      store.createSubscriber('PARTNER2', 'USER3');

      const xml = handleHkd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('USER1');
      expect(xml).toContain('USER2');
      expect(xml).not.toContain('USER3');
    });

    it('should include order types', () => {
      const xml = handleHkd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('BTD');
      expect(xml).toContain('HPD');
    });

    it('should produce valid XML', () => {
      const xml = handleHkd(makeCtx(), testSubscriber, testHostConfig, store);
      expect(() => parseXml(xml)).not.toThrow();
    });
  });

  describe('HAA', () => {
    it('should return HAAResponseOrderData XML', () => {
      const xml = handleHaa(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('HAAResponseOrderData');
    });

    it('should list seeded download services', () => {
      store.upsertDownloadData('STA', 'mt940', 'content', 'text');
      store.upsertDownloadData('VMK', 'camt.052', 'content2', 'xml');

      const xml = handleHaa(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('STA');
      expect(xml).toContain('VMK');
      expect(xml).toContain('mt940');
      expect(xml).toContain('camt.052');
    });

    it('should return empty list when no data seeded', () => {
      const xml = handleHaa(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('HAAResponseOrderData');
      expect(xml).not.toContain('ServiceName');
    });

    it('should mark all as BTD order type', () => {
      store.upsertDownloadData('STA', 'mt940', 'c', 'text');
      const xml = handleHaa(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('BTD');
    });

    it('should produce valid XML', () => {
      const xml = handleHaa(makeCtx(), testSubscriber, testHostConfig, store);
      expect(() => parseXml(xml)).not.toThrow();
    });
  });

  describe('HAC', () => {
    it('should return HACResponseOrderData XML', () => {
      const xml = handleHac(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('HACResponseOrderData');
    });

    it('should include logged activity', () => {
      store.logActivity({
        eventType: 'ebics_request',
        partnerId: 'PARTNER1',
        userId: 'USER1',
        orderType: 'HPD',
        resultCode: '000000',
      });

      const xml = handleHac(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('HPD');
      expect(xml).toContain('000000');
    });

    it('should return empty response when no activity', () => {
      const xml = handleHac(makeCtx(), testSubscriber, testHostConfig, store);
      expect(xml).toContain('HACResponseOrderData');
      expect(xml).not.toContain('OrderType');
    });

    it('should produce valid XML', () => {
      const xml = handleHac(makeCtx(), testSubscriber, testHostConfig, store);
      expect(() => parseXml(xml)).not.toThrow();
    });
  });

  describe('BTD', () => {
    it('should return content for known service', () => {
      store.upsertDownloadData('STA', 'mt940', 'MT940 statement data', 'text');

      const xml = `<?xml version="1.0"?><ebicsRequest xmlns="urn:org:ebics:H005"><header authenticate="true"><static/><mutable/></header><body><BTDOrderParams><Service><ServiceName>STA</ServiceName><MsgName>mt940</MsgName></Service></BTDOrderParams></body></ebicsRequest>`;
      const ctx = makeCtx(xml);

      const result = handleBtd(ctx, testSubscriber, testHostConfig, store);
      expect(result).toBe('MT940 statement data');
    });

    it('should return null for unknown service', () => {
      const xml = `<?xml version="1.0"?><ebicsRequest xmlns="urn:org:ebics:H005"><header authenticate="true"><static/><mutable/></header><body><BTDOrderParams><Service><ServiceName>ZZZ</ServiceName><MsgName>zzz</MsgName></Service></BTDOrderParams></body></ebicsRequest>`;
      const ctx = makeCtx(xml);

      const result = handleBtd(ctx, testSubscriber, testHostConfig, store);
      expect(result).toBeNull();
    });

    it('should return null when no service name in request', () => {
      const xml = `<?xml version="1.0"?><ebicsRequest xmlns="urn:org:ebics:H005"><header authenticate="true"><static/><mutable/></header><body/></ebicsRequest>`;
      const ctx = makeCtx(xml);

      const result = handleBtd(ctx, testSubscriber, testHostConfig, store);
      expect(result).toBeNull();
    });

    it('should match service name and msg name', () => {
      store.upsertDownloadData('STA', 'mt940', 'mt940 data', 'text');
      store.upsertDownloadData('STA', 'camt.053', 'camt data', 'xml');

      const xml = `<?xml version="1.0"?><ebicsRequest xmlns="urn:org:ebics:H005"><header authenticate="true"><static/><mutable/></header><body><BTDOrderParams><Service><ServiceName>STA</ServiceName><MsgName>camt.053</MsgName></Service></BTDOrderParams></body></ebicsRequest>`;
      const ctx = makeCtx(xml);

      const result = handleBtd(ctx, testSubscriber, testHostConfig, store);
      expect(result).toBe('camt data');
    });
  });
});
