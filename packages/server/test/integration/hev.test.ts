import { describe, it, expect } from 'vitest';
import { createApp } from '../../src/server.js';

const HOST_ID = 'TESTHOST';

function makeApp() {
  return createApp({
    hostId: HOST_ID,
    validateRequests: true,
    validateResponses: true,
  });
}

function hevRequest(hostId: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ebicsHEVRequest xmlns="http://www.ebics.org/H000">
  <HostID>${hostId}</HostID>
</ebicsHEVRequest>`;
}

describe('HEV', () => {
  it('should return supported EBICS versions for valid HostID', async () => {
    const app = makeApp();
    const res = await app.request('/ebics', {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: hevRequest(HOST_ID),
    });

    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('000000');
    expect(body).toContain('H005');
    expect(body).toContain('03.00');
    expect(body).toContain('ebicsHEVResponse');
  });

  it('should return EBICS_INVALID_HOST_ID for wrong HostID', async () => {
    const app = makeApp();
    const res = await app.request('/ebics', {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: hevRequest('WRONGHOST'),
    });

    expect(res.status).toBe(200);
    const body = await res.text();

    expect(body).toContain('091011');
    expect(body).not.toContain('H005');
  });

  it('should return 400 for empty body', async () => {
    const app = makeApp();
    const res = await app.request('/ebics', {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: '',
    });

    expect(res.status).toBe(400);
  });

  it('should return EBICS_INVALID_XML for malformed XML', async () => {
    const app = makeApp();
    const res = await app.request('/ebics', {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml' },
      body: '<not valid xml',
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('091010');
  });
});
