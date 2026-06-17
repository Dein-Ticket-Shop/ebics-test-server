import { describe, it, expect, beforeEach } from 'vitest';
import { dispatch, type DispatcherConfig } from '../../src/protocol/dispatcher.js';
import { parseXml } from '../../src/protocol/xml-parser.js';
import { SqliteStore } from '../../src/store/sqlite-store.js';
import { generateBankKeys } from '../../src/bank/bank-keys.js';

describe('dispatcher', () => {
  let config: DispatcherConfig;

  beforeEach(() => {
    const store = new SqliteStore(':memory:');
    store.setHostConfig({ hostId: 'TEST', bankKeys: generateBankKeys('TEST') });
    config = { hostId: 'TEST', store };
  });

  function makeCtx(xml: string) {
    return { rawXml: xml, doc: parseXml(xml), hostId: '' };
  }

  it('should route HEV request', async () => {
    const xml = `<?xml version="1.0"?><ebicsHEVRequest xmlns="http://www.ebics.org/H000"><HostID>TEST</HostID></ebicsHEVRequest>`;
    const result = await dispatch(makeCtx(xml), config);
    expect(result.responseXml).toContain('ebicsHEVResponse');
    expect(result.responseXml).toContain('000000');
  });

  it('should route INI request', async () => {
    config.store.createSubscriber('P1', 'U1');
    const xml = `<?xml version="1.0"?><ebicsUnsecuredRequest xmlns="urn:org:ebics:H005" Version="H005" Revision="1"><header authenticate="true"><static><HostID>TEST</HostID><PartnerID>P1</PartnerID><UserID>U1</UserID><OrderDetails><AdminOrderType>INI</AdminOrderType></OrderDetails><SecurityMedium>0000</SecurityMedium></static><mutable/></header><body><DataTransfer><OrderData>eJwBAAD//wMAAAA=</OrderData></DataTransfer></body></ebicsUnsecuredRequest>`;
    const result = await dispatch(makeCtx(xml), config);
    // Will fail on order data parse but proves routing works
    expect(result.responseXml).toContain('ebicsKeyManagementResponse');
  });

  it('should return EBICS_UNSUPPORTED_ORDER_TYPE for unknown unsecured order', async () => {
    const xml = `<?xml version="1.0"?><ebicsUnsecuredRequest xmlns="urn:org:ebics:H005" Version="H005" Revision="1"><header authenticate="true"><static><HostID>TEST</HostID><PartnerID>P1</PartnerID><UserID>U1</UserID><OrderDetails><AdminOrderType>XYZ</AdminOrderType></OrderDetails><SecurityMedium>0000</SecurityMedium></static><mutable/></header><body><DataTransfer><OrderData>eQ==</OrderData></DataTransfer></body></ebicsUnsecuredRequest>`;
    const result = await dispatch(makeCtx(xml), config);
    expect(result.responseXml).toContain('091006');
  });

  it('should return EBICS_INVALID_REQUEST for unknown root element', async () => {
    const xml = `<?xml version="1.0"?><unknownElement xmlns="urn:org:ebics:H005"/>`;
    const result = await dispatch(makeCtx(xml), config);
    expect(result.responseXml).toContain('061002');
  });
});
