import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Memory, MemoryUnavailableError } from '../src/lib/memory.js';
import { Registry } from '../src/lib/registry.js';
import { Certifier } from '../src/lib/certifier.js';
import { answerStandingJob, targetOfJob, resolveAcpConfig, createAcpService, AcpJobRefused } from '../src/lib/acp.js';
import { RISK, STANDING } from '../src/lib/risk.js';

// WHAT THESE TESTS DO AND DO NOT PROVE.
//
// They prove every decision halflife makes when a job arrives: which agent is
// being asked about, which of the five standings comes back, and when a job is
// refused rather than answered. That is the whole of halflife's side of the
// integration.
//
// They do not prove that a job ever arrives. Halflife has no registered agent
// profile on Virtuals ACP, so the live adapter has never run against the real
// network and is not claimed to work. The one thing tested about it is that it
// refuses loudly instead of pretending, which is the behaviour that matters
// while it is unregistered.

let dir;
let dbPath;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'halflife-acp-test-'));
  dbPath = path.join(dir, 'memory.db');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const report = (verdict, score) => ({
  id: 'report-id',
  report: { verdict, score, silentWrongCount: 0, probesCompleted: 12 },
  certificate: { reportHash: '0xabc' },
});

const stressproof = (...replies) => ({
  async certify() {
    const reply = replies.shift();
    if (reply instanceof Error) throw reply;
    return reply;
  },
});

async function withMemory(fn) {
  const memory = new Memory({ dbPath });
  try {
    return await fn(memory);
  } finally {
    await memory.close();
  }
}

test('the agent being asked about is read out of whichever shape the job carries it in', () => {
  assert.equal(targetOfJob({ serviceRequirement: { target: 'a.example' } }), 'a.example');
  assert.equal(targetOfJob({ serviceRequirement: '{"agent":"b.example"}' }), 'b.example');
  assert.equal(targetOfJob({ serviceRequirement: 'c.example' }), 'c.example');
  assert.equal(targetOfJob({ target: 'd.example' }), 'd.example');
  assert.equal(targetOfJob({ serviceRequirement: {} }), null);
});

test('a job about a revoked agent is answered as revoked, in words a buyer can act on', async () => {
  await withMemory(async (memory) => {
    const target = 'fell.example';
    const certifier = new Certifier({
      memory,
      stressproof: stressproof(report('RESILIENT', 90), report('BRITTLE', 30)),
      clock: () => '2026-07-01T00:00:00.000Z',
    });
    await certifier.registerRiskLevel(target, RISK.LOW);
    await certifier.certify(target);
    await certifier.certify(target);

    const registry = new Registry({ memory, clock: () => '2026-07-02T00:00:00.000Z' });
    const answer = await answerStandingJob({
      registry,
      job: { serviceRequirement: { target } },
      clock: () => '2026-07-02T00:00:00.000Z',
    });

    assert.equal(answer.standing, STANDING.REVOKED);
    assert.match(answer.meaning, /It got worse/);
    assert.equal(answer.freshTestRun, false, 'the job answers about the certificate on file, and says so');
    // The one thing this deliverable must never be.
    assert.equal(Object.hasOwn(answer, 'trustworthy'), false);
    assert.equal(Object.hasOwn(answer, 'ok'), false);
  });
});

test('a job about an agent halflife has never seen is answered, not failed', async () => {
  await withMemory(async (memory) => {
    const registry = new Registry({ memory, clock: () => '2026-07-03T00:00:00.000Z' });
    const answer = await answerStandingJob({ registry, job: { serviceRequirement: { target: 'nobody.example' } } });

    // "I have never checked this agent" is a useful answer to a buyer, and it
    // is a completely different answer from "its certificate was revoked".
    assert.equal(answer.standing, STANDING.NOT_CERTIFIED);
    assert.match(answer.meaning, /never completed a check/);
    assert.equal(answer.verdict, null);
  });
});

