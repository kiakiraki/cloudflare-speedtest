import { describe, expect, it } from 'vitest';
import { computeScore } from './score';

describe('computeScore', () => {
  const ideal = {
    downloadMbps: 10000,
    uploadMbps: 10000,
    latencyMs: 5,
    jitterMs: 1,
    stabilityCvPercent: null,
    packetLossPercent: null,
  };

  const worst = {
    downloadMbps: 1,
    uploadMbps: 1,
    latencyMs: 150,
    jitterMs: 40,
    stabilityCvPercent: null,
    packetLossPercent: null,
  };

  it('returns S with total 100 for an ideal connection', () => {
    const result = computeScore(ideal);
    expect(result.total).toBe(100);
    expect(result.grade).toBe('S');
  });

  it('returns E with total 0 for the worst connection', () => {
    const result = computeScore(worst);
    expect(result.total).toBe(0);
    expect(result.grade).toBe('E');
  });

  it('clamps out-of-range values', () => {
    const high = computeScore({ ...ideal, downloadMbps: 100000 });
    expect(high.download).toBe(100);

    const low = computeScore({ ...worst, latencyMs: 500 });
    expect(low.latency).toBe(0);
  });

  it('includes stability and packet loss scores when measured', () => {
    const result = computeScore({
      ...ideal,
      stabilityCvPercent: 8,
      packetLossPercent: 0,
    });
    expect(result.stability).toBe(100);
    expect(result.packetLoss).toBe(100);
    expect(result.total).toBe(100);
  });

  it('computes a deterministic mid-range score', () => {
    const result = computeScore({ ...ideal, downloadMbps: 100 });
    expect(result.download).toBe(50);
    expect(result.total).toBe(79);
    expect(result.grade).toBe('B');
  });
});
