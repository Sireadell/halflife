import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Memory } from '../src/lib/memory.js';
import { Registry } from '../src/lib/registry.js';
import { Certifier } from '../src/lib/certifier.js';
import { RISK, STANDING } from '../src/lib/risk.js';

let dir;
let dbPath;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'halflife-registry-test-'));
  dbPath = path.join(dir, 'memory.db');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const DAY_MS = 24 * 60 * 60 * 1000;

function fakeStressProof(...replies) {
  return {
    async certify() {
      const reply = replies.shift();
      if (reply === undefined) throw new Error('fake StressProof ran out of replies');
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

const report = (verdict, score, extra = {}) => ({
  id: 'report-id',
  report: { verdict, score, silentWrongCount: 0, probesCompleted: 12, ...extra },
  certificate: { reportHash: '0xfeedface' },
});

async function withMemory(fn) {
  const memory = new Memory({ dbPath });
  try {
    return await fn(memory);
  } finally {
    await memory.close();
  }
}

// THE TEST THIS FILE EXISTS FOR.
//
// A certificate written as valid must not still read as valid once its period
// has run out, even though nothing was written in between. If this ever fails,
// halflife is a service that hands out certificates and never expires them,
// which is the exact thing it says other people's certificates do wrong.
test('a certificate goes stale on the clock alone, with nothing rewritten', async () => {
  await withMemory(async (memory) => {
    const target = 'clock.example';
    const certifiedAt = '2026-01-01T00:00:00.000Z';

    const certifier = new Certifier({
      memory,
      stressproof: fakeStressProof(report('RESILIENT', 91)),
      clock: () => certifiedAt,
    });
    await certifier.registerRiskLevel(target, RISK.HIGH);
    const run = await certifier.certify(target);
    assert.equal(run.standing, STANDING.VALID, 'it was valid at the moment it was checked');

    const stored = await memory.recallCertification(target);
    assert.equal(stored.standing, STANDING.VALID, 'and the stored word still says valid');

    // Six days later: inside the seven day period for a HIGH risk agent.
    const soon = new Registry({ memory, clock: () => '2026-01-07T00:00:00.000Z' });
    assert.equal((await soon.standingOf(target)).standing, STANDING.VALID);

    // Thirty days later. Nobody wrote anything, nobody re-checked, and the
    // stored record still says valid. The answer must not.
    const later = new Registry({ memory, clock: () => '2026-01-31T00:00:00.000Z' });
    const late = await later.standingOf(target);
    assert.equal(late.standing, STANDING.STALE);
    assert.equal(late.stale, true);
    assert.ok(late.overdueByMs > 0);
    assert.match(late.standingReason, /gap in checking, not a finding about the agent/);

    const unchanged = await memory.recallCertification(target);
    assert.equal(unchanged.standing, STANDING.VALID, 'reading did not rewrite anything');
  });
});

test('the risk level a read is judged against is the registered one, not the one on the certificate', async () => {
  await withMemory(async (memory) => {
    const target = 'promoted.example';
    const certifier = new Certifier({
      memory,
      stressproof: fakeStressProof(report('RESILIENT', 95)),
      clock: () => '2026-02-01T00:00:00.000Z',
    });

    await certifier.registerRiskLevel(target, RISK.LOW);
    await certifier.certify(target);

    // Ten days on, a LOW agent is still inside its 30 day period.
    const asLow = new Registry({ memory, clock: () => '2026-02-11T00:00:00.000Z' });
    assert.equal((await asLow.standingOf(target)).standing, STANDING.VALID);

    // Moved to CRITICAL, which is a daily re-check. Nothing else changed.
    await certifier.registerRiskLevel(target, RISK.CRITICAL);

    const asCritical = new Registry({ memory, clock: () => '2026-02-11T00:00:00.000Z' });
    const now = await asCritical.standingOf(target);
    assert.equal(now.riskLevel, RISK.CRITICAL);
    assert.equal(now.standing, STANDING.STALE, 'a daily agent last checked ten days ago is overdue');
    assert.equal(
      now.certificate.judgedAtRiskLevel,
      RISK.LOW,
      'the certificate keeps the level it was actually judged under',
    );
  });
});

test('an agent nobody ever certified reads as not_certified, which is not a revocation', async () => {
  await withMemory(async (memory) => {
    const registry = new Registry({ memory, clock: () => '2026-03-01T00:00:00.000Z' });
    const standing = await registry.standingOf('stranger.example');

    assert.equal(standing.standing, STANDING.NOT_CERTIFIED);
    assert.equal(standing.certificate, null);
    assert.equal(standing.registered, false);
    assert.equal(standing.stale, false, 'nothing was ever issued, so nothing has expired');
  });
});

test('the registry lists an agent that was registered and never successfully checked', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({
      memory,
      stressproof: fakeStressProof(),
      clock: () => '2026-04-01T00:00:00.000Z',
    });
    await certifier.registerRiskLevel('watched.example', RISK.HIGH, {
      check: { sampleBody: { q: 'hello' } },
    });

    const registry = new Registry({ memory, clock: () => '2026-04-02T00:00:00.000Z' });
    const { agents } = await registry.list();
    const found = agents.find((agent) => agent.target === 'watched.example');

    assert.ok(found, 'an agent halflife promised to watch and has not checked must be visible');
    assert.equal(found.standing, STANDING.NOT_CERTIFIED);
    assert.equal(found.registered, true);
    assert.deepEqual(found.checkRequest, { sampleBody: { q: 'hello' } });
  });
});

