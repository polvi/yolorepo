import { describe, expect, it } from 'vitest';
import {
  canTransitionError,
  canTransitionFeedback,
  noteRequired,
  type ErrorStatus,
  type FeedbackStatus,
} from '../worker/lifecycle';

const FEEDBACK: FeedbackStatus[] = ['new', 'seen', 'planned', 'done', 'declined'];
const ERROR: ErrorStatus[] = ['open', 'resolved', 'regressed'];

describe('feedback lifecycle', () => {
  it('allows forward jumps from new', () => {
    for (const to of ['seen', 'planned', 'done', 'declined'] as const) {
      expect(canTransitionFeedback('new', to)).toBe(true);
    }
  });

  it('never returns to new', () => {
    for (const from of FEEDBACK) {
      expect(canTransitionFeedback(from, 'new')).toBe(false);
    }
  });

  it('lets done/declined be pulled back onto the roadmap only', () => {
    for (const from of ['done', 'declined'] as const) {
      expect(canTransitionFeedback(from, 'planned')).toBe(true);
      expect(canTransitionFeedback(from, 'seen')).toBe(false);
      expect(canTransitionFeedback(from, from === 'done' ? 'declined' : 'done')).toBe(false);
    }
  });

  it('rejects self-transitions', () => {
    for (const s of FEEDBACK) expect(canTransitionFeedback(s, s)).toBe(false);
  });

  it('requires a note exactly for the submitter-visible endings', () => {
    expect(noteRequired('done')).toBe(true);
    expect(noteRequired('declined')).toBe(true);
    expect(noteRequired('seen')).toBe(false);
    expect(noteRequired('planned')).toBe(false);
  });
});

describe('error group lifecycle (manual moves)', () => {
  it('open can only be resolved', () => {
    expect(canTransitionError('open', 'resolved')).toBe(true);
    expect(canTransitionError('open', 'regressed')).toBe(false);
  });

  it('resolved can be reopened but never manually regressed', () => {
    expect(canTransitionError('resolved', 'open')).toBe(true);
    expect(canTransitionError('resolved', 'regressed')).toBe(false);
  });

  it('regressed can be re-resolved only', () => {
    expect(canTransitionError('regressed', 'resolved')).toBe(true);
    expect(canTransitionError('regressed', 'open')).toBe(false);
  });

  it('rejects self-transitions', () => {
    for (const s of ERROR) expect(canTransitionError(s, s)).toBe(false);
  });
});
