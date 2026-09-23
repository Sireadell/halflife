/**
 * Can halflife afford the run it is about to sell?
 *
 * The paid Arc demo takes a visitor's money in middleware, before the handler
 * that spends halflife's own wallet on the StressProof run ever executes. So
 * the two steps can disagree: the visitor pays, and only then does halflife
 * discover it cannot buy the test. That is the one failure that costs a
 * stranger real money and returns nothing, and it happened live on 2026-09-22.
 *
 * This is the check that runs first. It is deliberately narrow.
 *
 * IT ONLY REFUSES ON A KNOWN SHORTFALL. A balance it cannot read is not
 * treated as empty. Refusing on an unreadable balance would mean an RPC hiccup
 * takes the paid route down, which is a worse failure than the one being
 * prevented and is not what the evidence says. Unknown leaves things exactly
 * as they were before this file existed; only a positively-known shortfall
 * closes the door.
 *
 * IT ONLY KNOWS HOW TO CHECK ARC. Circle settles Arc payments from a balance
 * deposited in its Gateway contract rather than from the wallet, so the
 * wallet's own USDC says nothing about whether a payment will succeed. That
 * deposited balance is the number that matters and the number this reads.
 */

const GATEWAY = '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee';
const ARC_RPC_URL = 'https://rpc.mainnet.arc.io';
const USDC_DECIMALS = 6;

const GATEWAY_ABI = [
  {
    name: 'availableBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ type: 'address' }, { type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
];

/** Whole USDC as a decimal string, to the atomic integer the contract uses. */
function toAtomic(amount) {
  const [whole, fraction = ''] = String(amount).split('.');
  return BigInt(whole || '0') * 10n ** BigInt(USDC_DECIMALS) + BigInt(fraction.padEnd(USDC_DECIMALS, '0') || '0');
}

function format(atomic) {
  const value = BigInt(atomic);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** The real on-chain read, kept behind a seam so tests never reach a network. */
async function readArcGatewayBalance({ asset, owner }) {
  const { createPublicClient, http, defineChain } = await import('viem');
  const arc = defineChain({
    id: 5042,
    name: 'Arc',
    nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
    rpcUrls: { default: { http: [ARC_RPC_URL] } },
  });
  const client = createPublicClient({ chain: arc, transport: http(ARC_RPC_URL) });
  return client.readContract({
    address: GATEWAY,
    abi: GATEWAY_ABI,
    functionName: 'availableBalance',
    args: [asset, owner],
  });
}

/**
 * @param {object} [deps]
 * @param {object} [deps.paidConfig] resolved payer config, or a falsy value
 *   when this deployment does not buy its runs
 * @param {Function} [deps.readBalance] the balance read, injected in tests
 * @param {number} [deps.cacheMs] how long a reading stays fresh
 * @param {Function} [deps.now] clock, injected in tests
 */
export function createUpstreamFundingCheck({
  paidConfig,
  readBalance = readArcGatewayBalance,
  cacheMs = 30_000,
  now = () => Date.now(),
} = {}) {
  let cached = null;

  return async function canAffordOneRun() {
    // Nothing is bought upstream on this deployment, so there is nothing that
    // could be unaffordable.
    if (!paidConfig?.ok) return { ok: true, checked: false };
    // Only Arc's deposited balance is understood. Saying "fine" here is the
    // honest answer to "is this affordable", not a claim that it is.
    if (!paidConfig.signsAgainstGateway) return { ok: true, checked: false };

    if (cached && now() - cached.at < cacheMs) return cached.result;

    let available;
    try {
      available = await readBalance({ asset: paidConfig.usdc, owner: paidConfig.payerAddress });
    } catch {
      // Unknown, not empty. See the header.
      return { ok: true, checked: false };
    }

    const needed = toAtomic(paidConfig.priceUsdc);
    const result =
      available >= needed
        ? { ok: true, checked: true }
        : {
            ok: false,
            checked: true,
            reason:
              `Halflife cannot buy the test run right now: it has ${format(available)} USDC deposited with Circle on Arc ` +
              `and one run costs ${format(needed)} USDC. Nothing has been charged, because charging for a run that ` +
              `cannot happen would take your money and return no certificate.`,
          };

    cached = { at: now(), result };
    return result;
  };
}
