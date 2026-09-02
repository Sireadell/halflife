import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RISK,
  RISK_LEVELS,
  DEFAULT_RISK_LEVEL,
  STANDING,
  assessStanding,
  assessRemembered,
  meetsMinimumBand,
  riskPolicy,
  staleness,
} from '../src/lib/risk.js';
import { CERTIFICATE } from '../src/lib/drift.js';

const NOW = '2026-09-02T00:00:00.000Z';
const daysBefore = (n) => new Date(Date.parse(NOW) - n * 24 * 60 * 60 * 1000).toISOString();

test('the levels carry the periods and bands they are supposed to', () => {
  assert.equal(RISK_LEVELS[RISK.LOW].minimumVerdict, 'PARTIAL');
  assert.equal(RISK_LEVELS[RISK.LOW].recheckEveryMs, 30 * 24 * 60 * 60 * 1000);
  assert.equal(RISK_LEVELS[RISK.HIGH].minimumVerdict, 'RESILIENT');
  assert.equal(RISK_LEVELS[RISK.HIGH].recheckEveryMs, 7 * 24 * 60 * 60 * 1000);
  assert.equal(RISK_LEVELS[RISK.CRITICAL].minimumVerdict, 'RESILIENT');
  assert.equal(RISK_LEVELS[RISK.CRITICAL].recheckEveryMs, 24 * 60 * 60 * 1000);
});

test('an unknown risk level throws instead of quietly becoming a default', () => {
  // A typo that silently produced the assistant bar for a payment agent is the
  // exact failure this product exists to catch.
  assert.throws(() => riskPolicy('PAYMENTS'), RangeError);
  assert.throws(() => riskPolicy(undefined), RangeError);
  assert.equal(DEFAULT_RISK_LEVEL, RISK.LOW, 'an unregistered agent gets the loosest bar, not the strictest');
});

test('the bar is a band and never a score', () => {
  // The whole point. Two runs with the same verdict and wildly different
  // scores must produce the same standing, because agents are allowed to vary.
  const at = (score) =>
    assessStanding({
      riskLevel: RISK.HIGH,
      verdict: 'RESILIENT',
      lastMeasuredAt: daysBefore(1),
      now: NOW,
      everQualified: true,
      score,
    });

  assert.equal(at(85).standing, STANDING.VALID);
  assert.equal(at(100).standing, STANDING.VALID);
  assert.deepEqual(at(85), at(100), 'nothing in a standing may depend on the raw score');
});

test('a payment agent that has always been PARTIAL never qualified, and that is not a revocation', () => {
  // Two different statements. This agent did not get worse; it was never good
  // enough for what it is registered as, and nothing was ever taken away.
  const result = assessStanding({
    riskLevel: RISK.HIGH,
    verdict: 'PARTIAL',
    certificateStatus: CERTIFICATE.VALID,
    everQualified: false,
    lastMeasuredAt: daysBefore(1),
    now: NOW,
  });

  assert.equal(result.standing, STANDING.NEVER_QUALIFIED);
  assert.notEqual(result.standing, STANDING.REVOKED);
  assert.equal(result.meetsMinimumBand, false);
  assert.match(result.reason, /nothing has been revoked/);
});

test('an agent that held the band and lost it is revoked, in those words', () => {
  const result = assessStanding({
    riskLevel: RISK.HIGH,
    verdict: 'PARTIAL',
    certificateStatus: CERTIFICATE.REVOKED,
    everQualified: true,
    lastMeasuredAt: daysBefore(1),
    now: NOW,
    revocationReason: 'Certificate revoked. The agent fell from RESILIENT to PARTIAL.',
  });

  assert.equal(result.standing, STANDING.REVOKED);
  assert.match(result.reason, /fell from RESILIENT/);
});

test('a fall by an agent that never qualified is not reported as a revocation', () => {
  // It did get worse, and drift.js says so. But there was no valid certificate
  // at this risk level to take away, so the certificate did not change hands.
  const result = assessStanding({
    riskLevel: RISK.CRITICAL,
    verdict: 'BRITTLE',
    certificateStatus: CERTIFICATE.REVOKED,
    everQualified: false,
    lastMeasuredAt: daysBefore(1),
    now: NOW,
  });

  assert.equal(result.standing, STANDING.NEVER_QUALIFIED);
  assert.match(result.reason, /It also got worse in this run/);
});

