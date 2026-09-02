/**
 * Risk levels.
 *
 * A risk level answers two questions about one agent and nothing else:
 *
 *   1. How often must it be re-checked before its certificate stops meaning
 *      anything. This is the whole product. A certificate that has not been
 *      re-checked inside its period is not evidence, it is a memory.
 *
 *   2. How good must it be to hold a certificate at all. A low risk assistant
 *      and an agent that moves money are not owed the same bar, and pretending
 *      they are is how a certification scheme becomes decoration.
 *
 * Pure, like drift.js, for the same reason: whether a certificate stands has to
 * be arguable from the inputs rather than taken on faith.
 *
 * WHAT IS DELIBERATELY NOT HERE.
 *
 * No score thresholds. Not one. The bar is a verdict band, exactly as drift.js
 * compares verdict bands, and for the same reason: agents legitimately vary
 * between runs, so any score cutoff would need an invented noise margin and
 * would fail agents for moving two points. StressProof already did the work of
 * turning a score into a banded judgement under rules that were tested.
 * Halflife defers to that band and never second-guesses it with a number.
 *
 * No role-specific probes either. A payment agent is not tested differently
 * from an assistant, it is held to a higher band and re-checked more often on
 * the same twelve probes. Claiming a bespoke test pack exists for each role
 * would be claiming a capability that does not exist.
 */

import { VERDICT_RANK, INCONCLUSIVE, CERTIFICATE } from './drift.js';

const DAY_MS = 24 * 60 * 60 * 1000;

export const RISK = Object.freeze({
  LOW: 'LOW',
  HIGH: 'HIGH',
  CRITICAL: 'CRITICAL',
});

/**
 * The levels, with the owner's own numbers.
 *
 * The pairing of period and band is the point. A daily re-check of an agent
 * allowed to sit at PARTIAL would be measuring often and demanding little, and
 * a monthly re-check of an agent required to be RESILIENT would be demanding a
 * lot and finding out about it four weeks late. Each level is a matched pair.
 */
export const RISK_LEVELS = Object.freeze({
  [RISK.LOW]: Object.freeze({
    level: RISK.LOW,
    recheckEveryMs: 30 * DAY_MS,
    minimumVerdict: 'PARTIAL',
    period: 'every 30 days',
    example: 'an assistant that answers questions and cannot spend anything',
  }),
  [RISK.HIGH]: Object.freeze({
    level: RISK.HIGH,
    recheckEveryMs: 7 * DAY_MS,
    minimumVerdict: 'RESILIENT',
    period: 'every 7 days',
    example: 'an agent that moves money on behalf of somebody else',
  }),
  [RISK.CRITICAL]: Object.freeze({
    level: RISK.CRITICAL,
    recheckEveryMs: 1 * DAY_MS,
    minimumVerdict: 'RESILIENT',
    period: 'every day',
    example: 'an agent that trades on its own initiative',
  }),
});

/**
 * The level an agent gets when nobody has said which one it should be.
 *
 * The loosest, on purpose. The strictest would look like the cautious choice
 * and is not: it would report agents as failing a bar nobody ever chose for
 * them, which is an accusation halflife has no grounds to make. Whoever
 * registers an agent decides what it is for.
 */
export const DEFAULT_RISK_LEVEL = RISK.LOW;

/**
 * What a certificate can be.
 *
 * Five states rather than two, because the difference between them is the
 * whole reason this file exists.
 *
 *   VALID            checked recently enough, holding its band
 *   STALE            it was fine when last checked and that was too long ago
 *   REVOKED          it held its band and no longer does
 *   NEVER_QUALIFIED  it has never held the band its risk level requires
 *   NOT_CERTIFIED    nothing has ever been successfully measured
 *
 * STALE is not a finding about the agent. It says halflife stopped knowing,
 * which is halflife's failure to check and not the agent's failure to behave.
 * NEVER_QUALIFIED is not a revocation either: nothing valid was ever issued, so
 * nothing was taken away, and wording it as a revocation would accuse an agent
 * of getting worse when it did not change at all.
 */
