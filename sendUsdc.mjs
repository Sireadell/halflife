// One-off script: send USDC on Base from one wallet to another.
// YOU run this yourself — it signs and sends a real transaction.
//
// Before running, set these in your PowerShell window:
//   $env:FROM_PRIVATE_KEY = "<the Sentinel wallet's private key>"
//   $env:TO_ADDRESS = "0x048c9d5697a900eb341931ded0e3f82090589d92"
//   $env:AMOUNT_USDC = "0.15"
//
// Then run:
//   node C:\Users\DELL\halflife\sendUsdc.mjs

import { createWalletClient, createPublicClient, http, encodeFunctionData, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';

const USDC_ADDRESS_ON_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_DECIMALS = 6;

function announce(line) {
  console.log(`\n>>> ${line}`);
}

const fromPrivateKey = process.env.FROM_PRIVATE_KEY;
const toAddress = process.env.TO_ADDRESS;
const amountUsdc = process.env.AMOUNT_USDC ?? '0.15';

announce('STEP 1: Checking inputs.');
if (!fromPrivateKey || !toAddress) {
  console.error('Set FROM_PRIVATE_KEY and TO_ADDRESS first, then run this again.');
  process.exit(1);
}

const account = privateKeyToAccount(fromPrivateKey.startsWith('0x') ? fromPrivateKey : `0x${fromPrivateKey}`);
console.log(`    Sending from: ${account.address}`);
console.log(`    Sending to:   ${toAddress}`);
console.log(`    Amount:       ${amountUsdc} USDC`);

const publicClient = createPublicClient({ chain: base, transport: http() });
const walletClient = createWalletClient({ account, chain: base, transport: http() });

announce('STEP 2: Checking the sending wallet actually has enough USDC and some ETH for gas.');
const usdcBalanceData = await publicClient.readContract({
  address: USDC_ADDRESS_ON_BASE,
  abi: [{ name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }],
  functionName: 'balanceOf',
  args: [account.address],
});
const ethBalance = await publicClient.getBalance({ address: account.address });
console.log(`    USDC balance: ${Number(usdcBalanceData) / 10 ** USDC_DECIMALS}`);
console.log(`    ETH balance (for gas): ${Number(ethBalance) / 1e18}`);

const amountToSend = parseUnits(amountUsdc, USDC_DECIMALS);
if (usdcBalanceData < amountToSend) {
  console.error('    Not enough USDC in the sending wallet. Stopping.');
  process.exit(1);
}
if (ethBalance === 0n) {
  console.error('    No ETH for gas in the sending wallet. Stopping.');
  process.exit(1);
}

announce('STEP 3: Sending the transaction.');
const data = encodeFunctionData({
  abi: [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }],
  functionName: 'transfer',
  args: [toAddress, amountToSend],
});

const hash = await walletClient.sendTransaction({ to: USDC_ADDRESS_ON_BASE, data });
console.log(`    Transaction sent. Hash: ${hash}`);

announce('STEP 4: Waiting for it to confirm on-chain.');
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`    Confirmed in block ${receipt.blockNumber}. Status: ${receipt.status}`);
console.log(`    View it: https://basescan.org/tx/${hash}`);