test('a stale certificate is answered as halflife failing to check, not as the agent failing', async () => {
  await withMemory(async (memory) => {
    const target = 'aged.example';
    const certifier = new Certifier({
      memory,
      stressproof: stressproof(report('RESILIENT', 95)),
      clock: () => '2026-08-01T00:00:00.000Z',
    });
    await certifier.registerRiskLevel(target, RISK.CRITICAL);
    await certifier.certify(target);

    const registry = new Registry({ memory, clock: () => '2026-08-20T00:00:00.000Z' });
    const answer = await answerStandingJob({ registry, job: { target } });

    assert.equal(answer.standing, STANDING.STALE);
    assert.match(answer.meaning, /halflife failing to check, not a finding about the agent/);
    assert.equal(answer.verdict, 'RESILIENT', 'what was last measured is still reported, with its date');
    assert.equal(answer.certifiedAt, '2026-08-01T00:00:00.000Z');
  });
});

test('a job that names no agent is refused rather than answered about nothing', async () => {
  await withMemory(async (memory) => {
    const registry = new Registry({ memory });
    await assert.rejects(
      () => answerStandingJob({ registry, job: { serviceRequirement: { note: 'hello' } } }),
      (error) => error instanceof AcpJobRefused && error.retryable === false,
    );
  });
});

// The one that matters most on this route. A buyer is paying for an answer, and
// an answer produced by a broken database is worse than no answer at all.
test('a job asked while memory is unreachable is refused, never answered with a default', async () => {
  const broken = {
    async standingOf() {
      throw new MemoryUnavailableError('memory bridge stopped');
    },
  };

  await assert.rejects(
    () => answerStandingJob({ registry: broken, job: { target: 'anything.example' } }),
    (error) => {
      assert.ok(error instanceof AcpJobRefused);
      assert.equal(error.retryable, true, 'halflife\'s outage is not the buyer\'s mistake');
      assert.match(error.message, /cannot reach its own memory/);
      return true;
    },
  );
});

test('the ACP configuration refuses by name rather than defaulting', () => {
  const none = resolveAcpConfig({});
  assert.equal(none.ok, false);
  assert.deepEqual(none.missing.sort(), [
    'HALFLIFE_ACP_AGENT_WALLET_ADDRESS',
    'HALFLIFE_ACP_ENTITY_ID',
    'HALFLIFE_ACP_PRIVATE_KEY',
  ]);

  const bad = resolveAcpConfig({
    HALFLIFE_ACP_AGENT_WALLET_ADDRESS: '0x1',
    HALFLIFE_ACP_PRIVATE_KEY: 'not-a-real-key',
    HALFLIFE_ACP_ENTITY_ID: 'twelve',
  });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /HALFLIFE_ACP_ENTITY_ID/);
});

test('with no configuration the ACP service stays off and says why, without touching a network', async () => {
  const service = await createAcpService({
    registry: {},
    env: {},
    loadSdk: () => {
      throw new Error('the test suite must never load the ACP SDK');
    },
  });

  assert.equal(service.enabled, false);
  assert.match(service.reason, /not connected to Virtuals ACP/);
});

test('an SDK that does not look like the one this adapter was written against is refused, not guessed at', async () => {
  const service = await createAcpService({
    registry: {},
    env: {
      HALFLIFE_ACP_AGENT_WALLET_ADDRESS: '0xa0b1c2d3e4f5060708090a0b0c0d0e0f10111213',
      HALFLIFE_ACP_PRIVATE_KEY: 'test-only-not-a-real-key',
      HALFLIFE_ACP_ENTITY_ID: '42',
    },
    // A beta SDK whose method names have moved. Accepting jobs against an API
    // halflife cannot actually deliver through would mean a buyer paying for
    // nothing, which is worse than being visibly off.
    loadSdk: async () => ({ somethingElse: true }),
  });

  assert.equal(service.enabled, false);
  assert.match(service.reason, /Refusing to guess/);
});
