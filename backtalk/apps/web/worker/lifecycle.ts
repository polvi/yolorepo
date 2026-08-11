// Status machines for feedback items and error groups. Shared by the
// dashboard API, the MCP tools, and the unit tests so all three agree.

export type FeedbackStatus = 'new' | 'seen' | 'planned' | 'done' | 'declined';
export type ErrorStatus = 'open' | 'resolved' | 'regressed';

// Forward jumps are legal (new -> done is fine); done/declined can be pulled
// back onto the roadmap; nothing ever returns to 'new'.
export const FEEDBACK_TRANSITIONS: Record<FeedbackStatus, FeedbackStatus[]> = {
  new: ['seen', 'planned', 'done', 'declined'],
  seen: ['planned', 'done', 'declined'],
  planned: ['done', 'declined'],
  done: ['planned'],
  declined: ['planned'],
};

// Manual transitions only. resolved -> regressed is reserved for the ingest
// path's conditional UPDATE (a reoccurrence), never for humans or agents.
export const ERROR_MANUAL_TRANSITIONS: Record<ErrorStatus, ErrorStatus[]> = {
  open: ['resolved'],
  resolved: ['open'],
  regressed: ['resolved'],
};

/** done/declined are what the submitter sees, so they need words attached. */
export function noteRequired(status: FeedbackStatus): boolean {
  return status === 'done' || status === 'declined';
}

export function canTransitionFeedback(from: FeedbackStatus, to: FeedbackStatus): boolean {
  return FEEDBACK_TRANSITIONS[from]?.includes(to) ?? false;
}

export function canTransitionError(from: ErrorStatus, to: ErrorStatus): boolean {
  return ERROR_MANUAL_TRANSITIONS[from]?.includes(to) ?? false;
}
