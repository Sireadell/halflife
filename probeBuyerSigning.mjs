// SAFE PROBE. Spends nothing. Creates no job. Touches no dashboard.
//
// It does exactly one thing: asks the Virtuals server to sign a short throwaway
// text string with the buyer wallet's key. That is the very step that is
// failing right now with "Server error 500", and it is the step that happens
// BEFORE any job or any payment. If this prints a signature, the buyer agent is
// working and you can run testAcpJob.mjs for real.
//
// Run from PowerShell inside C:\Users\DELL\halflife, with the same three values
// you set before:
//   node .\probeBuyerSigning.mjs

import { PrivyAlchemyEvmProviderAdapter } from '@virtuals-protocol/acp-node-v2';
import { base } from 'viem/chains';

const walletAddress = process.env.BUYER_WALLET_ADDRESS;
const walletId = process.env.BUYER_WALLET_ID;
const signerPrivateKey = process.env.BUYER_SIGNER_KEY;

if (!walletAddress || !walletId || !signerPrivateKey) {
  console.error('Set BUYER_WALLET_ADDRESS, BUYER_WALLET_ID and BUYER_SIGNER_KEY first.');
  process.exit(1);
}

console.log(`Wallet address: ${walletAddress}`);
console.log(`Wallet id:      ${walletId}`);

// First: is this wallet address even known to Virtuals as an agent?
// A 404 here means "the agent is not registered / wrong address".
const lookup = await fetch(
  `https://api.acp.virtuals.io/wallets/sign-message`,
  {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress, walletId, message: 'probe', encoding: 'utf-8', authorizationSignature: 'deliberately-invalid' }),
  },
);
console.log(`\nAgent lookup check: HTTP ${lookup.status}`);
console.log(`  ${(await lookup.text()).slice(0, 300)}`);
console.log('  404 "Agent not found" = wrong wallet address, or the agent is not registered.');
console.log('  500 = the address IS a known agent; the failure is in the signing key step.');

// Second: the real signing attempt, with the real key. Still no money.
console.log('\nNow trying a real signature with your key (still spends nothing)...');
try {
  const provider = await PrivyAlchemyEvmProviderAdapter.create({
    walletAddress,
    walletId,
    signerPrivateKey,
    chains: [base],
  });
  const signature = await provider.signMessage(base.id, `probe:${Date.now()}`);
  console.log('\nSUCCESS. The buyer wallet can sign. Signature starts with:', String(signature).slice(0, 20));
  console.log('You can now run: node .\\testAcpJob.mjs');
} catch (error) {
  console.log('\nSTILL FAILING:', error?.shortMessage ?? error?.message ?? error);
  if (error?.details) console.log('Details:', error.details);
  console.log('\nIf this says "Server error 500", the wallet id or the signer key is not');
  console.log('accepted for this wallet. Re-check that the wallet id is the EVM one');
  console.log('(not the Solana one) and that the key was added to THIS agent.');
}
