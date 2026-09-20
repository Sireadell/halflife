// A viem chain definition for Arc, plus a plain-wallet client factory.
//
// Arc is new enough that viem does not ship it as a built-in chain, so it is
// defined by hand here rather than imported from viem/chains. Arc's own docs
// give chain id 5042 for mainnet and 5042002 for testnet, with USDC as the
// native gas token (18 decimals on chain, unlike the 6-decimal USDC token
// most EVM chains use for transfers).
//
// This does not extend any third-party SDK adapter. Halflife's existing
// on-chain code (eoaViemProviderAdapter.mjs) was built for the Virtuals ACP
// network, an unrelated standard. Arc needs nothing from that SDK, just a
// plain wallet that can send a transaction and wait for it to confirm.

import { createPublicClient, createWalletClient, http, defineChain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

export const arcMainnet = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: [read('ARC_RPC_URL') ?? 'https://rpc.mainnet.arc.io'] },
  },
  blockExplorers: {
    default: { name: 'ArcScan', url: 'https://arc.etherscan.io' },
  },
});

export const arcTestnet = defineChain({
  id: 5042002,
  name: 'Arc Testnet',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: {
    default: { http: [read('ARC_TESTNET_RPC_URL') ?? 'https://rpc.testnet.arc.io'] },
  },
  blockExplorers: {
    default: { name: 'ArcScan Testnet', url: 'https://testnet.arc.etherscan.io' },
  },
});

function read(name) {
  return typeof process !== 'undefined' ? process.env[name] : undefined;
}

/**
 * Turns a private key into a wallet that can read from and write to Arc.
 *
 * The key is used once, in memory, to derive the account. It is never
 * logged, stored, or included in any error message, matching the rule the
 * Virtuals adapter already follows.
 *
 * @param {{ privateKey: string, chain?: import('viem').Chain, rpcUrl?: string }} params
 */
export function createArcClients({ privateKey, chain = arcMainnet, rpcUrl }) {
  if (!privateKey || typeof privateKey !== 'string') {
    throw new Error('createArcClients: a private key is required.');
  }
  const trimmed = privateKey.trim();
  const normalised = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(normalised)) {
    throw new Error(
      'createArcClients: the private key is not in the expected format ' +
        '(64 hex characters, with or without a leading 0x).',
    );
  }

  const account = privateKeyToAccount(normalised);
  const transport = http(rpcUrl ?? chain.rpcUrls.default.http[0]);
  const publicClient = createPublicClient({ chain, transport });
  const walletClient = createWalletClient({ account, chain, transport });

  return { account, chain, publicClient, walletClient };
}
