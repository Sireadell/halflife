import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_IDENTITY_REGISTRY,
  DEFAULT_REPUTATION_REGISTRY,
  createErc8004,
  resolveErc8004Addresses,
  resolveKnownAgentId,
} from '../src/lib/erc8004.js';

const HALFLIFE = '0xb3fb14fecac09efbd0c74fc07d50d7ed1eef2b53';

test('ERC-8004 addresses default to the verified Arc registries', () => {
  assert.deepEqual(resolveErc8004Addresses({}), {
    identityAddress: DEFAULT_IDENTITY_REGISTRY,
    reputationAddress: DEFAULT_REPUTATION_REGISTRY,
  });
});

test('the ERC-8004 client verifies registries and writes feedback through viem clients', async () => {
  const writes = [];
  const reads = [];
  const simulated = [];
  const publicClient = {
    async getBytecode({ address }) {
      reads.push(['code', address]);
      return '0x01';
    },
    async readContract({ address, functionName, args }) {
      reads.push([functionName, address, args]);
      if (functionName === 'name') return 'AgentIdentity';
      if (functionName === 'symbol') return 'AGENT';
      if (functionName === 'getIdentityRegistry') return DEFAULT_IDENTITY_REGISTRY;
      if (functionName === 'getLastIndex') return 5n;
      throw new Error(`unexpected read ${functionName}`);
    },
    async simulateContract({ functionName, args, account }) {
      simulated.push(functionName);
      assert.equal(account.address, HALFLIFE);
      if (functionName === 'register') {
        assert.deepEqual(args, ['https://agent.example']);
        return { request: { functionName, args }, result: 7n };
      }
      return { request: { functionName, args } };
    },
    async waitForTransactionReceipt({ hash }) {
      return { status: 'success', hash };
    },
  };
  const walletClient = {
    account: { address: HALFLIFE },
    async writeContract(request) {
      writes.push(request);
      return writes.length === 1 ? '0xregister' : '0xfeedback';
    },
  };

  const client = await createErc8004({ publicClient, walletClient, env: {} });
  const registered = await client.registerAgent('https://agent.example');
  const feedback = await client.giveFeedback({
    agentId: registered.agentId,
    value: 100,
    valueDecimals: 0,
    tag1: 'halflife',
    tag2: 'RESILIENT',
    endpoint: 'https://agent.example',
    feedbackURI: '/c/sp1-example',
    feedbackHash: '0xbb3735f892a1e75e356aaeb580649832c1419806b89ae8f69977b285fe8830a3',
  });
  const index = await client.getLastIndex('7', HALFLIFE);

  assert.equal(registered.agentId, '7');
  assert.equal(registered.txHash, '0xregister');
  assert.equal(feedback.txHash, '0xfeedback');
  assert.equal(index, '5');
  assert.equal(writes[1].functionName, 'giveFeedback');
  assert.deepEqual(writes[1].args.slice(0, 5), [7n, 100n, 0, 'halflife', 'RESILIENT']);
  assert.ok(reads.some(([name]) => name === 'getIdentityRegistry'));
  assert.deepEqual(simulated, ['register', 'giveFeedback']);
});

test('a registry refusal found in simulation sends no transaction', async () => {
  const writes = [];
  const publicClient = {
    async getBytecode() {
      return '0x01';
    },
    async readContract({ functionName }) {
      if (functionName === 'name') return 'AgentIdentity';
      if (functionName === 'symbol') return 'AGENT';
      if (functionName === 'getIdentityRegistry') return DEFAULT_IDENTITY_REGISTRY;
      throw new Error(`unexpected read ${functionName}`);
    },
    async simulateContract() {
      throw new Error('Self-feedback not allowed');
    },
  };
  const walletClient = {
    account: { address: HALFLIFE },
    async writeContract(request) {
      writes.push(request);
      return '0xshouldnothappen';
    },
  };
  const client = await createErc8004({ publicClient, walletClient, env: {} });

  await assert.rejects(
    () => client.giveFeedback({
      agentId: '7', value: 100, valueDecimals: 0, tag1: 'halflife', tag2: 'RESILIENT',
      endpoint: 'https://agent.example', feedbackURI: '/c/x',
      feedbackHash: '0xbb3735f892a1e75e356aaeb580649832c1419806b89ae8f69977b285fe8830a3',
    }),
    /Self-feedback not allowed/,
  );
  await assert.rejects(() => client.revokeFeedback('7', '1'), /Self-feedback not allowed/);
  assert.equal(writes.length, 0);
});

test('known agent ids come from HALFLIFE_ERC8004_AGENT_IDS and ignore anything malformed', () => {
  const env = { HALFLIFE_ERC8004_AGENT_IDS: '{"https://a.example": 12, "https://b.example": "x"}' };
  assert.equal(resolveKnownAgentId('https://a.example', env), '12');
  assert.equal(resolveKnownAgentId(' https://a.example ', env), '12');
  assert.equal(resolveKnownAgentId('https://b.example', env), null);
  assert.equal(resolveKnownAgentId('https://c.example', env), null);
  assert.equal(resolveKnownAgentId('https://a.example', { HALFLIFE_ERC8004_AGENT_IDS: 'not json' }), null);
  assert.equal(resolveKnownAgentId('https://a.example', {}), null);
});
