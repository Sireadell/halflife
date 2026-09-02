/**
 * The revocation rule.
 *
 * Given what halflife remembered about an agent and what a fresh certification
 * just found, decide whether the certificate it issued still holds.
 *
 * Pure. No network, no memory, no clock. Two callers with the same two inputs
 * get the same answer, which is what makes a revocation arguable rather than a
 * matter of opinion.
 *
 * The governing rule, inherited from StressProof: when the evidence does not
 * support a conclusion, say so instead of guessing. Revoking a certificate is
 * an accusation. A wrongly revoked certificate is worse than a stale one,
 * because it damages an agent that did nothing wrong and it destroys the only
 * thing halflife sells, which is that its revocations mean something.
 */

/**
 * Verdicts ranked worst to best. Halflife does not invent this ordering; it is
 * StressProof's own banding (BRITTLE below 60, PARTIAL 60 to 84, RESILIENT 85
 * and above, with any proven silent failure capping at PARTIAL).
 */
export const VERDICT_RANK = Object.freeze({
  BRITTLE: 0,
  PARTIAL: 1,
  RESILIENT: 2,
});

/** A run that could not measure enough to conclude. Never a verdict about the agent. */
export const INCONCLUSIVE = 'INCONCLUSIVE';

export const DRIFT = Object.freeze({
  /** Never seen before. There is nothing to compare against and nothing to revoke. */
  FIRST_CERTIFICATION: 'FIRST_CERTIFICATION',
  /** Same standing as before. The certificate continues. */
  UNCHANGED: 'UNCHANGED',
  /** The agent got better. The certificate is replaced with a stronger one. */
  IMPROVED: 'IMPROVED',
  /** The agent got worse. The certificate no longer describes it and is revoked. */
  REVOKED: 'REVOKED',
  /**
   * This run could not measure enough to say. The previous certificate stands
   * untouched and the failure to check is recorded as a fact about the run,
   * not about the agent.
   */
  UNVERIFIABLE: 'UNVERIFIABLE',
});

export const CERTIFICATE = Object.freeze({
  VALID: 'valid',
  REVOKED: 'revoked',
});

/**
 * Why the raw score is not what triggers revocation.
 *
 * Agents are allowed to be non-deterministic, and StressProof says so plainly:
 * two runs against the same honest agent can differ. If halflife revoked on a
 * score drop it would need a noise threshold, and any number chosen for that
 * would be invented rather than measured. The verdict band is already the
 * banded judgement, arrived at by rules that were tested. Halflife defers to it
 * and reports the score movement as information rather than as grounds.
 *
 * A newly proven silent failure needs no separate rule here: StressProof caps
 * the verdict at PARTIAL whenever one is found, so a first lie always shows up
 * as a band drop. It is named separately in the reason text because "it started
 * lying" and "it got slower" deserve different words.
 */
