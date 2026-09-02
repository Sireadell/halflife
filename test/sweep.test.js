import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Memory } from '../src/lib/memory.js';
import { Registry } from '../src/lib/registry.js';
import { Certifier } from '../src/lib/certifier.js';
import { sweepDue, startSweeper } from '../src/lib/sweep.js';
import { RISK, STANDING } from '../src/lib/risk.js';

let dir;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'halflife-sweep-test-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const report = (verdict, score) => ({
  id: 'report-id',
  report: { verdict, score, silentWrongCount: 0, probesCompleted: 12 },
  certificate: { reportHash: '0xabc' },
});

function recordingStressProof(reply) {
  const calls = [];
  return {
    calls,
    async certify(request) {
      calls.push(request);
      return typeof reply === 'function' ? reply(request) : reply;
    },
  };
}

// A database per test. The sweep acts on every agent in the registry at once,
// so a database shared between tests would have one test's leftovers swept by
// the next one and the assertions would be about the wrong agents.
let dbCounter = 0;
async function withMemory(fn) {
  const memory = new Memory({ dbPath: path.join(dir, `memory-${dbCounter++}.db`) });
  try {
    return await fn(memory);
  } finally {
    await memory.close();
  }
}

test('the sweep re-checks an expired certificate using the request that was registered', async () => {
  await withMemory(async (memory) => {
    const target = 'swept.example';
    const stressproof = recordingStressProof(report('RESILIENT', 90));

    const first = new Certifier({ memory, stressproof, clock: () => '2026-01-01T00:00:00.000Z' });
    await first.registerRiskLevel(target, RISK.CRITICAL, { check: { sampleBody: { q: 'ping' } } });
    await first.certify(target, { sampleBody: { q: 'ping' } });

    // A day and a half later a CRITICAL agent is overdue.
    const now = '2026-01-02T12:00:00.000Z';
    const registry = new Registry({ memory, clock: () => now });
    assert.equal((await registry.standingOf(target)).standing, STANDING.STALE);

    const certifier = new Certifier({ memory, stressproof, clock: () => now });
    const result = await sweepDue({ registry, certifier });

    assert.equal(result.checked.length, 1);
    assert.equal(result.checked[0].target, target);
    assert.equal(result.checked[0].standing, STANDING.VALID, 'a fresh check makes it current again');
    assert.deepEqual(
      stressproof.calls.at(-1).sampleBody,
      { q: 'ping' },
      'the sweep sends what was registered rather than something it made up',
    );
  });
});

test('an agent with no registered request is skipped and the reason is said, not guessed around', async () => {
  await withMemory(async (memory) => {
    const target = 'unswepable.example';
    const stressproof = recordingStressProof(report('RESILIENT', 90));

    const first = new Certifier({ memory, stressproof, clock: () => '2026-02-01T00:00:00.000Z' });
    await first.registerRiskLevel(target, RISK.CRITICAL);
    await first.certify(target, { sampleBody: { q: 'ping' } });
    const callsBefore = stressproof.calls.length;

    const now = '2026-02-03T00:00:00.000Z';
    const registry = new Registry({ memory, clock: () => now });
    const certifier = new Certifier({ memory, stressproof, clock: () => now });
    const result = await sweepDue({ registry, certifier });

    const skipped = result.skipped.find((entry) => entry.target === target);
    assert.ok(skipped, 'it must appear as skipped rather than silently vanish');
    assert.match(skipped.reason, /no re-check request is registered/);
    assert.equal(stressproof.calls.length, callsBefore, 'nothing was sent to the agent');
    assert.equal(
      (await registry.standingOf(target)).standing,
      STANDING.STALE,
      'and it stays stale, which is honest: halflife still does not know',
    );
  });
});

test('one agent failing its check does not stop the rest of the sweep', async () => {
  await withMemory(async (memory) => {
    const now = '2026-03-10T00:00:00.000Z';
    const stressproof = {
      async certify(request) {
        if (request.targetUrl === 'broken.example') throw new Error('connection refused');
        return report('RESILIENT', 88);
      },
    };

    const setup = new Certifier({ memory, stressproof, clock: () => '2026-03-01T00:00:00.000Z' });
    for (const target of ['broken.example', 'fine.example']) {
      await setup.registerRiskLevel(target, RISK.CRITICAL, { check: { sampleBody: { q: 1 } } });
      await setup.certify(target, { sampleBody: { q: 1 } }).catch(() => {});
    }

    const registry = new Registry({ memory, clock: () => now });
    const certifier = new Certifier({ memory, stressproof, clock: () => now });
    const result = await sweepDue({ registry, certifier });

    const fine = result.checked.find((entry) => entry.target === 'fine.example');
    assert.ok(fine, 'the healthy agent was still re-checked');
    assert.equal(fine.measured, true);

    const broken = result.checked.find((entry) => entry.target === 'broken.example');
    assert.ok(broken, 'the failed check is reported, not swallowed');
    assert.equal(broken.measured, false);
    // Worded as a failure to check rather than as a finding, whether it is the
    // agent's first check or its fiftieth.
    assert.match(broken.journalLine, /could not be (checked|completed)/);
    assert.equal(broken.standing, STANDING.NOT_CERTIFIED);
  });
});

test('the sweeper is off unless an interval is configured', () => {
  // A background job that spends money must not start because something was
  // deployed. Nothing to stop means nothing was started.
  const off = startSweeper({ registry: {}, certifier: {}, intervalMs: undefined });
  assert.equal(off.running, false);
  off.stop();

  const alsoOff = startSweeper({ registry: {}, certifier: {}, intervalMs: 0 });
  assert.equal(alsoOff.running, false);
  alsoOff.stop();

  const on = startSweeper({ registry: {}, certifier: {}, intervalMs: 60_000 });
  assert.equal(on.running, true);
  on.stop();
});
