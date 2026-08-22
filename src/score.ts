export interface ScoreInput {
  downloadMbps: number;
  uploadMbps: number;
  latencyMs: number;
  jitterMs: number;
  stabilityCvPercent: number | null;
  packetLossPercent: number | null;
}

export interface ScoreResult {
  download: number;
  upload: number;
  latency: number;
  jitter: number;
  stability: number | null;
  packetLoss: number | null;
  total: number;
  grade: string;
}

function logScale(v: number, lo: number, hi: number): number {
  const x = Math.min(Math.max(v, lo), hi);
  return (Math.log10(x / lo) / Math.log10(hi / lo)) * 100;
}

function linearScale(v: number, good: number, bad: number): number {
  const x = Math.min(Math.max(v, good), bad);
  return ((bad - x) / (bad - good)) * 100;
}

export function computeScore(input: ScoreInput): ScoreResult {
  const download = logScale(input.downloadMbps, 1, 10000);
  const upload = logScale(input.uploadMbps, 1, 10000);
  const latency = linearScale(input.latencyMs, 5, 150);
  const jitter = linearScale(input.jitterMs, 1, 40);
  const stability =
    input.stabilityCvPercent === null
      ? null
      : linearScale(input.stabilityCvPercent, 8, 50);
  const packetLoss =
    input.packetLossPercent === null
      ? null
      : linearScale(input.packetLossPercent, 0, 3);

  const parts: { w: number; s: number }[] = [
    { w: 0.35, s: download },
    { w: 0.2, s: upload },
    { w: 0.2, s: latency },
    { w: 0.08, s: jitter },
  ];
  if (stability !== null) parts.push({ w: 0.05, s: stability });
  if (packetLoss !== null) parts.push({ w: 0.12, s: packetLoss });

  const wSum = parts.reduce((acc, p) => acc + p.w, 0);
  const weighted = parts.reduce((acc, p) => acc + p.w * p.s, 0) / wSum;
  const total = Math.round(weighted);
  const grade =
    total >= 90
      ? 'S'
      : total >= 80
        ? 'A'
        : total >= 68
          ? 'B'
          : total >= 55
            ? 'C'
            : total >= 40
              ? 'D'
              : 'E';

  return {
    download,
    upload,
    latency,
    jitter,
    stability,
    packetLoss,
    total,
    grade,
  };
}
