/**
 * Sends a small amount of USDC on Arc mainnet from a wallet you control.
 * YOU run this yourself. It signs and sends a real transaction.
 *
 * The private key is typed into a hidden prompt, so it never lands in shell
 * history, an environment variable, or a file. Nothing is sent until you type
 * YES after seeing the sender, recipient, amount and fee.
 *
 * Usage, from the halflife directory:
 *
 *   node scripts/send-arc-usdc.mjs <toAddress> <amountUsdc>
 */

import readline from 'readline';
import { createPublicClient, createWalletClient, defineChain, http, parseUnits, formatUnits, getAddress, encodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const ARC_RPC_URL = 'https://rpc.mainnet.arc.io';
// Arc's USDC: the ERC-20 view of the same balance that pays gas, 6 decimals.
const USDC = '0x3600000000000000000000000000000000000000';
const arc = defineChain({
  id: 5042,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
});
const TRANSFER_ABI = [{ name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] }];

const [toArg, amountArg] = process.argv.slice(2);
if (!toArg || !amountArg) {
  console.error('Usage: node scripts/send-arc-usdc.mjs <toAddress> <amountUsdc>');
  process.exit(1);
}
const to = getAddress(toArg);
const amount = parseUnits(amountArg, 6);

function ask(question, hidden = false) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    // The question is printed before muting, otherwise the prompt itself is
    // hidden and the script looks frozen.
    process.stdout.write(question);
    if (hidden) rl._writeToOutput = () => {};
    rl.question('', (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

// Pasting often carries quotes or stray spaces; a real key is 64 hex characters.
let account;
for (let attempt = 1; attempt <= 3 && !account; attempt += 1) {
  const raw = await ask('Paste the SENDING wallet private key (it stays invisible), then press Enter: ', true);
  const hex = raw.replace(/["'\s]/g, '').replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{64}$/.test(hex)) {
    account = privateKeyToAccount(`0x${hex}`);
  } else {
    console.log(`  That was ${hex.length} characters; a private key is 64 letters and numbers (0-9, a-f). Try again.`);
  }
}
if (!account) {
  console.error('No valid key after 3 tries. Nothing sent.');
  process.exit(1);
}
const publicClient = createPublicClient({ chain: arc, transport: http(ARC_RPC_URL) });
const walletClient = createWalletClient({ account, chain: arc, transport: http(ARC_RPC_URL) });

const data = encodeFunctionData({ abi: TRANSFER_ABI, functionName: 'transfer', args: [to, amount] });
const [balance, gas, gasPrice] = await Promise.all([
  publicClient.getBalance({ address: account.address }),
  publicClient.estimateGas({ account, to: USDC, data }),
  publicClient.getGasPrice(),
]);
const fee = gas * gasPrice;
// Balance and fee are in 18 decimals; the transfer amount is 6.
const needed = amount * 10n ** 12n + fee;

console.log('');
console.log(`  From:    ${account.address}`);
console.log(`  To:      ${to}`);
console.log(`  Amount:  ${amountArg} USDC on Arc mainnet`);
console.log(`  Fee:     about ${formatUnits(fee, 18)} USDC`);
console.log(`  Balance: ${formatUnits(balance, 18)} USDC`);
console.log('');

if (balance < needed) {
  console.error(`Not enough USDC. Needs ${formatUnits(needed, 18)}, has ${formatUnits(balance, 18)}. Nothing sent.`);
  process.exit(1);
}
if (getAddress(account.address) === to) {
  console.error('Sender and recipient are the same wallet. Nothing sent.');
  process.exit(1);
}

const confirm = await ask('Type YES to send, anything else to cancel: ');
if (confirm !== 'YES') {
  console.log('Cancelled. Nothing sent.');
  process.exit(0);
}

const hash = await walletClient.sendTransaction({ to: USDC, data, gas: (gas * 12n) / 10n });
console.log(`Sent. Waiting for confirmation: ${hash}`);
const receipt = await publicClient.waitForTransactionReceipt({ hash });
console.log(`Status: ${receipt.status}`);
console.log(`View it: https://arc.etherscan.io/tx/${hash}`);
