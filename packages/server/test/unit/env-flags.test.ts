import { describe, it, expect, afterEach } from 'vitest';
import {
  ENV_FLAGS,
  allowPreActivation,
  describeEnvFlags,
  hacDownloadEvents,
  hacFormat,
  strictValidation,
  vopConfirmationRequired,
  vopDefaultStatus,
  wssOneTimeTokens,
} from '../../src/config/feature-flags.js';
import { isStrictValidation } from '../../src/banking/validation.js';
import { createTestApp } from '../helpers/test-server.js';

const ENV_NAMES = Object.values(ENV_FLAGS).map((flag) => flag.env);
const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));

function clearFlags(): void {
  for (const name of ENV_NAMES) delete process.env[name];
}

describe('environment flags', () => {
  afterEach(() => {
    for (const name of ENV_NAMES) {
      if (saved[name] === undefined) delete process.env[name];
      else process.env[name] = saved[name];
    }
  });

  it('describes every flag with label, description and default', () => {
    clearFlags();
    const flags = describeEnvFlags();
    expect(flags.map((f) => f.env)).toEqual(ENV_NAMES);
    expect(new Set(ENV_NAMES).size).toBe(ENV_NAMES.length);
    for (const flag of flags) {
      expect(flag.env).toMatch(/^EBICS_[A-Z_]+$/);
      expect(flag.label.length).toBeGreaterThan(0);
      expect(flag.description.length).toBeGreaterThan(20);
      // backticks mark inline code and must be balanced
      expect(flag.description.split('`').length % 2).toBe(1);
      expect(flag).toMatchObject({ raw: null, ignored: false, value: flag.defaultValue });
    }
    expect(flags.find((f) => f.key === 'hacFormat')).toMatchObject({ type: 'enum', options: ['legacy', 'pain.002'] });
    expect(flags.find((f) => f.key === 'strictValidation')).toMatchObject({ type: 'boolean', defaultValue: true });
    expect(flags.every((f) => f.type === 'boolean' || f.type === 'enum')).toBe(true);
    // protocol downloads are a per-subscriber setting, not an environment flag
    expect(ENV_NAMES).not.toContain('EBICS_HAC_DENY_PARTNERS');
    expect(flags.find((f) => f.key === 'hacDownloadEvents')).not.toHaveProperty('options');
    // VEU holds follow the subscriber's signature class, not an environment flag
    expect(ENV_NAMES).not.toContain('EBICS_EDS_HOLD');
    expect(flags.map((f) => f.key)).not.toContain('edsHold');
  });

  it('keeps the getter defaults', () => {
    clearFlags();
    expect(strictValidation()).toBe(true);
    expect(isStrictValidation()).toBe(true);
    expect(allowPreActivation()).toBe(false);
    expect(hacFormat()).toBe('legacy');
    expect(vopDefaultStatus()).toBe('RCVC');
    expect(vopConfirmationRequired()).toBe(false);
    expect(hacDownloadEvents()).toBe(false);
    expect(wssOneTimeTokens()).toBe(false);
  });

  it('reports set values and matches the getters', () => {
    clearFlags();
    process.env['EBICS_STRICT_VALIDATION'] = '0';
    process.env['EBICS_ALLOW_PREACTIVATION'] = '1';
    process.env['EBICS_HAC_FORMAT'] = 'pain.002';
    process.env['EBICS_HAC_DOWNLOAD_EVENTS'] = 'true';
    process.env['EBICS_VOP_DEFAULT'] = 'RVNM';

    const byKey = Object.fromEntries(describeEnvFlags().map((f) => [f.key, f]));
    expect(byKey['strictValidation']).toMatchObject({ value: false, raw: '0', ignored: false });
    expect(byKey['allowPreActivation']).toMatchObject({ value: true, raw: '1' });
    expect(byKey['hacFormat']).toMatchObject({ value: 'pain.002', raw: 'pain.002' });
    expect(byKey['hacDownloadEvents']).toMatchObject({ value: true, raw: 'true' });
    expect(byKey['vopDefault']).toMatchObject({ value: 'RVNM' });

    expect(strictValidation()).toBe(false);
    expect(isStrictValidation()).toBe(false);
    expect(allowPreActivation()).toBe(true);
    expect(hacFormat()).toBe('pain.002');
    expect(hacDownloadEvents()).toBe(true);
    expect(vopDefaultStatus()).toBe('RVNM');
  });

  it('marks unrecognised values as ignored and applies the default', () => {
    clearFlags();
    process.env['EBICS_HAC_DOWNLOAD_EVENTS'] = 'yes';
    process.env['EBICS_STRICT_VALIDATION'] = 'off';
    process.env['EBICS_VOP_DEFAULT'] = 'NOPE';
    process.env['EBICS_HAC_FORMAT'] = 'legacy';

    const byKey = Object.fromEntries(describeEnvFlags().map((f) => [f.key, f]));
    expect(byKey['hacDownloadEvents']).toMatchObject({ value: false, raw: 'yes', ignored: true });
    expect(byKey['strictValidation']).toMatchObject({ value: true, raw: 'off', ignored: true });
    expect(byKey['vopDefault']).toMatchObject({ value: 'RCVC', raw: 'NOPE', ignored: true });
    expect(byKey['hacFormat']).toMatchObject({ value: 'legacy', raw: 'legacy', ignored: false });
    expect(hacDownloadEvents()).toBe(false);
    expect(strictValidation()).toBe(true);
    expect(vopDefaultStatus()).toBe('RCVC');
  });

  it('serves the descriptions on GET /api/config/env-flags', async () => {
    clearFlags();
    process.env['EBICS_WSS_ONE_TIME_TOKEN'] = 'true';
    const { app } = createTestApp();
    const res = await app.request('/api/config/env-flags');
    expect(res.status).toBe(200);
    const body = (await res.json()) as ReturnType<typeof describeEnvFlags>;
    expect(body).toEqual(describeEnvFlags());
    expect(body.find((f) => f.env === 'EBICS_WSS_ONE_TIME_TOKEN')).toMatchObject({ value: true, raw: 'true' });
  });
});
