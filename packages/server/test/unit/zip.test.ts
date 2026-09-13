import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createZip, readZip, crc32 } from '../../src/protocol/zip.js';

const unzipAvailable = spawnSync('unzip', ['-v']).status === 0;

describe('zip', () => {
  const binary = randomBytes(4096);
  const entries = [
    { name: 'camt.053.xml', content: '<?xml version="1.0"?><Document/>' },
    { name: 'Überweisungen-ä.txt', content: 'Grüße aus München' },
    { name: 'data.bin', content: binary },
  ];

  it('computes the standard CRC-32', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('round-trips multiple entries with UTF-8 names and binary content', () => {
    const zip = createZip(entries);
    const read = readZip(zip);

    expect(read.map((e) => e.name)).toEqual(entries.map((e) => e.name));
    expect(read[0]!.content.toString('utf8')).toBe(entries[0]!.content);
    expect(read[1]!.content.toString('utf8')).toBe('Grüße aus München');
    expect(read[2]!.content.equals(binary)).toBe(true);
  });

  it('writes an empty archive', () => {
    const zip = createZip([]);
    expect(zip.length).toBe(22);
    expect(readZip(zip)).toEqual([]);
  });

  it('rejects data that is not a ZIP', () => {
    expect(() => readZip(Buffer.from('not a zip archive at all, sorry'))).toThrow(/end of central directory/);
  });

  it.skipIf(!unzipAvailable)('is readable by the system unzip tool', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ebics-zip-'));
    try {
      const file = join(dir, 'test.zip');
      writeFileSync(file, createZip(entries));
      const test = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
      expect(test.status).toBe(0);
      const listing = spawnSync('unzip', ['-l', file], { encoding: 'utf8' });
      expect(listing.stdout).toContain('camt.053.xml');
      expect(listing.stdout).toContain('data.bin');
      const content = spawnSync('unzip', ['-p', file, 'camt.053.xml'], { encoding: 'utf8' });
      expect(content.stdout).toBe(entries[0]!.content);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
