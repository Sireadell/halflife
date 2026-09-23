import { test } from 'node:test';
import assert from 'node:assert/strict';

import { certifyOnArc } from '../src/lib/arcCertifier.js';
import { DRIFT, CERTIFICATE } from '../src/lib/drift.js';

const AGENT_ADDRESS = '0x7a3f19e0b6d4c9a2f0e1b8d3a5c7e9f0b1d2c281';
const HALFLIFE_ADDRESS = '0xb3fb14fecac09efbd0c74fc07d50d7ed1eef2b53';
const REPORT_HASH = '0xbb3735f892a1e75e356aaeb580649832c1419806b89ae8f69977b285fe8830a3';

function fakeCertifier(result) {
  return { certify: async () => result };
}

function recordingWriteMemo(calls) {
  return async (arcClients, params) => {
    calls.push({ arcClients, params });
    return { txHash: '0xfeedface', memoId: '0xmemo', payload: params };
  };
}

function fakeMemory(record) {
  return {
    writes: [],
    current: record,
    async recallCertification() {
      return this.current;
    },
    async rememberCertification(_target, next) {
      this.current = next;
      this.writes.push(next);
    },
  };
}

function recordingErc8004(calls, overrides = {}) {
  return {
    async registerAgent(agentURI) {
      calls.push({ method: 'registerAgent', agentURI });
      return overrides.registerAgent ?? { agentId: '7', txHash: '0xregister' };
    },
    async giveFeedback(params) {
      calls.push({ method: 'giveFeedback', params });
      if (overrides.giveFeedback instanceof Error) throw overrides.giveFeedback;
      return overrides.giveFeedback ?? { txHash: '0xfeedback' };
    },
    async revokeFeedback(agentId, index) {
      calls.push({ method: 'revokeFeedback', agentId, index });
      return overrides.revokeFeedback ?? { txHash: '0xrevoke' };
    },
    async getLastIndex(agentId, client) {
      calls.push({ method: 'getLastIndex', agentId, client });
      return overrides.lastIndex ?? '3';
    },
  };
}

test('a first certification writes an issued memo to Arc', async () => {
  const calls = [];
  const result = await certifyOnArc(
    {
      certifier: fakeCertifier({
        drift: DRIFT.FIRST_CERTIFICATION,
        certificateStatus: CERTIFICATE.VALID,
        revoked: false,
        measured: true,
        current: { reportHash: '0xhash1' },
      }),
      arcClients: { fake: true },
      writeMemo: recordingWriteMemo(calls),
    },
    { targetUrl: 'https://example.com/agent', agentAddress: AGENT_ADDRESS },
  );

  assert.equal(result.arc.written, true);
  assert.equal(result.arc.event, 'issued');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].params.event, 'issued');
  assert.equal(calls[0].params.certificateHash, '0xhash1');
  assert.equal(calls[0].params.agentAddress, AGENT_ADDRESS);
});

test('a first certification writes ERC-8004 feedback with the verdict, URI and hash', async () => {
  const memoCalls = [];
  const ercCalls = [];
  const memory = fakeMemory({
    target: 'https://example.com/agent',
    verdict: 'RESILIENT',
    score: 100,
    reportHash: REPORT_HASH,
  });

  const result = await certifyOnArc(
    {
      certifier: fakeCertifier({
        drift: DRIFT.FIRST_CERTIFICATION,
        certificateStatus: CERTIFICATE.VALID,
        revoked: false,
        measured: true,
        current: {
          verdict: 'RESILIENT',
          score: 100,
          reportId: 'sp1-example',
          reportHash: REPORT_HASH,
          reportUri: '/c/sp1-example',
        },
        previous: null,
      }),
      arcClients: { account: { address: HALFLIFE_ADDRESS } },
      memory,
      erc8004: recordingErc8004(ercCalls),
      writeMemo: recordingWriteMemo(memoCalls),
    },
    { targetUrl: 'https://example.com/agent', agentAddress: AGENT_ADDRESS },
  );

  const feedback = ercCalls.find((call) => call.method === 'giveFeedback');
  assert.equal(result.arc.erc8004.written, true);
  assert.equal(result.arc.erc8004.agentId, '7');
  assert.equal(result.arc.erc8004.feedbackIndex, '3');
  assert.equal(feedback.params.value, 100);
  assert.equal(feedback.params.valueDecimals, 0);
  assert.equal(feedback.params.tag1, 'halflife');
  assert.equal(feedback.params.tag2, 'RESILIENT');
  assert.equal(feedback.params.endpoint, 'https://example.com/agent');
  assert.equal(feedback.params.feedbackURI, '/c/sp1-example');
  assert.equal(feedback.params.feedbackHash, REPORT_HASH);
  assert.equal(memory.current.erc8004.lastFeedbackIndex, '3');
});

