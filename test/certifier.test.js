import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Memory, MemoryUnavailableError } from '../src/lib/memory.js';
import { Certifier, normaliseReport } from '../src/lib/certifier.js';
import { DRIFT, CERTIFICATE, INCONCLUSIVE } from '../src/lib/drift.js';
import { RISK, STANDING } from '../src/lib/risk.js';

let dir;
let dbPath;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'halflife-certifier-test-'));
  dbPath = path.join(dir, 'memory.db');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

/**
 * A StressProof that never touches the network. Each entry is either a report
 * to hand back or an Error to throw, so an outage is expressed the same way the
 * real client expresses one.
 */
function fakeStressProof(...replies) {
  const calls = [];
  return {
    calls,
    async certify(request) {
      calls.push(request);
      const reply = replies.shift();
      if (reply === undefined) throw new Error('fake StressProof ran out of replies');
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

const report = (verdict, score, extra = {}) => ({
  id: 'report-id',
  report: { target: 'agent', verdict, score, silentWrongCount: 0, probesCompleted: 8, ...extra },
  certificate: { reportHash: '0xdeadbeef' },
});

async function withMemory(fn) {
  const memory = new Memory({ dbPath });
  try {
    return await fn(memory);
  } finally {
    await memory.close();
  }
}

test('an agent never seen before is certified and remembered', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({ memory, stressproof: fakeStressProof(report('RESILIENT', 92)) });
    const result = await certifier.certify('first.example');

    assert.equal(result.drift, DRIFT.FIRST_CERTIFICATION);
    assert.equal(result.certificateStatus, CERTIFICATE.VALID);
    assert.equal(result.previousVerdict, null);
    assert.equal(result.revoked, false);
    assert.match(result.journalLine, /certified for the first time at RESILIENT 92/);

    const standing = await memory.recallCertification('first.example');
    assert.equal(standing.verdict, 'RESILIENT');
    assert.equal(standing.score, 92);
    assert.equal(standing.certificateStatus, CERTIFICATE.VALID);
    assert.equal(standing.reportHash, '0xdeadbeef');
  });
});

test('an agent that has not moved keeps its certificate and says so', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({
      memory,
      stressproof: fakeStressProof(report('RESILIENT', 90), report('RESILIENT', 87)),
    });

    await certifier.certify('unchanged.example');
    const second = await certifier.certify('unchanged.example');

    assert.equal(second.drift, DRIFT.UNCHANGED);
    assert.equal(second.certificateStatus, CERTIFICATE.VALID);
    assert.equal(second.scoreDelta, -3);
    assert.equal(second.revoked, false);
    assert.match(second.journalLine, /still RESILIENT 87/);
  });
});

test('an agent that improves is re-certified upward', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({
      memory,
      stressproof: fakeStressProof(report('PARTIAL', 70), report('RESILIENT', 91)),
    });

    await certifier.certify('improved.example');
    const second = await certifier.certify('improved.example');

    assert.equal(second.drift, DRIFT.IMPROVED);
    assert.equal(second.certificateStatus, CERTIFICATE.VALID);
    assert.equal(second.scoreDelta, 21);
    assert.match(second.journalLine, /improved from PARTIAL to RESILIENT 91/);

    const standing = await memory.recallCertification('improved.example');
    assert.equal(standing.verdict, 'RESILIENT');
  });
});

// The product in one test: the certificate issued in the first run does not
// survive the agent getting worse in the second.
test('an agent that gets worse has its certificate revoked and the journal keeps both runs', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({
      memory,
      stressproof: fakeStressProof(
        report('RESILIENT', 92),
        report('BRITTLE', 41, { silentWrongCount: 1 }),
      ),
    });

    await certifier.certify('dropped.example');
    const second = await certifier.certify('dropped.example');

    assert.equal(second.drift, DRIFT.REVOKED);
    assert.equal(second.certificateStatus, CERTIFICATE.REVOKED);
    assert.equal(second.revoked, true);
    assert.equal(second.scoreDelta, -51);

    const standing = await memory.recallCertification('dropped.example');
    assert.equal(standing.verdict, 'BRITTLE');
    assert.equal(standing.certificateStatus, CERTIFICATE.REVOKED);

    const lines = (await memory.readRunHistory(50)).flatMap((event) => event.acted ?? []);
    assert.ok(
      lines.some((line) => line.includes('dropped.example') && line.includes('RESILIENT 92')),
      'the journal still holds the run that issued the certificate',
    );
    assert.ok(
      lines.some((line) => line.includes('dropped.example') && line.includes('Certificate revoked')),
      'the journal says in words that the certificate was revoked',
    );
  });
});

