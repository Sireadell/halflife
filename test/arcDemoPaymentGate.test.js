import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ARC_DEMO_PAY_TO,
  ARC_MAINNET,
  ARC_USDC,
  PAID_ARC_DEMO_ROUTE,
  buildArcDemoRoutes,
  createArcDemoPaymentGate,
  resolveArcDemoPaymentConfig,
} from '../src/lib/arcDemoPaymentGate.js';

test('the Arc demo payment config defaults to Circle on Arc mainnet', () => {
  const config = resolveArcDemoPaymentConfig({
    HALFLIFE_ARC_X402_PAY_TO: '',
    HALFLIFE_ARC_X402_PRICE_USDC: '',
    HALFLIFE_ARC_X402_FACILITATOR: '',
  });
  assert.equal(config.ok, true, config.reason);
  assert.equal(config.network, ARC_MAINNET);
  assert.equal(config.payTo, ARC_DEMO_PAY_TO);
  assert.match(config.facilitatorUrl, /gateway-api\.circle\.com/);
  assert.equal(config.accepts.scheme, 'exact');
  assert.equal(config.accepts.price.amount, '100000');
  assert.equal(config.accepts.price.asset, ARC_USDC.address);
  assert.deepEqual(config.accepts.price.extra, { name: 'USDC', version: '2' });
});

test('the Arc demo route table protects only the paid demo endpoint', () => {
  const config = resolveArcDemoPaymentConfig({});
  const routes = buildArcDemoRoutes({ config });
  assert.deepEqual(Object.keys(routes), [PAID_ARC_DEMO_ROUTE]);
  assert.equal(routes[PAID_ARC_DEMO_ROUTE].accepts.payTo, ARC_DEMO_PAY_TO);
  assert.match(routes[PAID_ARC_DEMO_ROUTE].description, /writes issue or revoke proof to Arc/);
});

test('bad Arc demo payment configuration refuses loudly', () => {
  const badWallet = resolveArcDemoPaymentConfig({ HALFLIFE_ARC_X402_PAY_TO: 'not-a-wallet' });
  assert.equal(badWallet.ok, false);
  assert.match(badWallet.reason, /HALFLIFE_ARC_X402_PAY_TO/);

  const badPrice = resolveArcDemoPaymentConfig({ HALFLIFE_ARC_X402_PRICE_USDC: '0.1234567' });
  assert.equal(badPrice.ok, false);
  assert.match(badPrice.reason, /HALFLIFE_ARC_X402_PRICE_USDC/);
});

test('a live Arc demo payment gate exposes middleware and route config', () => {
  const gate = createArcDemoPaymentGate({ env: {}, syncFacilitatorOnStart: false });
  assert.equal(gate.enabled, true);
  assert.equal(gate.mode, 'live');
  assert.equal(typeof gate.middleware, 'function');
  assert.deepEqual(Object.keys(gate.routes), [PAID_ARC_DEMO_ROUTE]);
});
