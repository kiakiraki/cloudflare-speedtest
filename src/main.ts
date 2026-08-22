import './style.css';
import type { ResultMessage, SampleMessage, ToMainMessage } from './engine/protocol';
import { computeScore } from './score';

function fmtProtocol(hop: string | null): string {
  if (!hop) return '--';
  if (hop === 'h3') return 'HTTP/3';
  if (hop === 'h2') return 'HTTP/2';
  if (hop.startsWith('http/1')) return 'HTTP/1.1';
  return hop.toUpperCase();
}

function must<T extends Element>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing element #${id}`);
  return el as unknown as T;
}

const els = {
  phaseItems: document.querySelectorAll<HTMLLIElement>('#phaseList li'),
  dlNum: must<HTMLSpanElement>('dlNum'),
  dlUnit: must<HTMLSpanElement>('dlUnit'),
  ulNum: must<HTMLSpanElement>('ulNum'),
  ulUnit: must<HTMLSpanElement>('ulUnit'),
  canvas: must<HTMLCanvasElement>('graph'),
  startBtn: must<HTMLButtonElement>('startBtn'),
  statusText: must<HTMLParagraphElement>('statusText'),
  results: must<HTMLElement>('results'),
  dlPeak: must<HTMLSpanElement>('dlPeak'),
  dlSust: must<HTMLSpanElement>('dlSust'),
  ulPeak: must<HTMLSpanElement>('ulPeak'),
  ulSust: must<HTMLSpanElement>('ulSust'),
  latVal: must<HTMLSpanElement>('latVal'),
  jitVal: must<HTMLSpanElement>('jitVal'),
  lossVal: must<HTMLSpanElement>('lossVal'),
  scoreRing: must<SVGCircleElement>('scoreRing'),
  scoreTotal: must<HTMLSpanElement>('scoreTotal'),
  scoreGrade: must<HTMLSpanElement>('scoreGrade'),
  fills: {
    download: must<HTMLDivElement>('fillDownload'),
    upload: must<HTMLDivElement>('fillUpload'),
    latency: must<HTMLDivElement>('fillLatency'),
    jitter: must<HTMLDivElement>('fillJitter'),
    stability: must<HTMLDivElement>('fillStability'),
    packetLoss: must<HTMLDivElement>('fillPacketLoss'),
  },
  vals: {
    download: must<HTMLSpanElement>('valDownload'),
    upload: must<HTMLSpanElement>('valUpload'),
    latency: must<HTMLSpanElement>('valLatency'),
    jitter: must<HTMLSpanElement>('valJitter'),
    stability: must<HTMLSpanElement>('valStability'),
    packetLoss: must<HTMLSpanElement>('valPacketLoss'),
  },
  infoColo: must<HTMLElement>('infoColo'),
  infoIsp: must<HTMLElement>('infoIsp'),
  infoIp: must<HTMLElement>('infoIp'),
  infoProto: must<HTMLElement>('infoProto'),
};

const PHASES = ['idle', 'latency', 'loss', 'download', 'upload', 'done'] as const;
type UiPhase = (typeof PHASES)[number];

const DL_COLOR = '#4f8cff';
const UL_COLOR = '#34d97b';

let running = false;
let currentDurationSec = 12;
let emaDl: number | null = null;
let emaUl: number | null = null;

function niceCeil(v: number): number {
  if (!(v > 0)) return 10;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / exp;
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return nice * exp;
}

function trimNum(v: number): string {
  return v >= 100 ? v.toFixed(0) : v >= 10 ? (Number.isInteger(v) ? v.toFixed(0) : v.toFixed(1)) : v.toFixed(1);
}

type SeriesKey = 'download' | 'upload';

class SpeedChart {
  private ctx: CanvasRenderingContext2D;
  private series: Record<SeriesKey, { t: number; v: number }[]> = {
    download: [],
    upload: [],
  };
  private tipKey: SeriesKey | null = null;
  private tipStartMs = 0;
  private tipDurMs = 0;
  private rafId: number | null = null;
  private dirty = true;
  private reducedMotion = false;

