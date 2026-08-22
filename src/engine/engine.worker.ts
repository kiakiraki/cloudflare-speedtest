import type { DirectionSummary, FromMainMessage, ToMainMessage } from './protocol';

const HOSTS: Record<'auto' | 'h3', string> = {
  auto: 'https://speed.cloudflare.com',
  h3: 'https://h3.speed.cloudflare.com',
};

let baseUrl = HOSTS.auto;

const PING_COUNT = 20;
const PROBE_BYTES = 25_000_000;
const PROBE_CAP_MS = 5000;
const DOWNLOAD_STREAMS = 16;
const UPLOAD_STREAMS = 8;
const STAGGER_MS = 250;
const MIN_DL_PAYLOAD = 1_000_000;
const MAX_DL_PAYLOAD = 250_000_000;
const UPLOAD_SIZES = [8_000_000, 32_000_000, 64_000_000] as const;
const BASE_UPLOAD_BYTES = 8_000_000;
const TARGET_STREAM_SEC = 2.5;
const RAMP_EXCLUDE_MS = 1000;
const PEAK_WINDOW_MS = 2000;
const SAMPLE_INTERVAL_MS = 100;
const DATA_LIMIT_BYTES = 20_000_000_000;

interface EngineScope {
  postMessage(message: ToMainMessage): void;
  onmessage: ((this: EngineScope, ev: MessageEvent<FromMainMessage>) => void) | null;
}

const scope = self as unknown as EngineScope;

try {
  performance.setResourceTimingBufferSize(50000);
} catch {}

interface SamplePoint {
  tMs: number;
  totalBytes: number;
}

let reqSeq = 0;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function summarize(points: SamplePoint[]): DirectionSummary {
  const n = points.length;
  if (n < 2) return { peakMbps: 0, sustainedMbps: 0 };
  const last = points[n - 1];
  let sustained = 0;
  for (const p of points) {
    if (p.tMs >= RAMP_EXCLUDE_MS) {
      const spanMs = last.tMs - p.tMs;
      if (spanMs > 0) {
        sustained = (8 * (last.totalBytes - p.totalBytes)) / (spanMs / 1000) / 1e6;
      }
      break;
    }
  }
  if (!(sustained > 0)) {
    sustained = (8 * last.totalBytes) / (last.tMs / 1000) / 1e6;
  }
  let peak = 0;
  let lo = 0;
  for (let hi = 1; hi < n; hi++) {
    const boundary = points[hi].tMs - PEAK_WINDOW_MS;
    while (lo + 1 < n && points[lo + 1].tMs <= boundary) lo++;
    const spanMs = points[hi].tMs - points[lo].tMs;
    if (spanMs < PEAK_WINDOW_MS - SAMPLE_INTERVAL_MS * 1.5) continue;
    const mbps = (8 * (points[hi].totalBytes - points[lo].totalBytes)) / (spanMs / 1000) / 1e6;
    if (mbps > peak) peak = mbps;
  }
  return { peakMbps: peak, sustainedMbps: sustained };
}

function startSampling(
  phase: 'download' | 'upload',
  start: number,
  getTotal: () => number,
  points: SamplePoint[]
): number {
  points.push({ tMs: 0, totalBytes: getTotal() });
  return setInterval(() => {
    const tMs = performance.now() - start;
    points.push({ tMs, totalBytes: getTotal() });
    const m = points.length;
    if (m >= 2) {
      const prev = points[m - 2];
      const curr = points[m - 1];
      const dtMs = curr.tMs - prev.tMs;
      const dBytes = curr.totalBytes - prev.totalBytes;
      const instantMbps = dtMs > 0 ? (8 * dBytes) / (dtMs / 1000) / 1e6 : 0;
      scope.postMessage({ type: 'sample', phase, tMs, instantMbps });
    }
  }, SAMPLE_INTERVAL_MS);
}

