import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Memory, MemoryUnavailableError } from '../src/lib/memory.js';
import { Registry } from '../src/lib/registry.js';
import { Certifier } from '../src/lib/certifier.js';
import { createApp, CERTIFICATION } from '../src/expressApp.js';
import { RISK, STANDING } from '../src/lib/risk.js';

let dir;

before(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'halflife-http-test-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

const report = (verdict, score) => ({
  id: 'report-id',
  report: { verdict, score, silentWrongCount: 0, probesCompleted: 12, specVersion: 'spec-1' },
  certificate: { reportHash: '0xabc' },
});

const stressproof = (...replies) => ({
  async certify() {
    const reply = replies.shift();
    if (reply === undefined) throw new Error('fake StressProof ran out of replies');
    if (reply instanceof Error) throw reply;
    return reply;
  },
});

/**
 * Start the real app on a real port and talk to it over HTTP.
 *
 * Not a supertest-style shortcut, because what is being checked includes status
 * codes and JSON bodies as a caller actually receives them. A database per test
 * for the same reason the sweep tests use one: the registry answers about
 * everything at once.
 */
let counter = 0;
async function withApp(
  {
    replies = [],
    now = '2026-09-01T00:00:00.000Z',
    certification,
    arcClients = null,
    arcConfigReason = null,
    paidArcDemoGate,
    certifyOnArcFn,
    arcDemoResultStore,
    arcProofVerifier,
  } = {},
  fn,
) {
  const memory = new Memory({ dbPath: path.join(dir, `memory-${counter++}.db`) });
  const clock = typeof now === 'function' ? now : () => now;
  const certifier = new Certifier({ memory, stressproof: stressproof(...replies), clock });
  const registry = new Registry({ memory, clock });
  const app = createApp({
    certifier,
    registry,
    memory,
    clock,
    certification,
    env: {},
    arcClients,
    arcConfigReason,
    ...(paidArcDemoGate ? { paidArcDemoGate } : {}),
    ...(certifyOnArcFn ? { certifyOnArcFn } : {}),
    ...(arcDemoResultStore ? { arcDemoResultStore } : {}),
    ...(arcProofVerifier ? { arcProofVerifier } : {}),
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, route, body) => {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: body
        ? { 'content-type': 'application/json', accept: 'application/json' }
        : { accept: 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json() };
  };

  try {
    return await fn({ call, base, memory, certifier, registry });
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await memory.close();
  }
}

test('/about says what this deployment is and is not configured to do', async () => {
  await withApp({}, async ({ call }) => {
    const { status, body } = await call('GET', '/about');
    assert.equal(status, 200);
    assert.equal(body.product, 'Halflife');
    assert.deepEqual(body.standings.values.sort(), [
      'never_qualified',
      'not_certified',
      'revoked',
      'stale',
      'valid',
    ]);
    // No settled payment and no live ACP registration is claimed anywhere.
    assert.equal(body.payment.configured, false);
    assert.equal(body.payment.settledPaymentsClaimed, 0);
    assert.equal(body.arcPaidDemo.payment.enabled, false);
    assert.equal(body.acp.connected, false);
    assert.equal(body.memory.reachable, true, 'the memory status is probed, not assumed');
  });
});

test('registering an agent stores the level and does not certify it', async () => {
  await withApp({}, async ({ call }) => {
    const registered = await call('POST', '/agents', {
      target: 'new.example',
      riskLevel: 'HIGH',
      check: { sampleBody: { q: 'ping' } },
    });

    assert.equal(registered.status, 201);
    assert.equal(registered.body.riskLevel, RISK.HIGH);
    assert.equal(registered.body.standing, STANDING.NOT_CERTIFIED);
    assert.match(registered.body.note, /No check has been run by this call/);
  });
});

test('an unknown risk level is refused by name rather than quietly becoming the default', async () => {
  await withApp({}, async ({ call }) => {
    const { status, body } = await call('POST', '/agents', { target: 'typo.example', riskLevel: 'CRITCAL' });
    assert.equal(status, 400);
    assert.match(body.error, /must be one of LOW, HIGH, CRITICAL/);
    assert.ok(body.levels.CRITICAL, 'the reply says what the levels actually are');
  });
});

test('a certification run answers with the standing and the journal line it wrote', async () => {
  await withApp({ replies: [report('RESILIENT', 92)] }, async ({ call }) => {
    const { status, body } = await call('POST', '/agents/run.example/certify', { sampleBody: { q: 1 } });

    assert.equal(status, 200);
    assert.equal(body.measured, true);
    assert.equal(body.standing, STANDING.VALID);
    assert.equal(body.currentVerdict, 'RESILIENT');
    assert.equal(body.revoked, false);
    assert.match(body.journalLine, /certified for the first time at RESILIENT 92/);
  });
});

// The route-level version of the product's whole claim.
test('a certificate served over HTTP goes stale on the clock with nothing rewritten', async () => {
  let now = '2026-01-01T00:00:00.000Z';
  await withApp({ replies: [report('RESILIENT', 92)], now: () => now }, async ({ call }) => {
    await call('POST', '/agents', { target: 'aging.example', riskLevel: 'HIGH' });
    await call('POST', '/agents/aging.example/certify', { sampleBody: { q: 1 } });

    const fresh = await call('GET', '/agents/aging.example');
    assert.equal(fresh.body.standing, STANDING.VALID);

    // Nobody wrote anything. Only the clock moved.
    now = '2026-02-01T00:00:00.000Z';

    const later = await call('GET', '/agents/aging.example');
    assert.equal(later.body.standing, STANDING.STALE);
    assert.equal(later.body.certificate.verdict, 'RESILIENT', 'what was measured is still reported');
    assert.equal(later.body.certificate.certifiedAt, '2026-01-01T00:00:00.000Z');
    assert.match(later.body.standingReason, /not a finding about the agent/);
  });
});

test('the five standings stay distinguishable over the API and never collapse to a boolean', async () => {
  await withApp(
    {
      replies: [
        report('RESILIENT', 92), // holds.example, valid
        report('RESILIENT', 92), // fell.example, then falls below
        report('BRITTLE', 20),
        report('BRITTLE', 30), // weak.example, never qualified at HIGH
      ],
    },
    async ({ call }) => {
      await call('POST', '/agents', { target: 'holds.example', riskLevel: 'LOW' });
      await call('POST', '/agents/holds.example/certify', { sampleBody: { q: 1 } });

      await call('POST', '/agents', { target: 'fell.example', riskLevel: 'LOW' });
      await call('POST', '/agents/fell.example/certify', { sampleBody: { q: 1 } });
      await call('POST', '/agents/fell.example/certify', { sampleBody: { q: 1 } });

      await call('POST', '/agents', { target: 'weak.example', riskLevel: 'HIGH' });
      await call('POST', '/agents/weak.example/certify', { sampleBody: { q: 1 } });

      await call('POST', '/agents', { target: 'unchecked.example', riskLevel: 'LOW' });

      const seen = new Map(
        (await call('GET', '/agents')).body.agents.map((agent) => [agent.target, agent.standing]),
      );

      assert.equal(seen.get('holds.example'), STANDING.VALID);
      assert.equal(seen.get('fell.example'), STANDING.REVOKED);
      assert.equal(seen.get('weak.example'), STANDING.NEVER_QUALIFIED);
      assert.equal(seen.get('unchecked.example'), STANDING.NOT_CERTIFIED);

      // The distinction between them is the product, so it has to survive the
      // JSON. Nothing here reduces the five to good or bad.
      const one = (await call('GET', '/agents/fell.example')).body;
      assert.equal(Object.hasOwn(one, 'valid'), false);
      assert.equal(Object.hasOwn(one, 'ok'), false);
      assert.equal(Object.hasOwn(one, 'trustworthy'), false);
    },
  );
});

test('a run that could not reach StressProof is not a verdict, and revokes nothing', async () => {
  await withApp(
    { replies: [report('RESILIENT', 92), new Error('connection refused')] },
    async ({ call }) => {
      await call('POST', '/agents/flaky.example/certify', { sampleBody: { q: 1 } });
      const { status, body } = await call('POST', '/agents/flaky.example/certify', { sampleBody: { q: 1 } });

      assert.equal(status, 200, 'the request was handled correctly; the check is what failed');
      assert.equal(body.measured, false);
      assert.equal(body.upstreamReached, false);
      assert.equal(body.revoked, false);
      assert.equal(body.standing, STANDING.VALID, 'the certificate is untouched');
      assert.match(body.unmeasurableReason, /StressProof could not be reached/);
    },
  );
});

test('an agent named as a URL survives the round trip through the path', async () => {
  await withApp({ replies: [report('PARTIAL', 70)] }, async ({ call }) => {
    const target = 'https://agent.example/v1/chat';
    const encoded = encodeURIComponent(target);

    await call('POST', '/agents', { target, riskLevel: 'LOW' });
    const certified = await call('POST', `/agents/${encoded}/certify`, { sampleBody: { q: 1 } });
    assert.equal(certified.body.target, target);

    const read = await call('GET', `/agents/${encoded}`);
    assert.equal(read.body.target, target);
    assert.equal(read.body.standing, STANDING.VALID);

    const journal = await call('GET', `/agents/${encoded}/journal`);
    assert.ok(journal.body.entries.some((entry) => entry.lines.some((line) => line.includes(target))));
  });
});

test('the ACP job route answers the same question the live adapter would', async () => {
  await withApp({ replies: [report('RESILIENT', 90)] }, async ({ call }) => {
    await call('POST', '/agents', { target: 'hired.example', riskLevel: 'LOW' });
    await call('POST', '/agents/hired.example/certify', { sampleBody: { q: 1 } });

    const answered = await call('POST', '/acp/jobs', { serviceRequirement: { target: 'hired.example' } });
    assert.equal(answered.status, 200);
    assert.equal(answered.body.standing, STANDING.VALID);
    assert.equal(answered.body.freshTestRun, false);

    const refused = await call('POST', '/acp/jobs', { serviceRequirement: { note: 'nothing named' } });
    assert.equal(refused.status, 400);
    assert.equal(refused.body.retryable, false);
  });
});

// The rule the whole file is built around. An empty registry and an unreachable
// database must never look the same from outside.
test('an unreachable memory is a 503 that says so, never an empty answer', async () => {
  const broken = {
    async recallCertification() {
      throw new MemoryUnavailableError('memory bridge stopped: python is not installed');
    },
    async recallRiskLevel() {
      throw new MemoryUnavailableError('memory bridge stopped: python is not installed');
    },
    async listRegistry() {
      throw new MemoryUnavailableError('memory bridge stopped: python is not installed');
    },
    async listRiskLevels() {
      throw new MemoryUnavailableError('memory bridge stopped: python is not installed');
    },
    async readRunHistory() {
      throw new MemoryUnavailableError('memory bridge stopped: python is not installed');
    },
  };

  const registry = new Registry({ memory: broken });
  const certifier = new Certifier({ memory: broken, stressproof: stressproof() });
  const app = createApp({ certifier, registry, memory: broken, env: {} });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    for (const route of ['/agents', '/agents/anything.example', '/agents/anything.example/journal', '/due']) {
      const response = await fetch(`${base}${route}`);
      const body = await response.json();
      assert.equal(response.status, 503, `${route} must refuse rather than answer`);
      assert.equal(body.memory, 'unavailable');
      assert.match(body.error, /it does not know/);
    }

    const about = await (await fetch(`${base}/about`)).json();
    assert.equal(about.memory.reachable, false, '/about tells the truth about memory rather than assuming');

    const job = await fetch(`${base}/acp/jobs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'anything.example' }),
    });
    assert.equal(job.status, 503, 'a paying buyer is refused rather than sold a made-up answer');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('a deployment that meant to pay and cannot refuses instead of running for free', async () => {
  await withApp(
    {
      replies: [report('RESILIENT', 92)],
      certification: { mode: CERTIFICATION.MISCONFIGURED, reason: 'HALFLIFE_PAYER_ADDRESS is not set' },
    },
    async ({ call }) => {
      const { status, body } = await call('POST', '/agents/paid.example/certify', { sampleBody: { q: 1 } });
      assert.equal(status, 503);
      assert.match(body.error, /HALFLIFE_PAYER_ADDRESS/);
      assert.match(body.note, /Nothing was certified and no certificate was revoked/);

      const swept = await call('POST', '/sweep', {});
      assert.equal(swept.status, 503, 'the sweep cannot spend money it was told to spend and cannot');
    },
  );
});

test('the paid Arc demo refuses before payment if Arc writing is not configured', async () => {
  let middlewareCalled = false;
  const paidArcDemoGate = {
    mode: 'live',
    enabled: true,
    config: {
      network: 'eip155:5042',
      priceUsdc: '0.10',
      payTo: '0xb3FB14FEcac09efbD0C74Fc07d50d7eD1eef2B53',
    },
    middleware: (_req, _res, next) => {
      middlewareCalled = true;
      next();
    },
    reason: null,
  };

  await withApp(
    {
      paidArcDemoGate,
      arcConfigReason: 'HALFLIFE_ARC_PRIVATE_KEY is not set',
    },
    async ({ call }) => {
      const { status, body } = await call('POST', '/demo/certify/paid', {
        targetUrl: 'https://agent.example/v1/chat',
        agentAddress: '0x7a3f19e0b6d4c9a2f0e1b8d3a5c7e9f0b1d2c281',
        sampleBody: { q: 1 },
      });
      assert.equal(status, 503);
      assert.match(body.error, /HALFLIFE_ARC_PRIVATE_KEY/);
      assert.equal(body.ok, false);
      assert.equal(body.charged, false);
      assert.equal(body.checked, false);
      assert.equal(body.arcWritten, false);
      assert.match(body.summary, /Arc writing key is missing/);
      assert.equal(middlewareCalled, false, 'no payment should be requested before Arc writing is possible');
    },
  );
});

test('the paid Arc demo validates input before payment middleware runs', async () => {
  let middlewareCalled = false;
  const paidArcDemoGate = {
    mode: 'live',
    enabled: true,
    config: {
      network: 'eip155:5042',
      priceUsdc: '0.10',
      payTo: '0xb3FB14FEcac09efbD0C74Fc07d50d7eD1eef2B53',
    },
    middleware: (_req, _res, next) => {
      middlewareCalled = true;
      next();
    },
    reason: null,
  };

  await withApp(
    {
      paidArcDemoGate,
      arcClients: { fake: true },
    },
    async ({ call }) => {
      const { status, body } = await call('POST', '/demo/certify/paid', {
        targetUrl: 'https://agent.example/v1/chat',
        agentAddress: 'not-an-address',
        sampleBody: { q: 1 },
      });
      assert.equal(status, 400);
      assert.match(body.error, /agentAddress/);
      assert.equal(body.charged, false);
      assert.equal(body.checked, false);
      assert.equal(body.arcWritten, false);
      assert.match(body.summary, /refused before charging/);
      assert.equal(middlewareCalled, false, 'bad input must not reach payment');
    },
  );
});

test('the paid Arc demo charges, certifies and returns Arc proof', async () => {
  let middlewareCalled = false;
  let savedSnapshot = null;
  const paidArcDemoGate = {
    mode: 'live',
    enabled: true,
    config: {
      network: 'eip155:5042',
      priceUsdc: '0.10',
      payTo: '0xb3FB14FEcac09efbD0C74Fc07d50d7eD1eef2B53',
    },
    middleware: (_req, res, next) => {
      middlewareCalled = true;
      res.set('payment-response', 'fake-settlement');
      next();
    },
    reason: null,
  };

  let seen;
  const certifyOnArcFn = async (deps, params) => {
    seen = { deps, params };
    return {
      target: params.targetUrl,
      checkedAt: '2026-09-20T12:00:00.000Z',
      measured: true,
      standing: STANDING.VALID,
      standingReason: 'valid',
      currentVerdict: 'RESILIENT',
      previousVerdict: null,
      revoked: false,
      reason: 'first certification',
      specVersion: 'sp1-test',
      current: { reportHash: '0xreport' },
      arc: { written: true, event: 'issued', txHash: '0xarc' },
      journalLine: 'certified for the first time',
    };
  };

  await withApp(
    {
      paidArcDemoGate,
      arcClients: { fake: true },
      certifyOnArcFn,
      arcDemoResultStore: {
        async read() {
          return savedSnapshot;
        },
        async write(snapshot) {
          savedSnapshot = snapshot;
          return snapshot;
        },
      },
    },
    async ({ call }) => {
      const { status, body } = await call('POST', '/demo/certify/paid', {
        targetUrl: 'https://agent.example/v1/chat',
        agentAddress: '0x7a3f19e0b6d4c9a2f0e1b8d3a5c7e9f0b1d2c281',
        sampleBody: { q: 1 },
      });

      assert.equal(status, 200);
      assert.equal(middlewareCalled, true);
      assert.equal(seen.params.targetUrl, 'https://agent.example/v1/chat');
      assert.equal(seen.params.request.method, 'POST');
      assert.deepEqual(seen.params.request.sampleBody, { q: 1 });
      assert.equal(body.ok, true);
      assert.equal(body.charged, true);
      assert.equal(body.checked, true);
      assert.equal(body.arcWritten, true);
      assert.match(body.summary, /Paid Arc demo completed/);
      assert.equal(body.paid, true);
      assert.equal(body.payment.network, 'eip155:5042');
      assert.equal(body.arc.txHash, '0xarc');
      assert.equal(body.reportHash, '0xreport');
      assert.equal(body.latestResult, 'GET /demo/certify/paid/latest');
      assert.equal(savedSnapshot.payment.network, 'eip155:5042');
      assert.equal(savedSnapshot.targetUrl, 'https://agent.example/v1/chat');
      assert.equal(savedSnapshot.agentAddress, '0x7a3f19e0b6d4c9a2f0e1b8d3a5c7e9f0b1d2c281');
      assert.equal(savedSnapshot.arc.txHash, '0xarc');
      assert.equal(savedSnapshot.reportHash, '0xreport');
    },
  );
});

test('a paid run that could not reach StressProof says so instead of claiming it checked', async () => {
  const paidArcDemoGate = {
    mode: 'live',
    enabled: true,
    config: {
      network: 'eip155:5042',
      priceUsdc: '0.10',
      payTo: '0xb3FB14FEcac09efbD0C74Fc07d50d7eD1eef2B53',
    },
    middleware: (_req, _res, next) => next(),
    reason: null,
  };

  // The shape certifyOnArc returns when the visitor's money moved but the
  // upstream never ran: measured false, and no Arc write because nothing was
  // measured to write about.
  const certifyOnArcFn = async () => ({
    target: 'https://agent.example/v1/chat',
    checkedAt: '2026-09-22T12:00:00.000Z',
    measured: false,
    upstreamReached: false,
    unmeasurableReason: 'StressProof could not be reached: HTTP 402: insufficient_funds',
    standing: STANDING.VALID,
    standingReason: 'left as it was',
    currentVerdict: null,
    previousVerdict: 'RESILIENT',
    revoked: false,
    reason: 'the run measured nothing',
    specVersion: 'sp1-test',
    current: null,
    arc: { written: false, reason: 'No Arc write: this run measured nothing' },
    journalLine: 'could not measure',
  });

  await withApp(
    {
      paidArcDemoGate,
      arcClients: { fake: true },
      certifyOnArcFn,
      arcDemoResultStore: {
        async read() {
          return null;
        },
        async write(snapshot) {
          return snapshot;
        },
      },
    },
    async ({ call }) => {
      const { status, body } = await call('POST', '/demo/certify/paid', {
        targetUrl: 'https://agent.example/v1/chat',
        agentAddress: '0x7a3f19e0b6d4c9a2f0e1b8d3a5c7e9f0b1d2c281',
        sampleBody: { q: 1 },
      });

      assert.equal(status, 200);
      // The money really did move, and that stays true.
      assert.equal(body.charged, true);
      assert.equal(body.paid, true);
      // What must NOT be claimed is that a check happened.
      assert.equal(body.checked, false);
      assert.equal(body.measured, false);
      assert.equal(body.arcWritten, false);
      assert.equal(body.upstreamReached, false);
      assert.match(body.unmeasurableReason, /insufficient_funds/);
      assert.match(body.summary, /could not run the check/);
      assert.match(body.summary, /insufficient_funds/);
      assert.doesNotMatch(
        body.summary,
        /Halflife ran the check/,
        'must never say it ran the check when it did not',
      );
    },
  );
});

test('the latest paid Arc demo endpoint reads the saved proof without running a check', async () => {
  let certifyCalled = false;
  await withApp(
    {
      certifyOnArcFn: async () => {
        certifyCalled = true;
        throw new Error('should not certify on read');
      },
      arcDemoResultStore: {
        async read() {
          return {
            payment: { network: 'eip155:5042' },
            targetUrl: 'https://agent.example/v1/chat',
            arc: { txHash: '0xarc' },
          };
        },
        async write() {
          throw new Error('should not write on read');
        },
      },
    },
    async ({ call }) => {
      const { status, body } = await call('GET', '/demo/certify/paid/latest');
      assert.equal(status, 200);
      assert.equal(body.ok, true);
      assert.match(body.summary, /Latest paid Arc demo proof found/);
      assert.equal(body.payment.network, 'eip155:5042');
      assert.equal(body.arc.txHash, '0xarc');
      assert.equal(certifyCalled, false);
    },
  );
});

test('the latest paid Arc demo endpoint says clearly when no paid run exists yet', async () => {
  await withApp(
    {
      arcDemoResultStore: {
        async read() {
          return null;
        },
        async write() {
          throw new Error('should not write on read');
        },
      },
    },
    async ({ call }) => {
      const { status, body } = await call('GET', '/demo/certify/paid/latest');
      assert.equal(status, 404);
      assert.equal(body.ok, false);
      assert.match(body.summary, /No paid Arc demo run/);
      assert.match(body.error, /No paid Arc demo run/);
    },
  );
});

test('the judge Arc proof verifier endpoint lets a judge click-check the built-in proof', async () => {
  let verifierCalled = false;
  await withApp(
    {
      arcProofVerifier: {
        async verifyManualProof() {
          verifierCalled = true;
          return {
            chain: { id: 5042, name: 'Arc' },
            ok: true,
            summary: 'Arc proof verified. Halflife found the expected issue transaction and the expected revoke transaction on Arc.',
            issued: { ok: true, txHash: '0xissued' },
            revoked: { ok: true, txHash: '0xrevoked' },
          };
        },
      },
    },
    async ({ base }) => {
      // Explicit Accept header, matching what judgePay.js actually sends: the
      // route also serves an HTML view of the same proof to a plain browser
      // visit, so a request with no stated preference is not the right check
      // for the JSON contract this test cares about.
      const response = await fetch(`${base}/demo/arc-proof/verify`, { headers: { accept: 'application/json' } });
      const status = response.status;
      const body = await response.json();
      assert.equal(status, 200);
      assert.equal(verifierCalled, true);
      assert.equal(body.ok, true);
      assert.match(body.summary, /Arc proof verified/);
      assert.equal(body.chain.id, 5042);
      assert.equal(body.issued.txHash, '0xissued');
    },
  );
});

test('the Arc proof verifier shows a designed page when opened in a browser', async () => {
  await withApp(
    {
      arcProofVerifier: {
        async verifyManualProof() {
          return {
            chain: { id: 5042, name: 'Arc' },
            ok: true,
            summary: 'Arc proof verified. Halflife found the expected issue transaction and the expected revoke transaction on Arc.',
            issued: {
              ok: true,
              txHash: '0xe21574e8463509ab806bc62af60eac34f9276b584da663adbf4adb3d1565b866',
              summary: 'Arc proof verified: this transaction issued a certificate.',
              payload: {
                agent: '0xb3FB14FEcac09efbD0C74Fc07d50d7eD1eef2B53',
                certificateHash: '0xbb3735f892a1e75e356aaeb580649832c1419806b89ae8f69977b285fe8830a3',
                at: '2026-09-20T10:40:46.954Z',
              },
            },
            revoked: {
              ok: true,
              txHash: '0x9ec75646190b84a566f6f279bcf21678f78a3d3e310b2f896a691e051876f95b',
              summary: 'Arc proof verified: this transaction revoked a certificate.',
              payload: {
                agent: '0xb3FB14FEcac09efbD0C74Fc07d50d7eD1eef2B53',
                certificateHash: '0x8e566df80ac7b7b5b13fc0172ebe4ba7c969fc09becd4c7da685259180bd91df',
                at: '2026-09-20T10:40:50.012Z',
                reason: 'Certificate revoked. This agent now returns success-shaped responses to input it should have rejected.',
              },
            },
          };
        },
      },
    },
    async ({ base }) => {
      const response = await fetch(`${base}/demo/arc-proof/verify`, {
        headers: { accept: 'text/html' },
      });
      const html = await response.text();
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /text\/html/);
      assert.match(html, /The issue and revoke records match/);
      assert.match(html, /Verified on Arc/);
      assert.match(html, /0xb3FB14FEcac09efbD0C74Fc07d50d7eD1eef2B53/);
      assert.match(html, /Show raw verifier response/);
    },
  );
});

test('the sweep route re-checks what has expired and reports what it skipped', async () => {
  let now = '2026-01-01T00:00:00.000Z';
  await withApp(
    { replies: [report('RESILIENT', 92), report('RESILIENT', 91)], now: () => now },
    async ({ call }) => {
      await call('POST', '/agents', {
        target: 'sweepable.example',
        riskLevel: 'CRITICAL',
        check: { sampleBody: { q: 1 } },
      });
      await call('POST', '/agents/sweepable.example/certify', { sampleBody: { q: 1 } });

      await call('POST', '/agents', { target: 'noRequest.example', riskLevel: 'CRITICAL' });

      now = '2026-01-05T00:00:00.000Z';
      const { status, body } = await call('POST', '/sweep', {});

      assert.equal(status, 200);
      assert.equal(body.checked.some((entry) => entry.target === 'sweepable.example'), true);
      const skipped = body.skipped.find((entry) => entry.target === 'noRequest.example');
      assert.ok(skipped, 'an agent that cannot be swept is named rather than left out');
      assert.match(skipped.reason, /no re-check request is registered/);
    },
  );
});