  constructor(
    private canvas: HTMLCanvasElement,
    private durationSec: number
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
    try {
      this.reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {}
    this.draw();
  }

  reset(durationSec: number): void {
    this.durationSec = durationSec;
    this.series.download = [];
    this.series.upload = [];
    this.tipKey = null;
    this.invalidate();
  }

  add(series: SeriesKey, tMs: number, mbps: number): void {
    const pts = this.series[series];
    let prev: { t: number; v: number } | null = null;
    if (pts.length > 0) prev = pts[pts.length - 1];
    pts.push({ t: tMs / 1000, v: mbps });
    if (!this.reducedMotion && prev !== null && pts.length >= 2) {
      const gapMs = Math.max((tMs / 1000 - prev.t) * 1000, 30);
      this.tipKey = series;
      this.tipStartMs = performance.now();
      this.tipDurMs = Math.min(Math.max(gapMs, 60), 180);
    } else {
      this.tipKey = null;
    }
    this.invalidate();
  }

  redraw(): void {
    this.invalidate();
  }

  private invalidate(): void {
    this.dirty = true;
    if (this.rafId !== null) return;
    const tick = (): void => {
      const animating = this.tipKey !== null;
      this.draw();
      this.rafId = animating || this.dirty ? requestAnimationFrame(tick) : null;
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private draw(): void {
    const canvas = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const cssW = canvas.clientWidth;
    const cssH = canvas.clientHeight;
    if (cssW === 0 || cssH === 0) return;
    const w = Math.round(cssW * dpr);
    const h = Math.round(cssH * dpr);
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = this.ctx;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const padL = 58;
    const padR = 14;
    const padT = 16;
    const padB = 26;
    const plotW = cssW - padL - padR;
    const plotH = cssH - padT - padB;

    let maxV = 0;
    for (const key of ['download', 'upload'] as const) {
      for (const p of this.series[key]) if (p.v > maxV) maxV = p.v;
    }
    const yMax = niceCeil(maxV * 1.05);

    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

    for (let i = 0; i <= 4; i++) {
      const frac = i / 4;
      const y = padT + plotH * (1 - frac);
      ctx.strokeStyle = 'rgba(148,163,184,0.14)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(padL, y);
      ctx.lineTo(cssW - padR, y);
      ctx.stroke();
      ctx.fillStyle = 'rgba(148,163,184,0.9)';
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${trimNum(yMax >= 1000 ? (yMax * frac) / 1000 : yMax * frac)}`, padL - 8, y);
    }

    const stepSec = this.durationSec <= 6 ? 1 : this.durationSec <= 12 ? 2 : 5;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    for (let s = 0; s <= this.durationSec; s += stepSec) {
      const x = padL + (plotW * s) / this.durationSec;
      ctx.strokeStyle = 'rgba(148,163,184,0.07)';
      ctx.beginPath();
      ctx.moveTo(x, padT);
      ctx.lineTo(x, padT + plotH);
      ctx.stroke();
      ctx.fillStyle = 'rgba(148,163,184,0.8)';
      ctx.fillText(`${s}s`, x, padT + plotH + 7);
    }

    ctx.fillStyle = 'rgba(148,163,184,0.9)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(yMax >= 1000 ? 'Gbps' : 'Mbps', padL + 6, padT + 2);

    const colors: Record<SeriesKey, string> = { download: DL_COLOR, upload: UL_COLOR };
    for (const key of ['download', 'upload'] as const) {
      const raw = this.series[key];
      if (raw.length < 2) continue;
      const k =
        this.tipKey === key ? Math.min(1, (performance.now() - this.tipStartMs) / this.tipDurMs) : 1;
      const p0 = raw[raw.length - 2];
      const p1 = raw[raw.length - 1];
      const tipT = p0.t + (p1.t - p0.t) * k;
      const tipV = p0.v + (p1.v - p0.v) * k;
      const xs: number[] = [];
      const ys: number[] = [];
      for (let i = 0; i < raw.length - 1; i++) {
        xs.push(padL + (plotW * Math.min(raw[i].t, this.durationSec)) / this.durationSec);
        ys.push(padT + plotH * (1 - Math.min(raw[i].v / yMax, 1)));
      }
      xs.push(padL + (plotW * Math.min(tipT, this.durationSec)) / this.durationSec);
      ys.push(padT + plotH * (1 - Math.min(tipV / yMax, 1)));
      ctx.save();
      ctx.strokeStyle = colors[key];
      ctx.lineWidth = 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.shadowColor = colors[key];
      ctx.shadowBlur = 8;
      ctx.beginPath();
      ctx.moveTo(xs[0], ys[0]);
      for (let i = 1; i < xs.length - 1; i++) {
        const xc = (xs[i] + xs[i + 1]) / 2;
        const yc = (ys[i] + ys[i + 1]) / 2;
        ctx.quadraticCurveTo(xs[i], ys[i], xc, yc);
      }
      ctx.lineTo(xs[xs.length - 1], ys[ys.length - 1]);
      ctx.stroke();
      ctx.restore();
      if (this.tipKey === key && k >= 1) this.tipKey = null;
    }
  }
}

let chart = new SpeedChart(els.canvas, currentDurationSec);

window.addEventListener('resize', () => chart.redraw());

function setPhase(phase: UiPhase): void {
  const idx = PHASES.indexOf(phase);
  els.phaseItems.forEach((li, i) => {
    li.classList.toggle('active', i === idx);
    li.classList.toggle('done', i < idx);
  });
}

function setDirValue(numEl: HTMLSpanElement, unitEl: HTMLSpanElement, mbps: number | null): void {
  if (mbps === null) {
    numEl.textContent = '--';
    unitEl.textContent = '';
    return;
  }
  if (mbps >= 1000) {
    numEl.textContent = (mbps / 1000).toFixed(2);
    unitEl.textContent = 'Gbps';
  } else {
    numEl.textContent = mbps.toFixed(1);
    unitEl.textContent = 'Mbps';
  }
}

function fmtCard(mbps: number): string {
  return mbps >= 1000 ? `${(mbps / 1000).toFixed(2)} Gbps` : `${mbps.toFixed(1)} Mbps`;
}

function setStatus(text: string): void {
  els.statusText.textContent = text;
}

function resetControls(): void {
  running = false;
  els.startBtn.disabled = false;
  els.startBtn.textContent = '測定開始';
}

const rawSamples: Record<'download' | 'upload', { tMs: number; mbps: number }[]> = {
  download: [],
  upload: [],
};

const RING_CIRCUMFERENCE = 2 * Math.PI * 52;
const GRADE_COLORS: Record<string, string> = {
  S: '#ffd166',
  A: '#34d97b',
  B: '#4f8cff',
  C: '#93a1ba',
  D: '#ffb454',
  E: '#ff7a7a',
};

function cvOf(samples: { tMs: number; mbps: number }[]): number | null {
  const buckets = new Map<number, number[]>();
  for (const s of samples) {
    if (s.tMs < 2000) continue;
    const key = Math.floor(s.tMs / 1000);
    const arr = buckets.get(key);
    if (arr) arr.push(s.mbps);
    else buckets.set(key, [s.mbps]);
  }
  if (buckets.size < 4) return null;
  const means = [...buckets.values()]
    .map((v) => v.reduce((a, b) => a + b, 0) / v.length)
    .sort((a, b) => a - b);
  const trim = means.length >= 10 ? Math.floor(means.length * 0.1) : 0;
  const core = trim > 0 ? means.slice(trim, means.length - trim) : means;
  const mean = core.reduce((a, b) => a + b, 0) / core.length;
  if (mean <= 0) return null;
  const variance = core.reduce((acc, b) => acc + (b - mean) ** 2, 0) / core.length;
  return (Math.sqrt(variance) / mean) * 100;
}

function applyScore(score: ReturnType<typeof computeScore>): void {
  els.scoreRing.style.strokeDashoffset = String(RING_CIRCUMFERENCE * (1 - score.total / 100));
  els.scoreTotal.textContent = String(score.total);
  els.scoreGrade.textContent = `grade ${score.grade}`;
  els.scoreGrade.style.color = GRADE_COLORS[score.grade] ?? 'var(--text-2)';
  const items = {
    download: score.download,
    upload: score.upload,
    latency: score.latency,
    jitter: score.jitter,
    stability: score.stability,
    packetLoss: score.packetLoss,
  } as const;
  for (const key of Object.keys(items) as (keyof typeof items)[]) {
    const v = items[key];
    if (v === null) {
      els.fills[key].style.width = '0%';
      els.vals[key].textContent = '--';
    } else {
      els.fills[key].style.width = `${Math.round(v)}%`;
      els.vals[key].textContent = String(Math.round(v));
    }
  }
}

function onSample(msg: SampleMessage): void {
  rawSamples[msg.phase].push({ tMs: msg.tMs, mbps: msg.instantMbps });
  if (msg.phase === 'download') {
    emaDl = emaDl === null ? msg.instantMbps : emaDl * 0.7 + msg.instantMbps * 0.3;
    setDirValue(els.dlNum, els.dlUnit, emaDl);
  } else {
    emaUl = emaUl === null ? msg.instantMbps : emaUl * 0.7 + msg.instantMbps * 0.3;
    setDirValue(els.ulNum, els.ulUnit, emaUl);
  }
  chart.add(msg.phase, msg.tMs, msg.instantMbps);
}

function finish(res: ResultMessage): void {
  els.dlPeak.textContent = fmtCard(res.download.peakMbps);
  els.dlSust.textContent = fmtCard(res.download.sustainedMbps);
  els.ulPeak.textContent = fmtCard(res.upload.peakMbps);
  els.ulSust.textContent = fmtCard(res.upload.sustainedMbps);
  els.latVal.textContent = `${res.latencyMs.toFixed(1)} ms`;
  els.jitVal.textContent = `${res.jitterMs.toFixed(1)} ms`;
  els.lossVal.textContent =
    res.packetLossPercent === null ? '--' : `${(res.packetLossPercent * 100).toFixed(2)} %`;

  els.results.hidden = false;

  const cvs = [cvOf(rawSamples.download), cvOf(rawSamples.upload)].filter(
    (x): x is number => x !== null
  );
  const stabilityCv = cvs.length ? cvs.reduce((a, b) => a + b, 0) / cvs.length : null;
  applyScore(
    computeScore({
      downloadMbps: res.download.sustainedMbps,
      uploadMbps: res.upload.sustainedMbps,
      latencyMs: res.latencyMs,
      jitterMs: res.jitterMs,
      stabilityCvPercent: stabilityCv,
      packetLossPercent: res.packetLossPercent,
    })
  );

  setDirValue(els.dlNum, els.dlUnit, res.download.sustainedMbps);
  setDirValue(els.ulNum, els.ulUnit, res.upload.sustainedMbps);
  resetControls();
}

const worker = new Worker(new URL('./engine/engine.worker.ts', import.meta.url), { type: 'module' });

worker.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data as ToMainMessage;
  switch (msg.type) {
    case 'meta':
      els.infoColo.textContent = msg.colo ?? '--';
      els.infoIsp.textContent = msg.isp ?? '--';
      els.infoIp.textContent = msg.ip ?? '--';
      break;
    case 'protocol':
      els.infoProto.textContent = fmtProtocol(msg.hopProtocol);
      break;
    case 'phase':
      setPhase(msg.phase);
      break;
    case 'sample':
      onSample(msg);
      break;
    case 'result':
      finish(msg);
      break;
    case 'error':
      setStatus(`エラー: ${msg.message}`);
      resetControls();
      break;
  }
});

worker.addEventListener('error', () => {
  setStatus('エラー: 測定ワーカーが異常終了しました');
  resetControls();
});

els.startBtn.addEventListener('click', () => {
  if (running) return;
  const checked = document.querySelector<HTMLInputElement>('input[name="duration"]:checked');
  currentDurationSec = checked ? Number(checked.value) : 12;
  const checkedProto = document.querySelector<HTMLInputElement>('input[name="proto"]:checked');
  const host = (checkedProto?.value === 'h3' ? 'h3' : 'auto') as 'auto' | 'h3';
  running = true;
  emaDl = null;
  emaUl = null;
  rawSamples.download = [];
  rawSamples.upload = [];
  els.startBtn.disabled = true;
  els.startBtn.textContent = '測定中…';
  els.results.hidden = true;
  setStatus('');
  setPhase('latency');
  setDirValue(els.dlNum, els.dlUnit, null);
  setDirValue(els.ulNum, els.ulUnit, null);
  chart.reset(currentDurationSec);
  worker.postMessage({ type: 'start', durationSec: currentDurationSec, host });
});