async function postMeta(): Promise<void> {
  const res = await fetch(`${baseUrl}/meta`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`meta HTTP ${res.status}`);
  const meta = (await res.json()) as { clientIp?: string; asOrganization?: string; colo?: string | { iata?: string; city?: string } };
  const rawColo = meta.colo;
  const colo =
    typeof rawColo === 'string'
      ? rawColo
      : rawColo?.iata
        ? rawColo.city
          ? `${rawColo.iata} (${rawColo.city})`
          : rawColo.iata
        : null;
  scope.postMessage({
    type: 'meta',
    ip: meta.clientIp ?? null,
    colo,
    isp: meta.asOrganization ?? null,
  });
}

function latestHopProtocol(): string | null {
  const entries = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if ((e.name.includes('__down') || e.name.includes('__up')) && e.nextHopProtocol) {
      return e.nextHopProtocol;
    }
  }
  return null;
}

interface CfL4Timings {
  rttMs: number | null;
  minRttMs: number | null;
}

function parseCfL4(serverTiming: string | null): CfL4Timings {
  const m = serverTiming?.match(/cfL4[^"]*"([^"]*)"/);
  if (!m) return { rttMs: null, minRttMs: null };
  const params = new URLSearchParams(m[1]);
  const rttUs = Number(params.get('rtt'));
  const minRttUs = Number(params.get('min_rtt'));
  return {
    rttMs: Number.isFinite(rttUs) && rttUs > 0 ? rttUs / 1000 : null,
    minRttMs: Number.isFinite(minRttUs) && minRttUs > 0 ? minRttUs / 1000 : null,
  };
}

async function measureLatency(): Promise<{ latencyMs: number; jitterMs: number }> {
  const txTotal: number[] = [];
  const netRtts: number[] = [];
  for (let i = 0; i < PING_COUNT; i++) {
    const url = `${baseUrl}/__down?bytes=0&n=${reqSeq++}`;
    const t0 = performance.now();
    const res = await fetch(url, { cache: 'no-store' });
    await res.arrayBuffer();
    txTotal.push(performance.now() - t0);
    const l4 = parseCfL4(res.headers.get('server-timing'));
    if (l4.rttMs !== null) netRtts.push(l4.rttMs);
  }
  if (netRtts.length >= PING_COUNT / 2) {
    let latency = Infinity;
    for (const r of netRtts) {
      if (r < latency) latency = r;
    }
    let diffSum = 0;
    for (let i = 1; i < netRtts.length; i++) {
      diffSum += Math.abs(netRtts[i] - netRtts[i - 1]);
    }
    return { latencyMs: latency, jitterMs: diffSum / (netRtts.length - 1) };
  }
  let latency = Infinity;
  for (const rtt of txTotal) {
    if (rtt < latency) latency = rtt;
  }
  let diffSum = 0;
  for (let i = 1; i < txTotal.length; i++) {
    diffSum += Math.abs(txTotal[i] - txTotal[i - 1]);
  }
  return { latencyMs: latency, jitterMs: diffSum / (txTotal.length - 1) };
}

async function calibrateDownloadPayload(): Promise<number> {
  const ctrl = new AbortController();
  let total = 0;
  const start = performance.now();
  const killer = setTimeout(() => ctrl.abort(), PROBE_CAP_MS);
  const one = async (): Promise<void> => {
    try {
      const res = await fetch(`${baseUrl}/__down?bytes=${PROBE_BYTES}&n=${reqSeq++}`, {
        cache: 'no-store',
        signal: ctrl.signal,
      });
      if (!res.ok || !res.body) throw new Error(`probe HTTP ${res.status}`);
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
      }
    } catch {
      return;
    }
  };
  await Promise.all(Array.from({ length: DOWNLOAD_STREAMS }, () => one()));
  clearTimeout(killer);
  const elapsedSec = Math.max((performance.now() - start) / 1000, 0.05);
  const aggregateBps = (8 * total) / elapsedSec;
  const perStreamBytesPerSec = aggregateBps / DOWNLOAD_STREAMS / 8;
  const wanted = perStreamBytesPerSec * TARGET_STREAM_SEC;
  return Math.min(MAX_DL_PAYLOAD, Math.max(MIN_DL_PAYLOAD, Math.floor(wanted)));
}

async function measureDownload(durationSec: number): Promise<DirectionSummary> {
  const payloadBytes = await calibrateDownloadPayload();
  const durationMs = durationSec * 1000;
  const ctrl = new AbortController();
  let total = 0;
  const points: SamplePoint[] = [];
  const start = performance.now();
  const sampler = startSampling('download', start, () => total, points);
  const killer = setTimeout(() => ctrl.abort(), durationMs);

  const runStream = async (): Promise<void> => {
    while (!ctrl.signal.aborted && performance.now() - start < durationMs) {
      try {
        const res = await fetch(`${baseUrl}/__down?bytes=${payloadBytes}&n=${reqSeq++}`, {
          cache: 'no-store',
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`down HTTP ${res.status}`);
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.length;
          if (total >= DATA_LIMIT_BYTES) {
            ctrl.abort();
            break;
          }
        }
      } catch {
        if (ctrl.signal.aborted) return;
        await sleep(200);
      }
    }
  };

  const streams: Promise<void>[] = [];
  for (let i = 0; i < DOWNLOAD_STREAMS; i++) {
    streams.push(sleep(i * STAGGER_MS).then(runStream));
  }
  await Promise.all(streams);

  clearTimeout(killer);
  clearInterval(sampler);
  points.push({ tMs: performance.now() - start, totalBytes: total });
  return summarize(points);
}

function randomFill(buf: Uint8Array<ArrayBuffer>): void {
  const quantum = 65_536;
  for (let off = 0; off < buf.length; off += quantum) {
    crypto.getRandomValues(buf.subarray(off, Math.min(off + quantum, buf.length)));
  }
}

let baseUploadChunk: Uint8Array<ArrayBuffer> | null = null;

function randomChunk(size: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(size);
  randomFill(buf);
  return buf;
}

function getBaseChunk(): Uint8Array<ArrayBuffer> {
  return baseUploadChunk ?? (baseUploadChunk = randomChunk(BASE_UPLOAD_BYTES));
}

const uploadPayloads = new Map<number, Uint8Array<ArrayBuffer>>();

function getUploadPayload(size: number): Uint8Array<ArrayBuffer> {
  let payload = uploadPayloads.get(size);
  if (!payload) {
    const base = getBaseChunk();
    payload = new Uint8Array(size);
    for (let off = 0; off < size; off += base.length) {
      payload.set(base.subarray(0, Math.min(base.length, size - off)), off);
    }
    uploadPayloads.set(size, payload);
  }
  return payload;
}

function sendUpload(
  payload: Uint8Array<ArrayBuffer>,
  ctrl: AbortController,
  active: Set<XMLHttpRequest>,
  onDelta: (delta: number) => void
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    let last = 0;
    const onAbort = (): void => xhr.abort();
    const settle = (err: Error | null): void => {
      if (settled) return;
      settled = true;
      active.delete(xhr);
      ctrl.signal.removeEventListener('abort', onAbort);
      if (err && !ctrl.signal.aborted) reject(err);
      else resolve();
    };
    xhr.open('POST', `${baseUrl}/__up?n=${reqSeq++}`, true);
    xhr.upload.onprogress = (ev: ProgressEvent): void => {
      if (ev.loaded > last) {
        onDelta(ev.loaded - last);
        last = ev.loaded;
      }
    };
    xhr.onload = (): void => {
      if (xhr.status >= 200 && xhr.status < 300) settle(null);
      else settle(new Error(`up HTTP ${xhr.status}`));
    };
    xhr.onloadend = (ev: ProgressEvent): void => {
      if (ev.loaded > last) {
        onDelta(ev.loaded - last);
        last = ev.loaded;
      }
      settle(null);
    };
    xhr.onerror = (): void => settle(new Error('upload network error'));
    xhr.onabort = (): void => settle(null);
    active.add(xhr);
    xhr.send(payload);
    ctrl.signal.addEventListener('abort', onAbort, { once: true });
  });
}

