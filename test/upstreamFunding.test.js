// What the funding check decides, and just as importantly what it refuses to
// decide. The dangerous mistake here is not a missed shortfall, it is treating
// "I could not find out" as "there is no money", which would close a working
// paid route over a momentary RPC failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createUpstreamFundingCheck } from '../src/lib/upstreamFunding.js';

const ARC_CONFIG = {
  ok: true,
  signsAgainstGateway: true,
  usdc: '0x3600000000000000000000000000000000000000',
  payerAddress: '0xb3fb14fecac09efbd0c74fc07d50d7ed1eef2b53',
  priceUsdc: '0.005',
};

test('a balance that covers the run allows it', async () => {
  const check = createUpstreamFundingCheck({
    paidConfig: ARC_CONFIG,
    readBalance: async () => 5000n, // exactly 0.005
  });
  assert.deepEqual(await check(), { ok: true, checked: true });
});

test('a known shortfall refuses, and says both numbers', async () => {
  const check = createUpstreamFundingCheck({
    paidConfig: ARC_CONFIG,
    readBalance: async () => 2000n, // 0.002, short of 0.005
  });
  const verdict = await check();
  assert.equal(verdict.ok, false);
  // Someone reading this has to be able to tell how short it is, not just
  // that something is wrong.
  assert.match(verdict.reason, /0\.002 USDC/);
  assert.match(verdict.reason, /0\.005 USDC/);
  assert.match(verdict.reason, /[Nn]othing has been charged/);
});

test('a balance that cannot be read is not treated as empty', async () => {
  const check = createUpstreamFundingCheck({
    paidConfig: ARC_CONFIG,
    readBalance: async () => {
      throw new Error('RPC down');
    },
  });
  // Unknown leaves the route exactly as it was. Refusing here would let a
  // flaky RPC take the paid route down, which is worse than the failure this
  // whole file exists to prevent.
  assert.deepEqual(await check(), { ok: true, checked: false });
});

test('deployments that buy nothing upstream are never blocked', async () => {
  let read = false;
  const free = createUpstreamFundingCheck({
    paidConfig: { ok: false },
    readBalance: async () => {
      read = true;
      return 0n;
    },
  });
  assert.deepEqual(await free(), { ok: true, checked: false });
  assert.equal(read, false, 'a free deployment must not do an on-chain read');
});

test('a chain whose balance this does not understand is left alone', async () => {
  // Only Arc's deposited Gateway balance is readable here. On Base the
  // wallet's own USDC is what gets spent, and claiming to have checked it
  // would be a lie.
  const base = createUpstreamFundingCheck({
    paidConfig: { ...ARC_CONFIG, signsAgainstGateway: false },
    readBalance: async () => 0n,
  });
  assert.deepEqual(await base(), { ok: true, checked: false });
});

test('the reading is cached, then refreshed once it goes stale', async () => {
  let reads = 0;
  let clock = 1_000;
  const check = createUpstreamFundingCheck({
    paidConfig: ARC_CONFIG,
    cacheMs: 30_000,
    now: () => clock,
    readBalance: async () => {
      reads += 1;
      return 2000n;
    },
  });

  await check();
  await check();
  assert.equal(reads, 1, 'a second call inside the window must not hit the chain again');

  clock += 30_001;
  await check();
  assert.equal(reads, 2, 'a stale reading must be refreshed');
});