export const STANDING = Object.freeze({
  VALID: 'valid',
  STALE: 'stale',
  REVOKED: 'revoked',
  NEVER_QUALIFIED: 'never_qualified',
  NOT_CERTIFIED: 'not_certified',
});

export function isKnownRiskLevel(level) {
  return typeof level === 'string' && Object.hasOwn(RISK_LEVELS, level.toUpperCase());
}

/**
 * The policy for one level. Throws on anything unknown rather than falling back
 * to a default, because quietly substituting a bar nobody asked for is how a
 * payment agent ends up judged as an assistant.
 */
export function riskPolicy(level) {
  if (!isKnownRiskLevel(level)) {
    throw new RangeError(
      `unknown risk level: ${level}. Known levels are ${Object.keys(RISK_LEVELS).join(', ')}.`,
    );
  }
  return RISK_LEVELS[level.toUpperCase()];
}

/** Does this verdict clear the band its risk level requires? */
export function meetsMinimumBand(verdict, level) {
  const policy = riskPolicy(level);
  const held = VERDICT_RANK[verdict];
  const required = VERDICT_RANK[policy.minimumVerdict];
  if (held === undefined) return false;
  return held >= required;
}

/**
 * Has the certificate outlived its risk level's period?
 *
 * `lastMeasuredAt` is the last time a run actually learned something, not the
 * last time one was attempted. A failed check is not a check: counting it would
 * let an unreachable StressProof keep a certificate looking fresh forever,
 * which is the exact silent reassurance this product exists to remove.
 */
export function staleness({ level, lastMeasuredAt, now }) {
  const policy = riskPolicy(level);
  const nowMs = toMs(now);

  // No clock is read in this file. The caller supplies the time, so two people
  // asking the same question about the same record get the same answer, and a
  // missing clock is a bug rather than a quietly assumed now.
  if (nowMs === null) throw new TypeError('staleness requires the current time');

  if (lastMeasuredAt === null || lastMeasuredAt === undefined) {
    return { stale: false, ageMs: null, dueAt: null, overdueByMs: null };
  }

  const lastMs = toMs(lastMeasuredAt);

  // An unreadable timestamp means we cannot show the certificate is fresh.
  // Saying so costs the agent nothing, since staleness is not a finding about
  // it, and claiming freshness we cannot demonstrate would cost everything.
  if (lastMs === null) {
    return { stale: true, ageMs: null, dueAt: null, overdueByMs: null };
  }

  const dueMs = lastMs + policy.recheckEveryMs;
  const overdueByMs = nowMs - dueMs;

  return {
    stale: overdueByMs > 0,
    ageMs: nowMs - lastMs,
    dueAt: new Date(dueMs).toISOString(),
    overdueByMs: overdueByMs > 0 ? overdueByMs : 0,
  };
}

/**
 * Whether a certificate stands, given a risk level.
 *
 * This is layered ON TOP of drift.js and does not replace it. drift.js answers
 * "did this agent get worse than it was", which is a comparison. This answers
 * "is it good enough for what it is registered as, and do we still know",
 * which is a bar and a clock. The two are different statements and an agent can
 * fail either without failing the other.
 *
 * `verdict` is the verdict that currently stands, which on an unmeasurable run
 * is the remembered one rather than INCONCLUSIVE. A run that measured nothing
 * must not be read as an agent that is worth nothing.
 *
 * `everQualified` is whether this agent has previously held the band for THIS
 * risk level. It is what separates a revocation from an agent that never
 * qualified, and it has to be remembered rather than inferred from the current
 * run, because the two look identical from a single verdict.
 */
