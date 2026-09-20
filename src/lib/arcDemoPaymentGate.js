// x402 gate for the public Arc demo route.
//
// This is seller-side payment: a visitor pays Halflife before Halflife spends
// its own StressProof wallet and writes the resulting certificate event to Arc.
// The route stays closed unless the payment middleware is live and Arc writing
// is configured, so nobody can be charged for a run we cannot record.

import { paymentMiddleware, x402ResourceServer } from '@x402/express';
import { HTTPFacilitatorClient } from '@x402/core/server';
import { ExactEvmScheme } from '@x402/evm/exact/server';

export const ARC_MAINNET = 'eip155:5042';
export const ARC_USDC = Object.freeze({
  address: '0x3600000000000000000000000000000000000000',
  decimals: 6,
  eip712Domain: Object.freeze({ name: 'USDC', version: '2' }),
});
export const ARC_DEMO_PRICE_USDC = '0.10';
export const ARC_DEMO_PAY_TO = '0xb3FB14FEcac09efbD0C74Fc07d50d7eD1eef2B53';
export const CIRCLE_X402_FACILITATOR = 'https://gateway-api.circle.com/v1/x402';
export const PAID_ARC_DEMO_ROUTE = 'POST /demo/certify/paid';

function readEnv(env, name, fallback) {
  const value = typeof env[name] === 'string' ? env[name].trim() : '';
  return value || fallback;
}

function toAtomicUnits(decimal, decimals = ARC_USDC.decimals) {
  const [whole, fraction = ''] = String(decimal).split('.');
  if (!/^\d+$/.test(whole || '0') || !/^\d*$/.test(fraction) || fraction.length > decimals) {
    throw new Error(`${decimal} is not a ${decimals}-decimal USDC amount`);
  }
  return BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0');
}

export function resolveArcDemoPaymentConfig(env = process.env) {
  const payTo = readEnv(env, 'HALFLIFE_ARC_X402_PAY_TO', ARC_DEMO_PAY_TO);
  if (!/^0x[0-9a-fA-F]{40}$/.test(payTo)) {
    return { ok: false, reason: 'HALFLIFE_ARC_X402_PAY_TO is not a 20-byte 0x address' };
  }

  const priceUsdc = readEnv(env, 'HALFLIFE_ARC_X402_PRICE_USDC', ARC_DEMO_PRICE_USDC);
  let amount;
  try {
    amount = toAtomicUnits(priceUsdc).toString();
  } catch (error) {
    return { ok: false, reason: `HALFLIFE_ARC_X402_PRICE_USDC: ${error.message}` };
  }

  return {
    ok: true,
    network: ARC_MAINNET,
    facilitatorUrl: readEnv(env, 'HALFLIFE_ARC_X402_FACILITATOR', CIRCLE_X402_FACILITATOR),
    payTo,
    priceUsdc,
    accepts: {
      scheme: 'exact',
      network: ARC_MAINNET,
      payTo,
      price: {
        amount,
        asset: ARC_USDC.address,
        extra: { ...ARC_USDC.eip712Domain },
      },
    },
  };
}

export function buildArcDemoRoutes({ config }) {
  return {
    [PAID_ARC_DEMO_ROUTE]: {
      accepts: config.accepts,
      description:
        'One Halflife Arc certification: StressProof checks the agent, Halflife compares it with prior memory, and Halflife writes issue or revoke proof to Arc when the result changes.',
      mimeType: 'application/json',
    },
  };
}

export function createArcDemoPaymentGate({
  env = process.env,
  resourceServer,
  syncFacilitatorOnStart = true,
} = {}) {
  const config = resolveArcDemoPaymentConfig(env);
  if (!config.ok) {
    return {
      mode: 'misconfigured',
      enabled: false,
      middleware: null,
      reason: config.reason,
    };
  }

  const server =
    resourceServer ??
    new x402ResourceServer(new HTTPFacilitatorClient({ url: config.facilitatorUrl })).register(
      config.network,
      new ExactEvmScheme(),
    );
  const routes = buildArcDemoRoutes({ config });

  return {
    mode: 'live',
    enabled: true,
    config,
    routes,
    middleware: paymentMiddleware(routes, server, undefined, undefined, syncFacilitatorOnStart),
    reason: null,
  };
}
