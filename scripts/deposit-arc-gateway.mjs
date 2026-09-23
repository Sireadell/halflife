/**
 * One-time top-up of Halflife's Arc balance inside Circle's Gateway.
 *
 * Why this exists as a script rather than as part of a paid request:
 *
 * Circle does not settle an Arc x402 payment from the wallet's own USDC. It
 * settles from a balance the payer has already moved into its GatewayWallet
 * contract. A wallet holding plenty of USDC still gets "insufficient_balance"
 * from the facilitator if nothing has been deposited here first, which is the
 * confusing part: the money is visible on chain and still cannot be spent.
 *
 * Depositing costs two on-chain transactions (approve, then deposit). Doing
 * that inside a request a visitor is waiting on would add both latency and two
 * new ways for their paid run to fail, so it is deliberately a separate,
 * deliberate action a human runs.
 *
 * Usage, from the halflife directory:
 *
 *   HALFLIFE_PAYER_PRIVATE_KEY=0x... node scripts/deposit-arc-gateway.mjs 0.05
 *
 * Pass the amount in whole USDC. With no amount it reports balances and exits
 * without sending anything, which is the safe way to check where things stand.
 */

import { createPublicClient, createWalletClient, defineChain, http, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ARC_RPC_URL = 'https://rpc.mainnet.arc.io';
const ARC_EXPLORER = 'https://arc.etherscan.io';
const GATEWAY = '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee';
const USDC = '0x3600000000000000000000000000000000000000';
const USDC_DECIMALS = 6;

const arc = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
  blockExplorers: { default: { name: 'ArcScan', url: ARC_EXPLORER } },
});

const ERC20_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];

const GATEWAY_ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
  { name: 'availableBalance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
];

const usdc = (atomic) => `${formatUnits(atomic, USDC_DECIMALS)} USDC`;

const rawKey = process.env.HALFLIFE_PAYER_PRIVATE_KEY;
if (!rawKey) {
  console.error('HALFLIFE_PAYER_PRIVATE_KEY is not set. Refusing to guess which wallet to spend from.');
  process.exit(1);
}

const account = privateKeyToAccount(rawKey.startsWith('0x') ? rawKey : `0x${rawKey}`);
const publicClient = createPublicClient({ chain: arc, transport: http(ARC_RPC_URL) });
const walletClient = createWalletClient({ account, chain: arc, transport: http(ARC_RPC_URL) });

const read = (address, abi, functionName, args) =>
  publicClient.readContract({ address, abi, functionName, args });

const [walletBalance, gatewayBalance] = await Promise.all([
  read(USDC, ERC20_ABI, 'balanceOf', [account.address]),
  read(GATEWAY, GATEWAY_ABI, 'availableBalance', [USDC, account.address]),
]);

console.log(`wallet          ${account.address}`);
console.log(`in wallet       ${usdc(walletBalance)}`);
console.log(`in Gateway      ${usdc(gatewayBalance)}   <- what Circle can actually spend`);

const requested = process.argv[2];
if (!requested) {
  console.log('\nNo amount given, so nothing was sent. Pass one to deposit, e.g. `node scripts/deposit-arc-gateway.mjs 0.05`.');
  process.exit(0);
}

const amount = parseUnits(requested, USDC_DECIMALS);
if (amount <= 0n) {
  console.error('The amount must be greater than zero.');
  process.exit(1);
}
if (amount > walletBalance) {
  console.error(`\nThe wallet holds ${usdc(walletBalance)}, which is less than the ${usdc(amount)} requested.`);
  process.exit(1);
}

console.log(`\nDepositing ${usdc(amount)} into the Gateway. Two transactions, approve then deposit.`);

const allowance = await read(USDC, ERC20_ABI, 'allowance', [account.address, GATEWAY]);
if (allowance < amount) {
  const approveHash = await walletClient.writeContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [GATEWAY, amount],
  });
  console.log(`approve  ${ARC_EXPLORER}/tx/${approveHash}`);
  await publicClient.waitForTransactionReceipt({ hash: approveHash });
} else {
  console.log('approve  not needed, the existing allowance already covers this');
}

const depositHash = await walletClient.writeContract({
  address: GATEWAY,
  abi: GATEWAY_ABI,
  functionName: 'deposit',
  args: [USDC, amount],
});
console.log(`deposit  ${ARC_EXPLORER}/tx/${depositHash}`);
await publicClient.waitForTransactionReceipt({ hash: depositHash });

const after = await read(GATEWAY, GATEWAY_ABI, 'availableBalance', [USDC, account.address]);
console.log(`\nGateway balance is now ${usdc(after)}, enough for ${after / 5000n} run(s) at 0.005 each.`);
