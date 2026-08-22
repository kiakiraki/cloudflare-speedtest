export interface StartMessage {
  type: 'start';
  durationSec: number;
  host?: 'auto' | 'h3';
}

export interface MetaMessage {
  type: 'meta';
  ip: string | null;
  colo: string | null;
  isp: string | null;
}

export interface ProtocolMessage {
  type: 'protocol';
  hopProtocol: string | null;
}

export type Phase = 'latency' | 'loss' | 'download' | 'upload' | 'done';

export interface PhaseMessage {
  type: 'phase';
  phase: Phase;
}

export interface SampleMessage {
  type: 'sample';
  phase: 'download' | 'upload';
  tMs: number;
  instantMbps: number;
}

export interface DirectionSummary {
  peakMbps: number;
  sustainedMbps: number;
  p90Mbps: number;
}

export interface ResultMessage {
  type: 'result';
  download: DirectionSummary;
  upload: DirectionSummary;
  latencyMs: number;
  jitterMs: number;
  packetLossPercent: number | null;
  downLoadedLatencyMs: number | null;
  upLoadedLatencyMs: number | null;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ToMainMessage =
  | MetaMessage
  | PhaseMessage
  | SampleMessage
  | ResultMessage
  | ErrorMessage
  | ProtocolMessage;

export type FromMainMessage = StartMessage;