async function chooseUploadSize(): Promise<number> {
  const ctrl = new AbortController();
  const active = new Set<XMLHttpRequest>();
  let total = 0;
  const payload = getUploadPayload(UPLOAD_SIZES[0]);
  const start = performance.now();
  const killer = setTimeout(() => ctrl.abort(), PROBE_CAP_MS);
  const streams: Promise<void>[] = [];
  for (let i = 0; i < UPLOAD_STREAMS; i++) {
    streams.push(
      sendUpload(payload, ctrl, active, (d) => {
        total += d;
      }).catch(() => undefined)
    );
  }
  await Promise.all(streams);
  clearTimeout(killer);
  const elapsedSec = Math.max((performance.now() - start) / 1000, 0.05);
  const aggregateBps = (8 * total) / elapsedSec;
  const perStreamBytesPerSec = aggregateBps / UPLOAD_STREAMS / 8;
  const needed = perStreamBytesPerSec * TARGET_STREAM_SEC;
  for (const size of UPLOAD_SIZES) {
    if (size >= needed) return size;
  }
  return UPLOAD_SIZES[UPLOAD_SIZES.length - 1];
}

async function measureUpload(durationSec: number): Promise<DirectionSummary> {
  const sizeBytes = await chooseUploadSize();
  const payload = getUploadPayload(sizeBytes);
  const durationMs = durationSec * 1000;
  const ctrl = new AbortController();
  const active = new Set<XMLHttpRequest>();
  let total = 0;
  const points: SamplePoint[] = [];
  const start = performance.now();
  const sampler = startSampling('upload', start, () => total, points);
  const killer = setTimeout(() => ctrl.abort(), durationMs);
  ctrl.signal.addEventListener(
    'abort',
    () => {
      for (const xhr of active) xhr.abort();
    },
    { once: true }
  );

  const runStream = async (): Promise<void> => {
    while (!ctrl.signal.aborted && performance.now() - start < durationMs) {
      try {
        await sendUpload(payload, ctrl, active, (d) => {
          total += d;
          if (total >= DATA_LIMIT_BYTES) ctrl.abort();
        });
      } catch {
        if (ctrl.signal.aborted) return;
        await sleep(200);
      }
    }
  };

  const streams: Promise<void>[] = [];
  for (let i = 0; i < UPLOAD_STREAMS; i++) {
    streams.push(sleep(i * STAGGER_MS).then(runStream));
  }
  await Promise.all(streams);

  clearTimeout(killer);
  clearInterval(sampler);
  points.push({ tMs: performance.now() - start, totalBytes: total });
  return summarize(points);
}