test('a revoked result writes a revoked memo carrying the reason', async () => {
  const calls = [];
  const result = await certifyOnArc(
    {
      certifier: fakeCertifier({
        drift: DRIFT.REVOKED,
        certificateStatus: CERTIFICATE.REVOKED,
        revoked: true,
        measured: true,
        reason: 'fell from RESILIENT to BRITTLE',
        current: { reportHash: '0xhash2' },
      }),
      arcClients: { fake: true },
      writeMemo: recordingWriteMemo(calls),
    },
    { targetUrl: 'https://example.com/agent', agentAddress: AGENT_ADDRESS },
  );

  assert.equal(result.arc.event, 'revoked');
  assert.equal(calls[0].params.reason, 'fell from RESILIENT to BRITTLE');
});

test('an unchanged result writes nothing, since Arc already says this', async () => {
  const calls = [];
  const result = await certifyOnArc(
    {
      certifier: fakeCertifier({
        drift: DRIFT.UNCHANGED,
        certificateStatus: CERTIFICATE.VALID,
        revoked: false,
        measured: true,
        current: { reportHash: '0xhash3' },
      }),
      arcClients: { fake: true },
      writeMemo: recordingWriteMemo(calls),
    },
    { targetUrl: 'https://example.com/agent', agentAddress: AGENT_ADDRESS },
  );

  assert.equal(result.arc.written, false);
  assert.equal(calls.length, 0);
  assert.match(result.arc.reason, /nothing new to record/);
});

test('an unmeasurable run writes nothing and says why in plain terms', async () => {
  const calls = [];
  const result = await certifyOnArc(
    {
      certifier: fakeCertifier({
        drift: DRIFT.UNVERIFIABLE,
        certificateStatus: CERTIFICATE.VALID,
        revoked: false,
        measured: false,
        unmeasurableReason: 'StressProof could not be reached',
        current: { reportHash: null },
      }),
      arcClients: { fake: true },
      writeMemo: recordingWriteMemo(calls),
    },
    { targetUrl: 'https://example.com/agent', agentAddress: AGENT_ADDRESS },
  );

  assert.equal(result.arc.written, false);
  assert.equal(calls.length, 0);
  assert.match(result.arc.reason, /measured nothing/);
});

test('an unmeasurable run writes no ERC-8004 feedback', async () => {
  const ercCalls = [];
  const result = await certifyOnArc(
    {
      certifier: fakeCertifier({
        drift: DRIFT.UNVERIFIABLE,
        certificateStatus: CERTIFICATE.VALID,
        revoked: false,
        measured: false,
        unmeasurableReason: 'StressProof could not be reached',
        current: { reportHash: null },
      }),
      arcClients: { account: { address: HALFLIFE_ADDRESS } },
      memory: fakeMemory(null),
      erc8004: recordingErc8004(ercCalls),
      writeMemo: recordingWriteMemo([]),
    },
    { targetUrl: 'https://example.com/agent', agentAddress: AGENT_ADDRESS },
  );

  assert.equal(result.arc.written, false);
  assert.equal(ercCalls.length, 0);
});

test('a would-be issue with no signed report hash refuses to write, rather than posting an unverifiable claim', async () => {
  const calls = [];
  const result = await certifyOnArc(
    {
      certifier: fakeCertifier({
        drift: DRIFT.FIRST_CERTIFICATION,
        certificateStatus: CERTIFICATE.VALID,
        revoked: false,
        measured: true,
        current: { reportHash: null },
      }),
      arcClients: { fake: true },
      writeMemo: recordingWriteMemo(calls),
    },
    { targetUrl: 'https://example.com/agent', agentAddress: AGENT_ADDRESS },
  );

  assert.equal(result.arc.written, false);
  assert.equal(calls.length, 0);
  assert.match(result.arc.reason, /did not return a signed report hash/);
});

