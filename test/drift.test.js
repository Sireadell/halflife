import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  compareCertification,
  DRIFT,
  CERTIFICATE,
  INCONCLUSIVE,
} from '../src/lib/drift.js';

const cert = (verdict, score, extra = {}) => ({ verdict, score, ...extra });

test('an agent never certified before gets a certificate, not a comparison', () => {
  const result = compareCertification(null, cert('RESILIENT', 92));
  assert.equal(result.drift, DRIFT.FIRST_CERTIFICATION);
  assert.equal(result.certificateStatus, CERTIFICATE.VALID);
  assert.equal(result.previousVerdict, null);
  assert.equal(result.scoreDelta, null);
});

test('a first run that could not be measured issues no certificate', () => {
  const result = compareCertification(null, cert(INCONCLUSIVE, 0));
  assert.equal(result.drift, DRIFT.FIRST_CERTIFICATION);
  assert.equal(result.certificateStatus, CERTIFICATE.REVOKED);
});

test('a verdict falling revokes the certificate', () => {
  const result = compareCertification(
    cert('RESILIENT', 92, { certificateStatus: CERTIFICATE.VALID }),
    cert('BRITTLE', 41),
  );
  assert.equal(result.drift, DRIFT.REVOKED);
  assert.equal(result.certificateStatus, CERTIFICATE.REVOKED);
  assert.equal(result.scoreDelta, -51);
  assert.match(result.reason, /no longer true/);
});

test('an agent that starts lying is revoked, and the reason says so plainly', () => {
  const result = compareCertification(
    cert('RESILIENT', 90, { certificateStatus: CERTIFICATE.VALID, silentWrongCount: 0 }),
    cert('PARTIAL', 72, { silentWrongCount: 1 }),
  );
  assert.equal(result.drift, DRIFT.REVOKED);
  assert.match(result.reason, /success-shaped responses/);
});

// The whole product depends on this one. An agent that got no worse must never
// lose its certificate because a probe run happened to be unmeasurable.
test('an unmeasurable run never revokes and never touches the certificate', () => {
  const previous = cert('RESILIENT', 92, { certificateStatus: CERTIFICATE.VALID });
  const result = compareCertification(previous, cert(INCONCLUSIVE, 0));

  assert.equal(result.drift, DRIFT.UNVERIFIABLE);
  assert.equal(result.certificateStatus, CERTIFICATE.VALID);
  assert.match(result.reason, /not as a finding/);
});

test('an unmeasurable run does not quietly restore an already revoked certificate', () => {
  const previous = cert('BRITTLE', 30, { certificateStatus: CERTIFICATE.REVOKED });
  const result = compareCertification(previous, cert(INCONCLUSIVE, 0));

  assert.equal(result.drift, DRIFT.UNVERIFIABLE);
  assert.equal(result.certificateStatus, CERTIFICATE.REVOKED);
});

test('a score drop inside the same band is reported but does not revoke', () => {
  const result = compareCertification(
    cert('RESILIENT', 92, { certificateStatus: CERTIFICATE.VALID }),
    cert('RESILIENT', 86),
  );
  assert.equal(result.drift, DRIFT.UNCHANGED);
  assert.equal(result.certificateStatus, CERTIFICATE.VALID);
  assert.equal(result.scoreDelta, -6);
  assert.match(result.reason, /not on its own grounds/);
});

test('an agent that improves gets a new certificate', () => {
  const result = compareCertification(
    cert('PARTIAL', 70, { certificateStatus: CERTIFICATE.VALID }),
    cert('RESILIENT', 88),
  );
  assert.equal(result.drift, DRIFT.IMPROVED);
  assert.equal(result.certificateStatus, CERTIFICATE.VALID);
  assert.equal(result.scoreDelta, 18);
});

test('a revoked certificate is restored only by a genuine improvement', () => {
  const stillBad = compareCertification(
    cert('BRITTLE', 40, { certificateStatus: CERTIFICATE.REVOKED }),
    cert('BRITTLE', 44),
  );
  assert.equal(stillBad.drift, DRIFT.UNCHANGED);
  assert.equal(
    stillBad.certificateStatus,
    CERTIFICATE.REVOKED,
    'holding the same bad verdict must not hand the certificate back',
  );

  const recovered = compareCertification(
    cert('BRITTLE', 40, { certificateStatus: CERTIFICATE.REVOKED }),
    cert('RESILIENT', 90),
  );
  assert.equal(recovered.drift, DRIFT.IMPROVED);
  assert.equal(recovered.certificateStatus, CERTIFICATE.VALID);
});

test('an earlier unmeasurable run is not treated as a verdict to fall from', () => {
  const result = compareCertification(
    cert(INCONCLUSIVE, 0, { certificateStatus: CERTIFICATE.REVOKED }),
    cert('BRITTLE', 44),
  );
  assert.equal(result.drift, DRIFT.FIRST_CERTIFICATION);
  assert.equal(
    result.certificateStatus,
    CERTIFICATE.VALID,
    'BRITTLE is a real verdict and earns a real certificate, even a poor one',
  );
});

test('an unknown verdict is refused rather than ranked by guess', () => {
  assert.throws(
    () => compareCertification(cert('RESILIENT', 90), cert('EXCELLENT', 99)),
    /unknown verdict/,
  );
});
