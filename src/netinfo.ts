export const IPV4_ECHO_URL = 'https://api.ipify.org';
export const IPV6_ECHO_URL = 'https://api6.ipify.org';

export interface FamilyProbe {
  ipv4: boolean;
  ipv6: boolean;
}

export interface ConnectionEstimate {
  label: 'ipv6' | 'dual_stack' | 'ipv4_only' | 'unknown';
  confidence: 'high' | 'medium' | 'low';
  summaryJa: string;
}

const IPV6_GROUP = /^[0-9a-fA-F]{1,4}$/;
const IPV4_TAIL = /\d{1,3}(?:\.\d{1,3}){3}$/;

function isStrictIpv4(ip: string): boolean {
  const parts = ip.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false;
    if (part.length > 1 && part[0] === '0') return false;
    return Number(part) <= 255;
  });
}

function isPlausibleIpv6(ip: string): boolean {
  const tail = IPV4_TAIL.exec(ip);
  const head = tail ? ip.slice(0, ip.length - tail[0].length - 1) : ip;
  const groups = head.split(':');
  let compressed = false;
  for (let i = 0; i < groups.length; i++) {
    const group = groups[i];
    if (group === '') {
      if (i === 0 || i === groups.length - 1) continue;
      if (compressed) return false;
      compressed = true;
      continue;
    }
    if (!IPV6_GROUP.test(group)) return false;
  }
  return true;
}

export function classifyIp(ip: string | null | undefined): 4 | 6 | null {
  if (!ip) return null;
  if (isStrictIpv4(ip)) return 4;
  if (ip.includes(':') && isPlausibleIpv6(ip)) return 6;
  return null;
}

async function probeFamily(
  url: string,
  family: 4 | 6,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { signal: controller.signal });
    if (!res.ok) return false;
    const body = await res.text();
    return classifyIp(body.trim()) === family;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function probeFamilies(
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3000,
): Promise<FamilyProbe> {
  const [ipv4, ipv6] = await Promise.all([
    probeFamily(IPV4_ECHO_URL, 4, fetchImpl, timeoutMs),
    probeFamily(IPV6_ECHO_URL, 6, fetchImpl, timeoutMs),
  ]);
  return { ipv4, ipv6 };
}

export function estimateConnection(
  info: { ipVersion: 4 | 6 | null },
  probe: FamilyProbe | null,
): ConnectionEstimate {
  if (info.ipVersion === 6) {
    return {
      label: 'ipv6',
      confidence: 'high',
      summaryJa: 'IPv6 経由で接続しています(IPoE 系の可能性が高いです)',
    };
  }
  if (info.ipVersion === 4) {
    if (probe?.ipv6 === true) {
      return {
        label: 'dual_stack',
        confidence: 'medium',
        summaryJa:
          'IPv4 で接続中。IPv6 も利用可能です(IPoE 系の可能性があります)',
      };
    }
    if (probe?.ipv6 === false) {
      return {
        label: 'ipv4_only',
        confidence: 'medium',
        summaryJa: 'IPv4 のみで接続しています(PPPoE の可能性があります)',
      };
    }
    return {
      label: 'ipv4_only',
      confidence: 'low',
      summaryJa:
        'IPv4 のみで接続しているようです(IPv6 の利用可否を判定できませんでした)',
    };
  }
  return {
    label: 'unknown',
    confidence: 'low',
    summaryJa: '接続経路を判定できませんでした',
  };
}
