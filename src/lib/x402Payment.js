/**
 * Halflife's side of the money.
 *
 * StressProof already has a payment module, and this is not a copy of it. That
 * one is the seller: it builds the 402 challenge and checks that whoever paid
 * is whoever proved consent. This one is the buyer, and a buyer's obligations
 * are different ones. It has to hold a key, decide whether a bill it was handed
 * is one it agreed to pay, and refuse rather than guess.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE.
 *
 *   1. NOTHING SECRET HAS A DEFAULT. A missing wallet, key, network, facilitator
 *      or upstream URL is a refusal with the variable named, never a fallback.
 *      The specific fallback that must never happen is the free demo route:
 *      halflife quietly certifying through a rate-limited demo endpoint would
 *      turn a paid product into a toy while every log line still said it was
 *      working. A loud refusal is recoverable, a silent downgrade is not.
 *
 *   2. HALFLIFE DECIDES WHAT IT WILL PAY, NOT THE SELLER. The 402 challenge is
 *      written by the other side. Signing whatever amount it names would mean
 *      an upstream that was compromised, misconfigured, or simply repriced
 *      could drain the wallet one re-certification at a time, and every one of
 *      those payments would look perfectly legitimate on chain. So the amount,
 *      the token, the network and the recipient are all checked against what
 *      halflife was configured to accept before anything is signed.
 */

/** Base networks halflife will pay on, by the name used in configuration. */
const NETWORKS = Object.freeze({
  base: Object.freeze({
    caip2: 'eip155:8453',
    usdc: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    label: 'Base mainnet',
    isTestnet: false,
  }),
  'base-sepolia': Object.freeze({
    caip2: 'eip155:84532',
    usdc: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
    label: 'Base Sepolia',
    isTestnet: true,
  }),
});

/** What one re-certification costs, in whole USDC. StressProof's published price. */
export const RECERTIFICATION_PRICE_USDC = '0.25';

/** USDC has six decimal places on both Base networks. */
const USDC_DECIMALS = 6;

export class PaidRunUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PaidRunUnavailableError';
  }
}

/** Whole USDC as a decimal string, to the atomic integer the protocol uses. */
export function toAtomicUsdc(amount) {
  const [whole, fraction = ''] = String(amount).split('.');
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > USDC_DECIMALS) {
    throw new PaidRunUnavailableError(`'${amount}' is not an amount of USDC halflife can express exactly`);
  }
  return BigInt(whole + fraction.padEnd(USDC_DECIMALS, '0'));
}

/**
 * Read the paid configuration, refusing on anything missing.
 *
 * Returns a refusal object rather than throwing, because the caller has to be
 * able to ask "can this deployment pay?" without wrapping it in a try. The
 * refusal names the variable, so the fix does not require reading this file.
 *
 * The private key is read here and never stored anywhere else, never logged,
 * never journalled and never returned in any result. What leaves this function
 * is the key itself, which the caller hands straight to a signer.
 */
export function resolvePaidConfig(env = process.env) {
  const missing = [];
  const read = (name) => {
    const value = (env[name] ?? '').trim();
    if (!value) missing.push(name);
    return value;
  };

  const baseUrl = read('HALFLIFE_STRESSPROOF_URL');
  const payerAddress = read('HALFLIFE_PAYER_ADDRESS');
  const privateKey = read('HALFLIFE_PAYER_PRIVATE_KEY');
  const networkName = read('HALFLIFE_PAYMENT_NETWORK');
  const facilitatorUrl = read('HALFLIFE_X402_FACILITATOR');

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      reason:
        `halflife cannot make a paid re-certification: ${missing.join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not set. Refusing rather than falling back to StressProof's ` +
        `free demo route, because a rate-limited demo answering in place of a paid run would look like success.`,
    };
  }

  if (!/^0x[0-9a-fA-F]{40}$/.test(payerAddress)) {
    return { ok: false, missing: [], reason: 'HALFLIFE_PAYER_ADDRESS is not a 20-byte 0x address' };
  }

  const network = NETWORKS[networkName];
  if (!network) {
    return {
      ok: false,
      missing: [],
      reason: `HALFLIFE_PAYMENT_NETWORK='${networkName}' is not a network halflife pays on. Known: ${Object.keys(NETWORKS).join(', ')}`,
    };
  }

  // A ceiling on one payment, separate from the price. The price is what we
  // expect; the ceiling is what we refuse to exceed no matter what changes
  // upstream. It has a default because it is not a secret and a missing
  // ceiling is more dangerous than a conservative one.
  const maxUsdc = (env.HALFLIFE_MAX_PAYMENT_USDC ?? RECERTIFICATION_PRICE_USDC).trim();

  let maxAtomic;
  try {
    maxAtomic = toAtomicUsdc(maxUsdc);
  } catch (error) {
    return { ok: false, missing: [], reason: `HALFLIFE_MAX_PAYMENT_USDC: ${error.message}` };
  }

  return {
    ok: true,
    baseUrl: baseUrl.replace(/\/$/, ''),
    payerAddress: payerAddress.toLowerCase(),
    privateKey,
    facilitatorUrl,
    networkName,
    network: network.caip2,
    networkLabel: network.label,
    isTestnet: network.isTestnet,
    usdc: network.usdc,
    priceUsdc: RECERTIFICATION_PRICE_USDC,
    maxUsdc,
    maxAtomic,
  };
}