// Halflife being unable to run a check is not a finding about the agent. If
// this ever revokes, halflife's own downtime is damaging its customers.
test('StressProof being unreachable never revokes and leaves the certificate alone', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({
      memory,
      stressproof: fakeStressProof(report('RESILIENT', 90), new Error('connect ECONNREFUSED')),
    });

    await certifier.certify('outage.example');
    const second = await certifier.certify('outage.example');

    assert.equal(second.drift, DRIFT.UNVERIFIABLE);
    assert.equal(second.certificateStatus, CERTIFICATE.VALID);
    assert.equal(second.revoked, false);
    assert.equal(second.measured, false);
    assert.equal(second.upstreamReached, false);
    assert.match(second.unmeasurableReason, /ECONNREFUSED/);
    assert.match(second.journalLine, /not as a finding about the agent/);
  });
});

// The subtle half of the rule above. A failed check must not erase the
// remembered verdict, because drift.js reads a remembered INCONCLUSIVE as
// "nothing to compare against" and would treat the next bad run as a clean
// first certification instead of a revocation.
test('a failed check does not erase the remembered verdict, so a later drop still revokes', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({
      memory,
      stressproof: fakeStressProof(
        report('RESILIENT', 92),
        new Error('gateway timeout'),
        report('BRITTLE', 38),
      ),
    });

    await certifier.certify('laundering.example');
    await certifier.certify('laundering.example');

    const afterOutage = await memory.recallCertification('laundering.example');
    assert.equal(afterOutage.verdict, 'RESILIENT', 'the outage must not overwrite the verdict');
    assert.equal(afterOutage.certificateStatus, CERTIFICATE.VALID);
    assert.match(afterOutage.lastCheckFailure, /gateway timeout/);

    const third = await certifier.certify('laundering.example');
    assert.equal(third.drift, DRIFT.REVOKED);
    assert.equal(third.previousVerdict, 'RESILIENT');
    assert.equal(third.certificateStatus, CERTIFICATE.REVOKED);
  });
});

test('a first ever check that fails issues no certificate and invents no standing record', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({
      memory,
      stressproof: fakeStressProof(new Error('service unavailable')),
    });

    const result = await certifier.certify('never-reached.example');
    assert.equal(result.drift, DRIFT.FIRST_CERTIFICATION);
    assert.equal(result.revoked, false, 'nothing was taken away, there was never a certificate');
    assert.equal(
      await memory.recallCertification('never-reached.example'),
      null,
      'an agent halflife failed to check has not been certified',
    );

    const lines = (await memory.readRunHistory(50)).flatMap((event) => event.acted ?? []);
    assert.ok(lines.some((line) => line.includes('never-reached.example')));
  });
});

// Memory is load-bearing. It must reach the caller, and it must stop the run
// before halflife pays StressProof for an answer it could not store.
test('a memory failure propagates and no certification is bought', async () => {
  const memory = new Memory({ dbPath, python: 'definitely-not-a-real-python-binary' });
  const stressproof = fakeStressProof(report('RESILIENT', 90));
  try {
    await assert.rejects(
      () => new Certifier({ memory, stressproof }).certify('unreachable-memory.example'),
      (error) => {
        assert.ok(error instanceof MemoryUnavailableError, `got ${error.name}`);
        return true;
      },
    );
    assert.equal(stressproof.calls.length, 0, 'memory is read before any run is paid for');
  } finally {
    await memory.close();
  }
});

test('a report with no verdict is an unmeasurable run, not a zero score', () => {
  const normalised = normaliseReport({ id: 'x', report: { target: 'agent' }, certificate: null });
  assert.equal(normalised.verdict, INCONCLUSIVE);
  assert.equal(normalised.score, null, 'a missing score must not be read as zero');
  assert.equal(normalised.signed, false);
  assert.match(normalised.unmeasurableReason, /no verdict/);
});

test('a verdict halflife cannot rank is refused rather than guessed at', () => {
  const normalised = normaliseReport({ report: { verdict: 'EXCELLENT', score: 99 } });
  assert.equal(normalised.verdict, INCONCLUSIVE);
  assert.match(normalised.unmeasurableReason, /does not know how to rank/);
});

test('a bare report with no envelope is read the same as a wrapped one', () => {
  const normalised = normaliseReport({ verdict: 'partial', score: 71, silentWrongCount: 2 });
  assert.equal(normalised.verdict, 'PARTIAL');
  assert.equal(normalised.score, 71);
  assert.equal(normalised.silentWrongCount, 2);
});

test('the target is passed through to StressProof unchanged, with the caller extras', async () => {
  await withMemory(async (memory) => {
    const stressproof = fakeStressProof(report('PARTIAL', 66));
    const certifier = new Certifier({ memory, stressproof });
    await certifier.certify('passthrough.example', { sampleBody: { query: 'hello' } });

    assert.deepEqual(stressproof.calls[0], {
      targetUrl: 'passthrough.example',
      sampleBody: { query: 'hello' },
    });
  });
});

