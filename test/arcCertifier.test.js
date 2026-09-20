import { test } from 'node:test';
import assert from 'node:assert/strict';

import { certifyOnArc } from '../src/lib/arcCertifier.js';
import { DRIFT, CERTIFICATE } from '../src/lib/drift.js';

const AGENT_ADDRESS = '0x7a3f19e0b6d4c9a2f0e1b8d3a5c7e9f0b1d2c281';

function fakeCertifier(result) {
  return { certify: async () => result };
}

function recordingWriteMemo(calls) {
  return async (arcClients, params) => {
    calls.push({ arcClients, params });
    return { txHash: '0xfeedface', memoId: '0xmemo', payload: params };
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