const PACKET_COUNT = 100;
const PACKET_BATCH = 10;
const BATCH_WAIT_MS = 10;
const LOSS_RESPONSES_WAIT_MS = 5000;
const LOSS_CONNECT_TIMEOUT_MS = 8000;

interface TurnIceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

function isUdpCandidate(c: RTCIceCandidate): boolean {
  let proto = c.protocol ?? '';
  if (!proto && c.candidate) {
    const parts = c.candidate.split(' ');
    if (parts.length >= 3) proto = parts[2];
  }
  return proto.toLowerCase() === 'udp';
}

async function measurePacketLoss(): Promise<number | null> {
  let iceServers: TurnIceServer[];
  try {
    const res = await fetch('/api/turn-credentials', { method: 'POST', cache: 'no-store' });
    if (!res.ok) return null;
    iceServers = (await res.json()) as TurnIceServer[];
    if (!Array.isArray(iceServers) || iceServers.length === 0) return null;
  } catch {
    return null;
  }

  return new Promise<number | null>((resolve) => {
    const config: RTCConfiguration = { iceServers, iceTransportPolicy: 'relay' };
    const sender = new RTCPeerConnection(config);
    const receiver = new RTCPeerConnection(config);
    const senderDc = sender.createDataChannel('pl', { ordered: false, maxRetransmits: 0 });

    let received = 0;
    let settled = false;
    let opened = false;
    let senderReady = false;
    let receiverReady = false;
    const pendingForReceiver: RTCIceCandidate[] = [];
    const pendingForSender: RTCIceCandidate[] = [];

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(killer);
      try {
        sender.close();
        receiver.close();
        senderDc.close();
      } catch {}
      resolve(opened ? Math.max(0, Math.min(1, (PACKET_COUNT - received) / PACKET_COUNT)) : null);
    };

    const killer = setTimeout(
      finish,
      LOSS_CONNECT_TIMEOUT_MS + (PACKET_COUNT / PACKET_BATCH) * BATCH_WAIT_MS + LOSS_RESPONSES_WAIT_MS + 2000
    );

    const drainPending = (): void => {
      while (receiverReady && pendingForReceiver.length > 0) {
        receiver.addIceCandidate(pendingForReceiver.shift()!).catch(() => {});
      }
      while (senderReady && pendingForSender.length > 0) {
        sender.addIceCandidate(pendingForSender.shift()!).catch(() => {});
      }
    };

    receiver.ondatachannel = (e) => {
      e.channel.onmessage = () => received++;
    };
    sender.onicecandidate = (e) => {
      if (!e.candidate || !isUdpCandidate(e.candidate)) return;
      if (receiverReady) receiver.addIceCandidate(e.candidate).catch(() => {});
      else pendingForReceiver.push(e.candidate);
    };
    receiver.onicecandidate = (e) => {
      if (!e.candidate || !isUdpCandidate(e.candidate)) return;
      if (senderReady) sender.addIceCandidate(e.candidate).catch(() => {});
      else pendingForSender.push(e.candidate);
    };
    sender.oniceconnectionstatechange = (): void => {
      if (sender.iceConnectionState === 'failed') finish();
    };

    senderDc.onopen = async () => {
      opened = true;
      for (let i = 0; i < PACKET_COUNT; i++) {
        if (settled) return;
        senderDc.send(String(i));
        if ((i + 1) % PACKET_BATCH === 0) await sleep(BATCH_WAIT_MS);
      }
      setTimeout(finish, LOSS_RESPONSES_WAIT_MS);
    };

    sender
      .createOffer()
      .then((o) => sender.setLocalDescription(o))
      .then(() => receiver.setRemoteDescription(sender.localDescription!))
      .then(() => {
        receiverReady = true;
        drainPending();
        return receiver.createAnswer();
      })
      .then((a) => receiver.setLocalDescription(a))
      .then(() => sender.setRemoteDescription(receiver.localDescription!))
      .then(() => {
        senderReady = true;
        drainPending();
      })
      .catch(() => {
        if (!settled) {
          settled = true;
          clearTimeout(killer);
          try {
            sender.close();
            receiver.close();
          } catch {}
          resolve(null);
        }
      });
  });
}

async function run(durationSec: number): Promise<void> {
  try {
    await postMeta().catch(() => undefined);
    scope.postMessage({ type: 'phase', phase: 'latency' });
    const { latencyMs, jitterMs } = await measureLatency();
    scope.postMessage({ type: 'protocol', hopProtocol: latestHopProtocol() });
    scope.postMessage({ type: 'phase', phase: 'loss' });
    const packetLossPercent = await measurePacketLoss().catch(() => null);
    scope.postMessage({ type: 'phase', phase: 'download' });
    const download = await measureDownload(durationSec);
    scope.postMessage({ type: 'phase', phase: 'upload' });
    const upload = await measureUpload(durationSec);
    scope.postMessage({ type: 'phase', phase: 'done' });
    scope.postMessage({ type: 'result', download, upload, latencyMs, jitterMs, packetLossPercent });
  } catch (err) {
    scope.postMessage({
      type: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

scope.onmessage = (ev: MessageEvent<FromMainMessage>): void => {
  const msg = ev.data;
  if (msg && msg.type === 'start') {
    baseUrl = HOSTS[msg.host ?? 'auto'] ?? HOSTS.auto;
    void run(msg.durationSec);
  }
};
