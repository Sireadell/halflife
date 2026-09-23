/**
 * Registers an agent in Arc's ERC-8004 Identity Registry from the agent
 * OWNER's wallet, once, so Halflife can rate it.
 *
 * Why the owner and not Halflife: the Reputation Registry refuses feedback
 * from an agent's owner ("Self-feedback not allowed"). If Halflife registered
 * the agent it would own it and could never rate it. So the owner registers,
 * and the printed agent id goes into Halflife's HALFLIFE_ERC8004_AGENT_IDS.
 *
 * Usage, from the halflife directory:
 *
 *   AGENT_OWNER_KEY_FILE=path/to/key node scripts/register-erc8004-agent.mjs <agentURI> [rater]
 *
 * With DRY_RUN=1 it reports the owner balance and the expected cost, simulates
 * the registration and the rater's first feedback, and sends nothing.
 */

import { readFileSync } from 'fs';
import { createPublicClient, createWalletClient, defineChain, http, formatUnits, zeroHash, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { DEFAULT_IDENTITY_REGISTRY, DEFAULT_REPUTATION_REGISTRY, IDENTITY_ABI, REPUTATION_ABI } from '../src/lib/erc8004.js';

const ARC_RPC_URL = 'https://rpc.mainnet.arc.io';
const arc = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
});

const [agentURI, rater] = process.argv.slice(2);
if (!agentURI) throw new Error('Pass the agent URI to register.');
const keyFile = process.env.AGENT_OWNER_KEY_FILE;
if (!keyFile) throw new Error('Set AGENT_OWNER_KEY_FILE to the owner key file.');
const key = readFileSync(keyFile, 'utf8').trim();
const account = privateKeyToAccount(key.startsWith('0x') ? key : `0x${key}`);

const publicClient = createPublicClient({ chain: arc, transport: http(ARC_RPC_URL) });
const walletClient = createWalletClient({ account, chain: arc, transport: http(ARC_RPC_URL) });

const balance = await publicClient.getBalance({ address: account.address });
const gasPrice = await publicClient.getGasPrice();
const gas = await publicClient.estimateGas({
  account,
  to: DEFAULT_IDENTITY_REGISTRY,
  data: (await import('viem')).encodeFunctionData({ abi: IDENTITY_ABI, functionName: 'register', args: [agentURI] }),
});
const cost = gas * gasPrice;
console.log('owner', account.address);
console.log('balance USDC', formatUnits(balance, 18));
console.log('register gas', gas.toString(), 'at', formatUnits(gasPrice, 9), 'gwei = USDC', formatUnits(cost, 18));

const { request, result } = await publicClient.simulateContract({
  account,
  address: DEFAULT_IDENTITY_REGISTRY,
  abi: IDENTITY_ABI,
  functionName: 'register',
  args: [agentURI],
});
console.log('simulated agent id', result.toString());

if (process.env.DRY_RUN) {
  console.log('DRY_RUN set, nothing sent.');
  process.exit(0);
}
if (balance < cost) throw new Error(`Owner needs at least ${formatUnits(cost, 18)} USDC for gas.`);

// viem's default fee cap is twice the base fee, and the node refuses any
// transaction whose worst case exceeds the balance. Arc's base fee sits at its
// floor, so a cap just above the current price lets a small wallet pay.
const block = await publicClient.getBlock();
const maxPriorityFeePerGas = gasPrice > block.baseFeePerGas ? gasPrice - block.baseFeePerGas : 0n;
const maxFeePerGas = (gasPrice * 110n) / 100n;
if (gas * maxFeePerGas > balance) {
  throw new Error(`Owner needs at least ${formatUnits(gas * maxFeePerGas, 18)} USDC at the capped fee.`);
}
const txHash = await walletClient.writeContract({ ...request, gas, maxFeePerGas, maxPriorityFeePerGas });
const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
if (receipt.status !== 'success') throw new Error(`register ${txHash} reverted`);
console.log('registered tx', txHash);
console.log('agent id', result.toString());

if (rater) {
  // Proves the point of this script: the rater, not being the owner, may rate.
  await publicClient.simulateContract({
    account: getAddress(rater),
    address: DEFAULT_REPUTATION_REGISTRY,
    abi: REPUTATION_ABI,
    functionName: 'giveFeedback',
    args: [result, 100n, 0, 'halflife', 'RESILIENT', agentURI, '/c/check', zeroHash],
  });
  console.log('rater', rater, 'can give feedback: yes (simulated)');
}
