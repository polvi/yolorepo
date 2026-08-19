import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_TTL_MS,
  HEARTBEAT_OFFLINE_MS,
  HEARTBEAT_STALE_MS,
  REATTEST_EVERY_MS,
  challengeDecision,
  effectiveStatus,
  peekPayload,
  statusAfterAttest,
  type TrustInputs,
} from '../worker/trust';

const NOW = 1_755_600_000_000;
const MIN = 60_000;

function row(over: Partial<TrustInputs> = {}): TrustInputs {
  return {
    trust_status: 'verified',
    simulated: 0,
    verified_at: NOW - 5 * MIN,
    last_heartbeat: NOW - 2 * MIN,
    challenge: null,
    challenge_issued_at: null,
    ...over,
  };
}

describe('statusAfterAttest', () => {
  it('verified doc → verified regardless of the simulated flag', () => {
    expect(statusAfterAttest('verified', false)).toBe('verified');
    expect(statusAfterAttest('verified', true)).toBe('verified');
  });
  it('simulated doc is only simulated on a simulated listing', () => {
    expect(statusAfterAttest('simulated', true)).toBe('simulated');
    expect(statusAfterAttest('simulated', false)).toBe('failed');
  });
  it('failed doc → failed', () => {
    expect(statusAfterAttest('failed', true)).toBe('failed');
    expect(statusAfterAttest('failed', false)).toBe('failed');
  });
});

describe('effectiveStatus', () => {
  it('fresh heartbeat + verification keeps the stored status', () => {
    expect(effectiveStatus(row(), NOW)).toBe('verified');
    expect(effectiveStatus(row({ trust_status: 'simulated', simulated: 1 }), NOW)).toBe('simulated');
  });
  it('failed is sticky no matter how alive the runner is', () => {
    expect(effectiveStatus(row({ trust_status: 'failed' }), NOW)).toBe('failed');
  });
  it('heartbeat older than 15 min → stale, older than 1 h → offline', () => {
    expect(effectiveStatus(row({ last_heartbeat: NOW - HEARTBEAT_STALE_MS - 1 }), NOW)).toBe('stale');
    expect(effectiveStatus(row({ last_heartbeat: NOW - HEARTBEAT_STALE_MS + 1 }), NOW)).toBe('verified');
    expect(effectiveStatus(row({ last_heartbeat: NOW - HEARTBEAT_OFFLINE_MS - 1 }), NOW)).toBe('offline');
  });
  it('no heartbeat ever → offline', () => {
    expect(effectiveStatus(row({ last_heartbeat: null }), NOW)).toBe('offline');
  });
  it('alive but never attested → stale', () => {
    expect(effectiveStatus(row({ trust_status: 'offline', verified_at: null }), NOW)).toBe('stale');
  });
  it('unanswered challenge older than 10 min → stale; a fresh pending one is fine', () => {
    const c = 'ab'.repeat(32);
    expect(
      effectiveStatus(row({ challenge: c, challenge_issued_at: NOW - CHALLENGE_TTL_MS - 1 }), NOW)
    ).toBe('stale');
    expect(
      effectiveStatus(row({ challenge: c, challenge_issued_at: NOW - CHALLENGE_TTL_MS + 1 }), NOW)
    ).toBe('verified');
  });
});

describe('challengeDecision', () => {
  const fresh = () => 'cd'.repeat(32);
  it('nothing due: no challenge', () => {
    expect(challengeDecision(row(), NOW, fresh)).toEqual({ challenge: null, issue: false });
  });
  it('never verified → issue', () => {
    expect(challengeDecision(row({ verified_at: null }), NOW, fresh)).toEqual({
      challenge: 'cd'.repeat(32),
      issue: true,
    });
  });
  it('verification older than 6 h → issue', () => {
    expect(challengeDecision(row({ verified_at: NOW - REATTEST_EVERY_MS - 1 }), NOW, fresh).issue).toBe(
      true
    );
    expect(challengeDecision(row({ verified_at: NOW - REATTEST_EVERY_MS + 1 }), NOW, fresh).issue).toBe(
      false
    );
  });
  it('a fresh pending challenge is repeated, not replaced', () => {
    const pending = 'ef'.repeat(32);
    expect(
      challengeDecision(row({ challenge: pending, challenge_issued_at: NOW - MIN }), NOW, fresh)
    ).toEqual({ challenge: pending, issue: false });
  });
  it('an expired pending challenge is replaced even if verification is recent', () => {
    const pending = 'ef'.repeat(32);
    expect(
      challengeDecision(
        row({ challenge: pending, challenge_issued_at: NOW - CHALLENGE_TTL_MS - 1 }),
        NOW,
        fresh
      )
    ).toEqual({ challenge: 'cd'.repeat(32), issue: true });
  });
});

describe('peekPayload', () => {
  it('decodes base64url JSON without verifying', () => {
    const json = JSON.stringify({ challenge: '00'.repeat(32), v: 1 });
    const b64u = btoa(json).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
    expect(peekPayload({ payload: b64u })).toEqual({ challenge: '00'.repeat(32), v: 1 });
  });
  it('returns null on garbage', () => {
    expect(peekPayload({ payload: '!!!' })).toBeNull();
  });
});
