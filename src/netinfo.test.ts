import { describe, expect, it } from 'vitest';
import {
  IPV4_ECHO_URL,
  IPV6_ECHO_URL,
  classifyIp,
  estimateConnection,
  probeFamilies,
} from './netinfo';

describe('classifyIp', () => {
  it('classifies strict dotted-quad addresses as IPv4', () => {
    expect(classifyIp('203.0.113.10')).toBe(4);
    expect(classifyIp('0.0.0.0')).toBe(4);
  });

  it('rejects out-of-range octets', () => {
    expect(classifyIp('999.1.1.1')).toBeNull();
    expect(classifyIp('256.1.1.1')).toBeNull();
  });

  it('returns null for empty and missing input', () => {
    expect(classifyIp('')).toBeNull();
    expect(classifyIp(null)).toBeNull();
    expect(classifyIp(undefined)).toBeNull();
  });

  it('classifies IPv6 addresses', () => {
    expect(classifyIp('2001:db8::1')).toBe(6);
    expect(classifyIp('2400:cb00:2049:1::a29f:1804')).toBe(6);
  });

  it('classifies IPv4-mapped IPv6 addresses as IPv6', () => {
    expect(classifyIp('::ffff:203.0.113.10')).toBe(6);
  });
});

describe('estimateConnection', () => {
  it('reports IPv6 with high confidence regardless of probe', () => {
    const withoutProbe = estimateConnection({ ipVersion: 6 }, null);
    expect(withoutProbe).toEqual({
      label: 'ipv6',
      confidence: 'high',
      summaryJa: 'IPv6 経由で接続しています(IPoE 系の可能性が高いです)',
    });
    const withProbe = estimateConnection(
      { ipVersion: 6 },
      { ipv4: true, ipv6: true },
    );
    expect(withProbe.label).toBe('ipv6');
    expect(withProbe.confidence).toBe('high');
  });

  it('reports dual stack when IPv4 is active and the IPv6 probe succeeds', () => {
    expect(
      estimateConnection({ ipVersion: 4 }, { ipv4: true, ipv6: true }),
    ).toEqual({
      label: 'dual_stack',
      confidence: 'medium',
      summaryJa:
        'IPv4 で接続中。IPv6 も利用可能です(IPoE 系の可能性があります)',
    });
  });

  it('reports IPv4-only with medium confidence when the IPv6 probe fails', () => {
    expect(
      estimateConnection({ ipVersion: 4 }, { ipv4: true, ipv6: false }),
    ).toEqual({
      label: 'ipv4_only',
      confidence: 'medium',
      summaryJa: 'IPv4 のみで接続しています(PPPoE の可能性があります)',
    });
  });

  it('reports IPv4-only with low confidence when no probe is available', () => {
    const result = estimateConnection({ ipVersion: 4 }, null);
    expect(result.label).toBe('ipv4_only');
    expect(result.confidence).toBe('low');
  });

  it('falls back to unknown for unresolved IP versions', () => {
    const withoutProbe = estimateConnection({ ipVersion: null }, null);
    expect(withoutProbe.label).toBe('unknown');
    expect(withoutProbe.confidence).toBe('low');
    expect(withoutProbe.summaryJa).toBe('接続経路を判定できませんでした');

    const withProbe = estimateConnection(
      { ipVersion: null },
      { ipv4: true, ipv6: true },
    );
    expect(withProbe.label).toBe('unknown');
    expect(withProbe.confidence).toBe('low');
  });
});

describe('probeFamilies', () => {
  it('marks families whose echo address classifies correctly', async () => {
    const requestedUrls: string[] = [];
    const probe = await probeFamilies(async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      return new Response(
        url === IPV4_ECHO_URL ? '203.0.113.10' : '2001:db8::1',
        { status: 200 },
      );
    });
    expect(requestedUrls.sort()).toEqual([IPV4_ECHO_URL, IPV6_ECHO_URL].sort());
    expect(probe.ipv4).toBe(true);
    expect(probe.ipv6).toBe(true);
  });

  it('marks a family false when the body is another family', async () => {
    const probe = await probeFamilies(
      async () => new Response('203.0.113.10', { status: 200 }),
    );
    expect(probe.ipv4).toBe(true);
    expect(probe.ipv6).toBe(false);
  });

  it('marks a family false on non-ok responses', async () => {
    const probe = await probeFamilies(
      async () => new Response('203.0.113.10', { status: 503 }),
    );
    expect(probe.ipv4).toBe(false);
    expect(probe.ipv6).toBe(false);
  });

  it('marks both families false when requests reject', async () => {
    const probe = await probeFamilies(async () => {
      throw new Error('offline');
    });
    expect(probe.ipv4).toBe(false);
    expect(probe.ipv6).toBe(false);
  });
});
