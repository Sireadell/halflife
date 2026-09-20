import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCertificateMemoPayload,
  decodeCertificateMemoPayload,
  writeCertificateMemo,
  verifyMemoContractIsDeployed,
  HALFLIFE_MEMO_ID,
  MEMO_CONTRACT_ADDRESS,
} from '../src/lib/arcMemo.js';
import { stringToHex } from 'viem';

const AGENT = '0x7a3f19e0b6d4c9a2f0e1b8d3a5c7e9f0b1d2c281';
const CERT_HASH = '0x9be14a7d0000000000000000000000000000000000000000000000f2c0204a';

test('an issued payload carries no reason field', () => {
  const payload = buildCertificateMemoPayload({
    event: 'issued',
    agentAddress: AGENT,
    certificateHash: CERT_HASH,
  });
  assert.equal(payload.event, 'issued');
  assert.equal(payload.agent, AGENT);
  assert.equal(payload.certificateHash, CERT_HASH);
  assert.equal(payload.reason, undefined);
});

test('a revoked payload without a stated reason still says so plainly', () => {
  const payload = buildCertificateMemoPayload({
    event: 'revoked',
    agentAddress: AGENT,
    certificateHash: CERT_HASH,
  });
  assert.equal(payload.reason, 'not stated');
});

test('an event other than issued or revoked is refused', () => {
  assert.throws(
    () => buildCertificateMemoPayload({ event: 'maybe', agentAddress: AGENT, certificateHash: CERT_HASH }),
    /must be 'issued' or 'revoked'/,
  );
});

test('decoding round-trips exactly what was built', () => {
  const payload = buildCertificateMemoPayload({
    event: 'revoked',
    agentAddress: AGENT,
    certificateHash: CERT_HASH,
    reason: 'latency exceeded 8 seconds on 4 of 5 calls',
  });
  const encoded = stringToHex(JSON.stringify(payload));
  const decoded = decodeCertificateMemoPayload(encoded);
  assert.deepEqual(decoded, payload);
});

test('the memo id is the same value every time, so all Halflife memos share one tag', () => {
  assert.match(HALFLIFE_MEMO_ID, /^0x[0-9a-f]{64}$/);
});

test('an empty bytecode result is refused with a clear message, not a confusing revert later', async () => {
  const fakePublicClient = {
    chain: { id: 5042 },
    getBytecode: async () => '0x',
  };
  await assert.rejects(
    () => verifyMemoContractIsDeployed(fakePublicClient),
    (err) => err.message.includes(MEMO_CONTRACT_ADDRESS) && err.message.includes('5042'),
  );
});

test('real bytecode at the address passes the check', async () => {
  const fakePublicClient = {
    chain: { id: 5042 },
    getBytecode: async () => '0x6080604052',
  };
  await assert.doesNotReject(() => verifyMemoContractIsDeployed(fakePublicClient));
});

test('writeCertificateMemo sends the memo call and waits for a successful receipt', async () => {
  const calls = [];
  const fakeClients = {
    walletClient: {
      writeContract: async (args) => {
        calls.push(args);
        return '0xdeadbeef';
      },
    },
    publicClient: {
      chain: { id: 5042 },
      getBytecode: async () => '0x6080604052',
      waitForTransactionReceipt: async ({ hash }) => ({ hash, status: 'success' }),
    },
  };

  const result = await writeCertificateMemo(fakeClients, {
    event: 'issued',
    agentAddress: AGENT,
    certificateHash: CERT_HASH,
  });

  assert.equal(result.txHash, '0xdeadbeef');
  assert.equal(result.memoId, HALFLIFE_MEMO_ID);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].functionName, 'memo');
  assert.equal(calls[0].args[0], AGENT);
  assert.equal(calls[0].args[2], HALFLIFE_MEMO_ID);
});

test('writeCertificateMemo refuses a mined-but-reverted transaction', async () => {
  const fakeClients = {
    walletClient: { writeContract: async () => '0xbadbad' },
    publicClient: {
      chain: { id: 5042 },
      getBytecode: async () => '0x6080604052',
      waitForTransactionReceipt: async () => ({ status: 'reverted' }),
    },
  };

  await assert.rejects(
    () =>
      writeCertificateMemo(fakeClients, {
        event: 'issued',
        agentAddress: AGENT,
        certificateHash: CERT_HASH,
      }),
    /reverted/,
  );
});
