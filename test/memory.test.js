import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Memory, MemoryUnavailableError } from '../src/lib/memory.js';

let dir;
let dbPath;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'halflife-test-'));
  dbPath = path.join(dir, 'memory.db');
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

test('an agent never seen before recalls as null, not as an error', async () => {
  const memory = new Memory({ dbPath });
  try {
    assert.equal(await memory.recallCertification('never-seen.example'), null);
  } finally {
    await memory.close();
  }
});

test('a certification written now is recalled in the same session', async () => {
  const memory = new Memory({ dbPath });
  try {
    await memory.rememberCertification('agent-a.example', {
      verdict: 'RESILIENT',
      score: 92,
      certificateStatus: 'valid',
    });

    const recalled = await memory.recallCertification('agent-a.example');
    assert.equal(recalled.verdict, 'RESILIENT');
    assert.equal(recalled.score, 92);
    assert.equal(recalled.certificateStatus, 'valid');
  } finally {
    await memory.close();
  }
});

// This is the gate. A fresh process, with nothing carried over in variables,
// has to recall what an earlier process wrote. If this test ever fails,
// halflife has no product.
test('cold start: a brand new process recalls what an earlier one wrote', async () => {
  const first = new Memory({ dbPath });
  await first.rememberCertification('agent-b.example', {
    verdict: 'RESILIENT',
    score: 88,
    certificateStatus: 'valid',
  });
  await first.close();

  const second = new Memory({ dbPath });
  try {
    const recalled = await second.recallCertification('agent-b.example');
    assert.ok(recalled, 'a restarted halflife must still know this agent');
    assert.equal(recalled.verdict, 'RESILIENT');
    assert.equal(recalled.score, 88);
  } finally {
    await second.close();
  }
});

test('re-certifying overwrites the standing record but keeps the journal', async () => {
  const memory = new Memory({ dbPath });
  try {
    await memory.rememberCertification('agent-c.example', {
      verdict: 'RESILIENT',
      score: 90,
      certificateStatus: 'valid',
    });
    await memory.recordRun('certified agent-c.example RESILIENT 90');

    await memory.rememberCertification('agent-c.example', {
      verdict: 'BRITTLE',
      score: 41,
      certificateStatus: 'revoked',
    });
    await memory.recordRun('re-certified agent-c.example BRITTLE 41, certificate revoked');

    const standing = await memory.recallCertification('agent-c.example');
    assert.equal(standing.verdict, 'BRITTLE', 'standing shows only the latest verdict');
    assert.equal(standing.certificateStatus, 'revoked');

    const history = await memory.readRunHistory(10);
    const lines = history.flatMap((event) => event.acted ?? []);
    assert.ok(
      lines.some((line) => line.includes('RESILIENT 90')),
      'the journal still holds the earlier verdict the standing record overwrote',
    );
    assert.ok(lines.some((line) => line.includes('BRITTLE 41')));
  } finally {
    await memory.close();
  }
});

test('the registry finds an agent halflife has certified', async () => {
  const memory = new Memory({ dbPath });
  try {
    await memory.rememberCertification('findable.example', {
      verdict: 'PARTIAL',
      score: 70,
      certificateStatus: 'valid',
    });

    const found = await memory.searchRegistry('findable.example');
    assert.ok(Array.isArray(found));
    assert.ok(
      found.some((entity) => entity.name === 'findable.example'),
      'a certified agent must be discoverable in the registry',
    );
  } finally {
    await memory.close();
  }
});

// Memory is load-bearing, so an unreachable memory has to be loud. A default
// answer here would mean halflife reporting "nothing has changed" about an
// agent it cannot actually remember.
test('an unreachable memory throws rather than quietly returning a default', async () => {
  const memory = new Memory({ dbPath, python: 'definitely-not-a-real-python-binary' });
  try {
    await assert.rejects(
      () => memory.recallCertification('agent-a.example'),
      (error) => {
        assert.ok(error instanceof MemoryUnavailableError, `got ${error.name}`);
        return true;
      },
    );
  } finally {
    await memory.close();
  }
});