/**
 * Pick the one payment requirement halflife is willing to satisfy out of a 402
 * challenge, or say why none of them is acceptable.
 *
 * Written as a pure function taking the decoded challenge, because this is the
 * moment halflife decides to spend real money and that decision should be
 * arguable by calling it rather than only observable by spending. Every field
 * checked here is one an upstream could change without telling us.
 */
export function chooseAcceptableRequirement(challenge, config) {
  const accepts = Array.isArray(challenge?.accepts) ? challenge.accepts : [];
  if (accepts.length === 0) {
    return { ok: false, reason: 'the 402 challenge offered no payment options at all' };
  }

  const rejected = [];
  for (const option of accepts) {
    const why = unacceptableBecause(option, config);
    if (why === null) return { ok: true, requirement: option };
    rejected.push(why);
  }

  return {
    ok: false,
    reason: `no payment option in the 402 challenge is one halflife agreed to pay: ${rejected.join('; ')}`,
  };
}

function unacceptableBecause(option, config) {
  if (option?.scheme !== 'exact') {
    return `scheme '${option?.scheme}' is not the exact scheme halflife signs`;
  }
  if (option?.network !== config.network) {
    // The network is checked before the amount on purpose. Paying the right
    // number on the wrong chain is not a smaller mistake than paying the wrong
    // number, and it is much harder to notice afterwards.
    return `network '${option?.network}' is not ${config.networkLabel} (${config.network})`;
  }
  if (String(option?.asset ?? '').toLowerCase() !== config.usdc) {
    return `asset ${option?.asset} is not USDC on ${config.networkLabel}`;
  }

  let atomic;
  try {
    atomic = BigInt(String(option?.maxAmountRequired ?? ''));
  } catch {
    return `maxAmountRequired '${option?.maxAmountRequired}' is not a whole number of atomic units`;
  }
  if (atomic > config.maxAtomic) {
    return `it asks for ${formatUsdc(atomic)} USDC, above the ${config.maxUsdc} ceiling halflife is configured to pay`;
  }
  if (!/^0x[0-9a-fA-F]{40}$/.test(String(option?.payTo ?? ''))) {
    return `payTo '${option?.payTo}' is not a wallet address`;
  }
  // The EIP-712 domain has to be present or the signature cannot be built at
  // all. StressProof's own payment module carries the scar of this being
  // missing, so it is checked here rather than discovered inside a library.
  if (!option?.extra?.name || !option?.extra?.version) {
    return 'it carries no EIP-712 domain (extra.name and extra.version), so nothing can be signed against it';
  }
  return null;
}

/** Atomic USDC back to a readable decimal, for messages and journal lines. */
export function formatUsdc(atomic) {
  const value = BigInt(atomic);
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(USDC_DECIMALS, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/**
 * The real signer, built only when one is actually needed.
 *
 * Imported lazily for one reason worth stating: the test suite must never load
 * a signing library or touch a key, and a top-level import would load it on
 * every test run whether or not a payment was involved. Nothing in this
 * function is exercised by the test suite, and the honesty table says so.
 */
export async function createX402Payer(config) {
  const [{ x402Client }, { registerExactEvmScheme }, { toClientEvmSigner }, { privateKeyToAccount }] =
    await Promise.all([
      import('@x402/core/client'),
      import('@x402/evm/exact/client'),
      import('@x402/evm'),
      import('viem/accounts'),
    ]);
  const { encodePaymentSignatureHeader } = await import('@x402/core/http');

  const key = config.privateKey.startsWith('0x') ? config.privateKey : `0x${config.privateKey}`;
  const account = privateKeyToAccount(key);

  if (account.address.toLowerCase() !== config.payerAddress) {
    // Caught here rather than at the facilitator. StressProof binds consent to
    // a named wallet, so a key that does not match the address published in
    // the consent file would pay successfully and then be refused a run, which
    // is the one failure that costs money and produces nothing.
    throw new PaidRunUnavailableError(
      'HALFLIFE_PAYER_PRIVATE_KEY belongs to a different wallet than HALFLIFE_PAYER_ADDRESS. ' +
        'The address in the consent file, the address that pays and the key that signs must all be the same wallet.',
    );
  }

  const client = new x402Client();
  registerExactEvmScheme(client, {
    signer: toClientEvmSigner(account),
    networks: [config.network],
  });

  return {
    address: config.payerAddress,
    async signPaymentHeader(challenge) {
      return encodePaymentSignatureHeader(await client.createPaymentPayload(challenge));
    },
  };
}