test('a certificate past its period is stale, which is not the same as revoked', () => {
  // Halflife failing to check on schedule is halflife's failure. The agent may
  // be perfectly fine; what expired is our knowledge of it.
  const result = assessStanding({
    riskLevel: RISK.LOW,
    verdict: 'RESILIENT',
    everQualified: true,
    lastMeasuredAt: daysBefore(31),
    now: NOW,
  });

  assert.equal(result.standing, STANDING.STALE);
  assert.notEqual(result.standing, STANDING.REVOKED);
  assert.equal(result.meetsMinimumBand, true, 'the agent still holds its band; only the check is overdue');
  assert.equal(result.stale, true);
  assert.match(result.reason, /gap in checking, not a finding about the agent/);
});

test('the period is the risk level, so the same age expires a payment agent and not an assistant', () => {
  const measured = { verdict: 'RESILIENT', everQualified: true, lastMeasuredAt: daysBefore(10), now: NOW };
  assert.equal(assessStanding({ riskLevel: RISK.LOW, ...measured }).standing, STANDING.VALID);
  assert.equal(assessStanding({ riskLevel: RISK.HIGH, ...measured }).standing, STANDING.STALE);
  assert.equal(assessStanding({ riskLevel: RISK.CRITICAL, ...measured }).standing, STANDING.STALE);
});

test('a certificate inside its period is valid and says when the next check is due', () => {
  const result = assessStanding({
    riskLevel: RISK.LOW,
    verdict: 'PARTIAL',
    everQualified: true,
    lastMeasuredAt: daysBefore(29),
    now: NOW,
  });

  assert.equal(result.standing, STANDING.VALID);
  assert.equal(result.stale, false);
  assert.equal(result.dueAt, new Date(Date.parse(daysBefore(29)) + 30 * 24 * 60 * 60 * 1000).toISOString());
  assert.equal(result.overdueByMs, 0);
});

test('an agent nothing has ever been measured for is not certified, and nothing has expired', () => {
  const result = assessStanding({ riskLevel: RISK.HIGH, verdict: null, now: NOW });
  assert.equal(result.standing, STANDING.NOT_CERTIFIED);
  assert.equal(result.stale, false, 'a certificate that was never issued cannot have expired');
  assert.match(result.reason, /says nothing about the agent/);
});

test('raising an agent risk level does not claim it ever met the higher bar', () => {
  // The record remembers which level a qualification was earned at. An
  // assistant promoted to payment work has not passed the payment bar.
  const record = {
    verdict: 'PARTIAL',
    certificateStatus: CERTIFICATE.VALID,
    certifiedAt: daysBefore(1),
    qualifiedForRiskLevel: RISK.LOW,
    riskLevel: RISK.HIGH,
  };

  assert.equal(assessRemembered(record, NOW).standing, STANDING.NEVER_QUALIFIED);
  assert.equal(assessRemembered({ ...record, riskLevel: RISK.LOW }, NOW).standing, STANDING.VALID);
});

test('the expiry clock runs from the last completed check, not the last attempt', () => {
  // Counting failed checks would let an unreachable StressProof keep every
  // certificate looking freshly checked forever.
  const record = {
    verdict: 'RESILIENT',
    certificateStatus: CERTIFICATE.VALID,
    certifiedAt: daysBefore(40),
    lastCheckedAt: daysBefore(1),
    qualifiedForRiskLevel: RISK.LOW,
    riskLevel: RISK.LOW,
  };

  assert.equal(assessRemembered(record, NOW).standing, STANDING.STALE);
});

test('a bar is only ever cleared by holding the band or better', () => {
  assert.equal(meetsMinimumBand('RESILIENT', RISK.CRITICAL), true);
  assert.equal(meetsMinimumBand('PARTIAL', RISK.CRITICAL), false);
  assert.equal(meetsMinimumBand('PARTIAL', RISK.LOW), true);
  assert.equal(meetsMinimumBand('BRITTLE', RISK.LOW), false);
  assert.equal(meetsMinimumBand('INCONCLUSIVE', RISK.LOW), false);
  assert.equal(meetsMinimumBand(null, RISK.LOW), false);
});

test('staleness needs a clock supplied and never reads one', () => {
  assert.throws(() => staleness({ level: RISK.LOW, lastMeasuredAt: NOW }), TypeError);
});

test('a timestamp that cannot be read is treated as overdue, not as fresh', () => {
  // Staleness is not an accusation, so erring toward "we no longer know" costs
  // the agent nothing. Claiming freshness we cannot demonstrate would cost
  // everything.
  const result = staleness({ level: RISK.LOW, lastMeasuredAt: 'sometime last year', now: NOW });
  assert.equal(result.stale, true);
});