// ---------------------------------------------------------------------------
// Risk levels: the expiry clock, and the band an agent has to hold.
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;
const at = (day) => new Date(Date.parse('2026-01-01T00:00:00.000Z') + day * DAY_MS).toISOString();

/** A report carrying a test version, which is what StressProof now stamps. */
const versioned = (verdict, score, specVersion, extra = {}) =>
  report(verdict, score, { specVersion, ...extra });

test('a registered risk level is remembered and survives a restart', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({ memory, stressproof: fakeStressProof(), clock: () => at(0) });
    const registration = await certifier.registerRiskLevel('payments.example', RISK.HIGH);
    assert.equal(registration.changed, true);
    assert.equal(registration.riskLevel, RISK.HIGH);
  });

  await withMemory(async (memory) => {
    const certifier = new Certifier({ memory, stressproof: fakeStressProof() });
    assert.equal(await certifier.riskLevelOf('payments.example'), RISK.HIGH);
  });
});

test('an agent nobody registered is judged at the loosest level, not quietly registered', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({
      memory,
      stressproof: fakeStressProof(report('PARTIAL', 70)),
      clock: () => at(0),
    });
    const result = await certifier.certify('unregistered.example');

    assert.equal(result.riskLevel, RISK.LOW);
    assert.equal(result.standing, STANDING.VALID);
    assert.equal(
      await memory.recallRiskLevel('unregistered.example'),
      null,
      'certifying an agent must not register a risk level nobody chose',
    );
  });
});

test('changing a risk level is recorded as a change and leaves earlier history alone', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({
      memory,
      stressproof: fakeStressProof(report('RESILIENT', 91)),
      clock: () => at(0),
    });

    await certifier.registerRiskLevel('promoted.example', RISK.LOW);
    await certifier.certify('promoted.example');
    const change = await certifier.registerRiskLevel('promoted.example', RISK.CRITICAL);

    assert.equal(change.changed, true);
    assert.equal(change.previousRiskLevel, RISK.LOW);

    const lines = (await memory.readRunHistory(50)).flatMap((event) => event.acted ?? []);
    const mine = lines.filter((line) => line.includes('promoted.example'));
    assert.ok(mine.some((line) => /registered as LOW risk/.test(line)), 'the first registration is still there');
    assert.ok(mine.some((line) => /risk level changed from LOW to CRITICAL/.test(line)));
    assert.ok(
      mine.some((line) => /judged at LOW and are left as they were written/.test(line)),
      'the change must say plainly that it does not rewrite what came before',
    );
  });
});

test('re-registering the same risk level writes nothing', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({ memory, stressproof: fakeStressProof(), clock: () => at(0) });
    await certifier.registerRiskLevel('same.example', RISK.HIGH);
    const again = await certifier.registerRiskLevel('same.example', RISK.HIGH);
    assert.equal(again.changed, false);
    assert.equal(again.journalLine, null);
  });
});

test('a payment agent that has only ever been PARTIAL never qualified, and nothing is revoked', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({
      memory,
      stressproof: fakeStressProof(report('PARTIAL', 72)),
      clock: () => at(0),
    });
    await certifier.registerRiskLevel('weak-payments.example', RISK.HIGH);
    const result = await certifier.certify('weak-payments.example');

    assert.equal(result.standing, STANDING.NEVER_QUALIFIED);
    assert.equal(result.revoked, false, 'nothing valid was ever issued, so nothing was taken away');
    assert.equal(result.drift, DRIFT.FIRST_CERTIFICATION);
    assert.equal(result.meetsMinimumBand, false);
    assert.match(result.journalLine, /nothing has been revoked/);
  });
});

test('the same PARTIAL agent registered as low risk holds a valid certificate', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({
      memory,
      stressproof: fakeStressProof(report('PARTIAL', 72)),
      clock: () => at(0),
    });
    const result = await certifier.certify('assistant.example');

    assert.equal(result.standing, STANDING.VALID);
    assert.equal(result.minimumVerdict, 'PARTIAL');
    assert.equal(result.dueAt, at(30), 'a low risk agent is due again in 30 days');
  });
});