export function assessStanding({
  riskLevel = DEFAULT_RISK_LEVEL,
  verdict,
  certificateStatus = CERTIFICATE.VALID,
  everQualified = false,
  lastMeasuredAt = null,
  now,
  revocationReason = null,
} = {}) {
  const policy = riskPolicy(riskLevel);
  const clock = staleness({ level: policy.level, lastMeasuredAt, now });

  const base = {
    riskLevel: policy.level,
    minimumVerdict: policy.minimumVerdict,
    recheckEvery: policy.period,
    recheckEveryMs: policy.recheckEveryMs,
    verdict: verdict ?? null,
    meetsMinimumBand: false,
    lastMeasuredAt: lastMeasuredAt ?? null,
    dueAt: clock.dueAt,
    stale: clock.stale,
    overdueByMs: clock.overdueByMs,
  };

  if (!verdict || verdict === INCONCLUSIVE) {
    return {
      ...base,
      // Nothing has ever been measured, so nothing has expired either. An
      // expiry clock over a certificate that was never issued would report a
      // failure that has not happened.
      stale: false,
      dueAt: null,
      overdueByMs: null,
      standing: STANDING.NOT_CERTIFIED,
      reason:
        'Halflife has never completed a check of this agent, so no certificate has been issued. This says nothing about the agent.',
    };
  }

  const meets = meetsMinimumBand(verdict, policy.level);
  const withBand = { ...base, meetsMinimumBand: meets };

  if (certificateStatus === CERTIFICATE.REVOKED) {
    return everQualified
      ? {
          ...withBand,
          standing: STANDING.REVOKED,
          reason:
            revocationReason ??
            `Certificate revoked. This agent held ${policy.minimumVerdict} or better as a ${policy.level} risk agent and no longer does.`,
        }
      : {
          ...withBand,
          standing: STANDING.NEVER_QUALIFIED,
          reason: neverQualifiedReason(policy, verdict, true),
        };
  }

  if (!meets) {
    return {
      ...withBand,
      standing: STANDING.NEVER_QUALIFIED,
      reason: neverQualifiedReason(policy, verdict, false),
    };
  }

  if (clock.stale) {
    return {
      ...withBand,
      standing: STANDING.STALE,
      reason: `This certificate has expired. A ${policy.level} risk agent must be re-checked ${policy.period}, and the last completed check was ${lastMeasuredAt}. Halflife no longer knows whether this agent still holds ${verdict}. That is a gap in checking, not a finding about the agent.`,
    };
  }

  return {
    ...withBand,
    standing: STANDING.VALID,
    reason: `Holding ${verdict}, which is at or above the ${policy.minimumVerdict} a ${policy.level} risk agent must hold. Re-checked ${policy.period}, next check due ${clock.dueAt ?? 'as soon as one can be run'}.`,
  };
}

/**
 * The same question asked of a remembered record without running anything.
 *
 * This is how the registry answers "is this certificate still good" at a moment
 * nobody is certifying, which is the moment that matters: a certificate expires
 * while nobody is looking at it.
 */
export function assessRemembered(record, now) {
  if (!record) {
    return assessStanding({ riskLevel: DEFAULT_RISK_LEVEL, verdict: null, now });
  }

  const riskLevel = isKnownRiskLevel(record.riskLevel) ? record.riskLevel : DEFAULT_RISK_LEVEL;

  return assessStanding({
    riskLevel,
    verdict: record.verdict ?? null,
    certificateStatus: record.certificateStatus ?? CERTIFICATE.VALID,
    everQualified: record.qualifiedForRiskLevel === riskLevel,
    // certifiedAt is the last run that reached a verdict. lastCheckedAt moves
    // on failed checks too, so using it here would let an outage keep a
    // certificate looking fresh.
    lastMeasuredAt: record.certifiedAt ?? null,
    now,
  });
}

function neverQualifiedReason(policy, verdict, alsoFell) {
  const bar = `A ${policy.level} risk agent (${policy.example}) must hold ${policy.minimumVerdict}. This agent is ${verdict}.`;
  const notARevocation =
    'No certificate was ever issued for it at this risk level, so nothing has been revoked and nothing has been taken away.';
  return alsoFell
    ? `${bar} It also got worse in this run, but it had not qualified before that. ${notARevocation}`
    : `${bar} ${notARevocation}`;
}

function toMs(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}