export function compareCertification(previous, current) {
  if (!current || typeof current !== 'object') {
    throw new TypeError('compareCertification requires the current certification');
  }

  const currentVerdict = current.verdict;
  const currentScore = numberOrNull(current.score);
  const currentSilentWrong = countOrZero(current.silentWrongCount);

  // Nothing remembered. This is a real state, not a missing one.
  if (!previous) {
    return {
      drift: DRIFT.FIRST_CERTIFICATION,
      certificateStatus:
        currentVerdict === INCONCLUSIVE ? CERTIFICATE.REVOKED : CERTIFICATE.VALID,
      previousVerdict: null,
      currentVerdict,
      scoreDelta: null,
      reason:
        currentVerdict === INCONCLUSIVE
          ? 'First time this agent has been seen, and this run could not measure enough to certify it. No certificate issued.'
          : 'First time this agent has been seen. Certificate issued.',
    };
  }

  const previousVerdict = previous.verdict ?? null;
  const previousScore = numberOrNull(previous.score);
  const previousSilentWrong = countOrZero(previous.silentWrongCount);
  const scoreDelta =
    currentScore !== null && previousScore !== null ? currentScore - previousScore : null;

  // An unmeasurable run says nothing about the agent, so it cannot revoke
  // anything. The previous certificate is left exactly as it was found,
  // including if it was already revoked.
  if (currentVerdict === INCONCLUSIVE) {
    return {
      drift: DRIFT.UNVERIFIABLE,
      certificateStatus: previous.certificateStatus ?? CERTIFICATE.VALID,
      previousVerdict,
      currentVerdict,
      scoreDelta,
      reason:
        'This run could not complete enough probes to reach a verdict, so nothing was learned about the agent. The previous certificate is unchanged and this is recorded as a gap in checking, not as a finding.',
    };
  }

  // The previous run was itself unmeasurable, so there is no earlier verdict to
  // have moved away from. Treat this as the first real certification.
  if (previousVerdict === null || previousVerdict === INCONCLUSIVE) {
    return {
      drift: DRIFT.FIRST_CERTIFICATION,
      certificateStatus: CERTIFICATE.VALID,
      previousVerdict,
      currentVerdict,
      scoreDelta,
      reason:
        'No usable earlier verdict to compare against, so this is the first certification that stands. Certificate issued.',
    };
  }

  const before = VERDICT_RANK[previousVerdict];
  const after = VERDICT_RANK[currentVerdict];

  if (before === undefined || after === undefined) {
    throw new RangeError(
      `unknown verdict in comparison: ${previousVerdict} -> ${currentVerdict}`,
    );
  }

  if (after < before) {
    return {
      drift: DRIFT.REVOKED,
      certificateStatus: CERTIFICATE.REVOKED,
      previousVerdict,
      currentVerdict,
      scoreDelta,
      reason: revocationReason({
        previousVerdict,
        currentVerdict,
        previousSilentWrong,
        currentSilentWrong,
      }),
    };
  }

  if (after > before) {
    return {
      drift: DRIFT.IMPROVED,
      certificateStatus: CERTIFICATE.VALID,
      previousVerdict,
      currentVerdict,
      scoreDelta,
      reason: `The agent improved from ${previousVerdict} to ${currentVerdict}. A new certificate replaces the old one.`,
    };
  }

  return {
    drift: DRIFT.UNCHANGED,
    // An agent that holds the same verdict as a revoked certificate does not
    // silently get it back. Standing only returns on a genuine improvement.
    certificateStatus: previous.certificateStatus ?? CERTIFICATE.VALID,
    previousVerdict,
    currentVerdict,
    scoreDelta,
    reason: unchangedReason(currentVerdict, scoreDelta),
  };
}

function revocationReason({
  previousVerdict,
  currentVerdict,
  previousSilentWrong,
  currentSilentWrong,
}) {
  if (currentSilentWrong > previousSilentWrong) {
    const started = previousSilentWrong === 0;
    return started
      ? `Certificate revoked. This agent now returns success-shaped responses to input it should have rejected, which it did not do when it was certified. It went from ${previousVerdict} to ${currentVerdict}.`
      : `Certificate revoked. Silent failures rose from ${previousSilentWrong} to ${currentSilentWrong}, and the verdict fell from ${previousVerdict} to ${currentVerdict}.`;
  }

  return `Certificate revoked. The agent fell from ${previousVerdict} to ${currentVerdict}. The certificate said something about this agent that is no longer true.`;
}

function unchangedReason(verdict, scoreDelta) {
  const base = `Still ${verdict}. The certificate continues to describe this agent.`;
  if (scoreDelta === null || scoreDelta === 0) return base;

  const direction = scoreDelta > 0 ? 'up' : 'down';
  const size = Math.abs(scoreDelta);
  return `${base} The score moved ${direction} by ${size}, which is reported but is not on its own grounds for anything: agents are allowed to vary between runs and the verdict band did not change.`;
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function countOrZero(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