test('a missing report hash writes no ERC-8004 feedback', async () => {
  const ercCalls = [];
  await certifyOnArc(
    {
      certifier: fakeCertifier({
        drift: DRIFT.FIRST_CERTIFICATION,
        certificateStatus: CERTIFICATE.VALID,
        revoked: false,
        measured: true,
        current: { verdict: 'RESILIENT', score: 100, reportHash: null },
      }),
      arcClients: { account: { address: HALFLIFE_ADDRESS } },
      memory: fakeMemory(null),
      erc8004: recordingErc8004(ercCalls),
      writeMemo: recordingWriteMemo([]),
    },
    { targetUrl: 'https://example.com/agent', agentAddress: AGENT_ADDRESS },
  );

  assert.equal(ercCalls.length, 0);
});

test('a revocation revokes the stored ERC-8004 feedback index before writing the new score', async () => {
  const ercCalls = [];
  const previous = {
    verdict: 'RESILIENT',
    erc8004: { agentId: '7', lastFeedbackIndex: '2', registerTxHash: '0xregister' },
  };
  const memory = fakeMemory({
    target: 'https://example.com/agent',
    verdict: 'PARTIAL',
    score: 83,
    reportHash: REPORT_HASH,
    erc8004: previous.erc8004,
  });

  const result = await certifyOnArc(
    {
      certifier: fakeCertifier({
        drift: DRIFT.REVOKED,
        certificateStatus: CERTIFICATE.REVOKED,
        revoked: true,
        measured: true,
        reason: 'fell from RESILIENT to PARTIAL',
        current: { verdict: 'PARTIAL', score: 83, reportHash: REPORT_HASH },
        previous,
      }),
      arcClients: { account: { address: HALFLIFE_ADDRESS } },
      memory,
      erc8004: recordingErc8004(ercCalls, { lastIndex: '4' }),
      writeMemo: recordingWriteMemo([]),
    },
    { targetUrl: 'https://example.com/agent', agentAddress: AGENT_ADDRESS },
  );

  assert.deepEqual(
    ercCalls.filter((call) => call.method === 'revokeFeedback').map((call) => [call.agentId, call.index]),
    [['7', '2']],
  );
  assert.equal(result.arc.erc8004.revoked.written, true);
  assert.equal(result.arc.erc8004.feedbackIndex, '4');
  assert.equal(memory.current.erc8004.revokedFeedbackIndex, '2');
});

test('an ERC-8004 registry failure does not fail the Arc certification result', async () => {
  const result = await certifyOnArc(
    {
      certifier: fakeCertifier({
        drift: DRIFT.FIRST_CERTIFICATION,
        certificateStatus: CERTIFICATE.VALID,
        revoked: false,
        measured: true,
        current: { verdict: 'RESILIENT', score: 100, reportHash: REPORT_HASH },
        previous: null,
      }),
      arcClients: { account: { address: HALFLIFE_ADDRESS } },
      memory: fakeMemory({ target: 'https://example.com/agent' }),
      erc8004: recordingErc8004([], { giveFeedback: new Error('registry unavailable') }),
      writeMemo: recordingWriteMemo([]),
    },
    { targetUrl: 'https://example.com/agent', agentAddress: AGENT_ADDRESS },
  );

  assert.equal(result.arc.written, true);
  assert.equal(result.arc.erc8004.written, false);
  assert.match(result.arc.erc8004.reason, /registry unavailable/);
});

test('an ERC-8004 client setup failure is reported without crashing certification', async () => {
  const result = await certifyOnArc(
    {
      certifier: fakeCertifier({
        drift: DRIFT.FIRST_CERTIFICATION,
        certificateStatus: CERTIFICATE.VALID,
        revoked: false,
        measured: true,
        current: { verdict: 'RESILIENT', score: 100, reportHash: REPORT_HASH },
        previous: null,
      }),
      arcClients: {},
      memory: fakeMemory({ target: 'https://example.com/agent' }),
      writeMemo: recordingWriteMemo([]),
    },
    { targetUrl: 'https://example.com/agent', agentAddress: AGENT_ADDRESS },
  );

  assert.equal(result.arc.written, true);
  assert.equal(result.arc.erc8004.written, false);
  assert.match(result.arc.erc8004.reason, /walletClient and publicClient/);
});

test('a malformed agent address is refused before anything runs', async () => {
  await assert.rejects(
    () =>
      certifyOnArc(
        { certifier: fakeCertifier({}), arcClients: {}, writeMemo: async () => {} },
        { targetUrl: 'https://example.com/agent', agentAddress: 'not-an-address' },
      ),
    /20-byte hex address/,
  );
});