test('a certificate nobody managed to re-check in time expires without accusing the agent', async () => {
  await withMemory(async (memory) => {
    const good = new Certifier({
      memory,
      stressproof: fakeStressProof(report('RESILIENT', 93)),
      clock: () => at(0),
    });
    await good.registerRiskLevel('lapsed.example', RISK.HIGH);
    assert.equal((await good.certify('lapsed.example')).standing, STANDING.VALID);

    // Nine days later, and StressProof is down. A HIGH risk agent is due every
    // seven days, so the certificate expired while halflife failed to check.
    const later = new Certifier({
      memory,
      stressproof: fakeStressProof(new Error('service unavailable')),
      clock: () => at(9),
    });
    const result = await later.certify('lapsed.example');

    assert.equal(result.drift, DRIFT.UNVERIFIABLE);
    assert.equal(result.standing, STANDING.STALE);
    assert.equal(result.revoked, false, 'an expired certificate is not a revoked one');
    assert.equal(result.certificateStatus, CERTIFICATE.VALID, 'drift never touched the certificate');
    assert.match(result.journalLine, /Nothing here is a finding about the agent/);

    const standing = await memory.recallCertification('lapsed.example');
    assert.equal(standing.verdict, 'RESILIENT', 'the remembered verdict survives a failed check');
    assert.equal(standing.standing, STANDING.STALE);
  });
});

test('a result from a different test version is never compared with a fresh one', async () => {
  await withMemory(async (memory) => {
    const first = new Certifier({
      memory,
      stressproof: fakeStressProof(versioned('RESILIENT', 92, 'sp1-aaaaaaaaaaaa')),
      clock: () => at(0),
    });
    await first.certify('retested.example');

    // Same agent, worse verdict, but the test itself changed underneath it.
    const second = new Certifier({
      memory,
      stressproof: fakeStressProof(versioned('BRITTLE', 40, 'sp1-bbbbbbbbbbbb')),
      clock: () => at(1),
    });
    const result = await second.certify('retested.example');

    assert.equal(result.specVersionChanged, true);
    assert.equal(result.previousSpecVersion, 'sp1-aaaaaaaaaaaa');
    assert.equal(result.drift, DRIFT.FIRST_CERTIFICATION, 'a change of test is not a change of agent');
    assert.equal(result.revoked, false, 'revoking here would accuse an agent of what the test did');
    assert.equal(result.scoreDelta, null);
    assert.match(result.reason, /not like for like/);
    assert.match(result.journalLine, /says nothing about whether the agent changed/);

    const standing = await memory.recallCertification('retested.example');
    assert.equal(standing.verdict, 'BRITTLE', 'the new measurement is real and is written down');
    assert.equal(standing.specVersion, 'sp1-bbbbbbbbbbbb');
  });
});

test('a remembered result that predates version stamping is not compared either', async () => {
  await withMemory(async (memory) => {
    const first = new Certifier({
      memory,
      stressproof: fakeStressProof(report('RESILIENT', 92)),
      clock: () => at(0),
    });
    await first.certify('unstamped.example');

    const second = new Certifier({
      memory,
      stressproof: fakeStressProof(versioned('PARTIAL', 70, 'sp1-cccccccccccc')),
      clock: () => at(1),
    });
    const result = await second.certify('unstamped.example');

    assert.equal(result.specVersionChanged, true);
    assert.equal(result.revoked, false);
    assert.match(result.reason, /never recorded/);
  });
});

test('a change of test does not hand back a certificate that was revoked', async () => {
  await withMemory(async (memory) => {
    const run = (day, reply) =>
      new Certifier({ memory, stressproof: fakeStressProof(reply), clock: () => at(day) });

    await run(0, versioned('RESILIENT', 92, 'sp1-aaaaaaaaaaaa')).certify('fallen.example');
    const fell = await run(1, versioned('BRITTLE', 30, 'sp1-aaaaaaaaaaaa')).certify('fallen.example');
    assert.equal(fell.revoked, true);

    const retested = await run(2, versioned('RESILIENT', 95, 'sp1-bbbbbbbbbbbb')).certify('fallen.example');
    assert.equal(retested.specVersionChanged, true);
    assert.equal(
      retested.certificateStatus,
      CERTIFICATE.REVOKED,
      'standing returns on a demonstrated improvement, and none can be demonstrated across a test change',
    );
    assert.match(retested.reason, /stays revoked/);
  });
});

test('a failed check is not mistaken for a change of test version', async () => {
  await withMemory(async (memory) => {
    const first = new Certifier({
      memory,
      stressproof: fakeStressProof(versioned('RESILIENT', 92, 'sp1-aaaaaaaaaaaa')),
      clock: () => at(0),
    });
    await first.certify('outage.example');

    const second = new Certifier({
      memory,
      stressproof: fakeStressProof(new Error('connection refused')),
      clock: () => at(1),
    });
    const result = await second.certify('outage.example');

    assert.equal(result.specVersionChanged, false, 'a run that measured nothing makes no version claim');
    assert.equal(result.drift, DRIFT.UNVERIFIABLE);
    assert.equal(result.standing, STANDING.VALID, 'still inside its period, so the certificate stands');
  });
});