test('a registered re-check request never stores auth headers', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({ memory, stressproof: fakeStressProof(), clock: () => '2026-04-01T00:00:00.000Z' });
    await certifier.registerRiskLevel('secrets.example', RISK.LOW, {
      check: { method: 'post', sampleBody: { q: 1 }, authHeaders: { authorization: 'Bearer hunter2' } },
    });

    const stored = await certifier.checkRequestFor('secrets.example');
    assert.deepEqual(stored, { method: 'POST', sampleBody: { q: 1 } });
    assert.equal(JSON.stringify(stored).includes('hunter2'), false, 'a credential must not be persisted');
  });
});

test('due lists the overdue and looks forward when asked to', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({
      memory,
      stressproof: fakeStressProof(report('RESILIENT', 90)),
      clock: () => '2026-05-01T00:00:00.000Z',
    });
    await certifier.registerRiskLevel('soon.example', RISK.HIGH, { check: { sampleBody: { q: 1 } } });
    await certifier.certify('soon.example');

    // Five days on: due in two, not overdue.
    const registry = new Registry({ memory, clock: () => '2026-05-06T00:00:00.000Z' });
    const now = await registry.due();
    assert.equal(now.due.some((agent) => agent.target === 'soon.example'), false);

    const ahead = await registry.due({ withinMs: 3 * DAY_MS });
    assert.equal(ahead.due.some((agent) => agent.target === 'soon.example'), true);
  });
});

test('the journal for one agent carries the lines that were written about it', async () => {
  await withMemory(async (memory) => {
    const certifier = new Certifier({
      memory,
      stressproof: fakeStressProof(report('RESILIENT', 90), report('BRITTLE', 40)),
      clock: () => '2026-06-01T00:00:00.000Z',
    });
    await certifier.certify('history.example');
    await certifier.certify('history.example');
    await certifier.certify('other.example').catch(() => {});

    const registry = new Registry({ memory, clock: () => '2026-06-02T00:00:00.000Z' });
    const journal = await registry.journalOf('history.example', { limit: 10 });
    const text = journal.entries.flatMap((entry) => entry.lines).join('\n');

    assert.match(text, /certified for the first time at RESILIENT 90/);
    assert.match(text, /fell from RESILIENT to BRITTLE 40/);
    assert.equal(text.includes('other.example'), false, 'one agent\'s page must not show another\'s history');
  });
});
