import type { MessageSummary } from '../../discord/ports.js';

/** Discord refuses to bulk delete messages older than 14 days; keep a small safety margin. */
export const BULK_DELETE_MAX_AGE_MS = 14 * 86_400_000 - 60_000;

export interface PurgePlan {
  toDelete: string[];
  /** Matching messages skipped because they are too old to bulk delete. */
  skippedOld: number;
  /** Matching messages skipped because they are pinned. */
  skippedPinned: number;
  scanned: number;
}

/**
 * Decide which of the scanned messages (newest first) to delete.
 * Without a user filter, the newest `amount` messages are considered.
 * With a user filter, the newest `amount` messages from that user are considered.
 */
export function planPurge(
  scannedNewestFirst: MessageSummary[],
  opts: { amount: number; userId?: string; now?: Date },
): PurgePlan {
  const now = (opts.now ?? new Date()).getTime();
  const candidates = scannedNewestFirst
    .filter((m) => !opts.userId || m.authorId === opts.userId)
    .slice(0, opts.amount);
  const plan: PurgePlan = {
    toDelete: [],
    skippedOld: 0,
    skippedPinned: 0,
    scanned: scannedNewestFirst.length,
  };
  for (const m of candidates) {
    if (m.pinned) plan.skippedPinned++;
    else if (now - m.createdAt.getTime() > BULK_DELETE_MAX_AGE_MS) plan.skippedOld++;
    else plan.toDelete.push(m.id);
  }
  return plan;
}
