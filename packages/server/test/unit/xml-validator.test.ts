import { describe, it, expect, afterAll } from 'vitest';
import { validateXml, disposeValidators } from '../../src/protocol/xml-validator.js';

afterAll(() => {
  disposeValidators();
});

describe('XSD Validation', () => {
  it('should validate a correct HEV request', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ebicsHEVRequest xmlns="http://www.ebics.org/H000">
  <HostID>TESTHOST</HostID>
</ebicsHEVRequest>`;

    expect(() => validateXml(xml, 'hev')).not.toThrow();
  });

  it('should validate a correct HEV response', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ebicsHEVResponse xmlns="http://www.ebics.org/H000">
  <SystemReturnCode>
    <ReturnCode>000000</ReturnCode>
    <ReportText>[EBICS_OK] OK</ReportText>
  </SystemReturnCode>
  <VersionNumber ProtocolVersion="H005">03.00</VersionNumber>
</ebicsHEVResponse>`;

    expect(() => validateXml(xml, 'hev')).not.toThrow();
  });

  it('should reject HEV request with missing HostID', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ebicsHEVRequest xmlns="http://www.ebics.org/H000">
</ebicsHEVRequest>`;

    expect(() => validateXml(xml, 'hev')).toThrow();
  });

  it('should reject HEV response with invalid return code format', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ebicsHEVResponse xmlns="http://www.ebics.org/H000">
  <SystemReturnCode>
    <ReturnCode>ABC</ReturnCode>
    <ReportText>Bad</ReportText>
  </SystemReturnCode>
</ebicsHEVResponse>`;

    expect(() => validateXml(xml, 'hev')).toThrow();
  });

  it('should reject XML with wrong namespace', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<ebicsHEVRequest xmlns="http://wrong.namespace">
  <HostID>TESTHOST</HostID>
</ebicsHEVRequest>`;

    expect(() => validateXml(xml, 'hev')).toThrow();
  });
});
