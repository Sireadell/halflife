// Demo script: shows Halflife being hired and paid through the live Virtuals
// marketplace, and proves it actually answered.
//
// Run from PowerShell inside C:\Users\DELL\halflife:
//   node .\testAcpJob.mjs
//
// Set these three values first (not saved anywhere, only used while this runs):
//   $env:BUYER_WALLET_ADDRESS = "0x048c9d5697a900eb341931ded0e3f82090589d92"
//   $env:BUYER_WALLET_ID = "xo3wvvg3axi8gfv1brjetr3b"
//   $env:BUYER_SIGNER_KEY = "<the key from Virtuals' Add Key screen>"
//
// This spends real USDC, approximately 10 to 15 cents, when it runs.

import { AcpAgent, PrivyAlchemyEvmProviderAdapter } from '@virtuals-protocol/acp-node-v2';
import { base } from 'viem/chains';

const HALFLIFE_PROVIDER_ADDRESS = '0xe040d1928b45d6045d8c74c823aa223919ab1999';
const STRESSPROOF_HEALTH_URL = 'https://stressproof-6g88.onrender.com/health';
const MAX_WAIT_SECONDS = 90;
const MAX_PRICE_WAIT_SECONDS = 90;

// Colors disabled: this terminal doesn't render ANSI escape codes (confirmed
// by testing), so every value is blank instead of an escape sequence. The
// structure (dividers, step numbers, checkmarks) still prints, just uncolored.
const color = {
  reset: '',
  bold: '',
  dim: '',
  cyan: '',
  blue: '',
  green: '',
  yellow: '',
  red: '',
  white: '',
};

function say(line = '') {
  console.log(line);
}

function divider() {
  say(`${color.dim}────────────────────────────────────────────────────────────────${color.reset}`);
}

function step(number, title, detail) {
  say('');
  say(`${color.cyan}${color.bold}  ${number}  ${color.reset}${color.bold}${title}${color.reset}`);
  if (detail) say(`     ${color.dim}${detail}${color.reset}`);
}

function complete(message) {
  say(`     ${color.green}✓${color.reset} ${message}`);
}

say('');
say(`${color.cyan}${color.bold}  H A L F L I F E${color.reset}`);
say(`${color.dim}  Continuous trust certificates for AI agents${color.reset}`);
divider();
say('');
say(`${color.bold}  LIVE MARKETPLACE DEMO${color.reset}`);
say(`  A buyer agent is about to hire Halflife through Virtuals.`);
say(`  Halflife will check whether StressProof is still trustworthy.`);
say('');
say(`${color.yellow}  Real USDC payment. Live Base network. Live agent response.${color.reset}`);

const walletAddress = process.env.BUYER_WALLET_ADDRESS;
const walletId = process.env.BUYER_WALLET_ID;
const signerPrivateKey = process.env.BUYER_SIGNER_KEY;

if (!walletAddress || !walletId || !signerPrivateKey) {
  say('');
  divider();
  say(`${color.red}${color.bold}  SETUP NEEDED${color.reset}`);
  say(`  This demo needs the buyer wallet details before it can continue.`);
  say(`  Add the three BUYER_WALLET values shown at the top of this file.`);
  divider();
  process.exit(1);
}

step('01', 'Connect buyer wallet', 'Securely signing in as the paying customer');

const provider = await PrivyAlchemyEvmProviderAdapter.create({
  walletAddress,
  walletId,
  signerPrivateKey,
  chains: [base],
});
const buyer = await AcpAgent.create({ evmProvider: provider });
await buyer.start();

complete('Buyer wallet connected and ready to transact.');

step('02', 'Hire Halflife', 'Submitting the request to the live marketplace');
say(`     ${color.dim}Question: Is StressProof still trustworthy right now?${color.reset}`);

const jobId = await buyer.createJobByOfferingName(
  base.id,
  'certifyStanding',
  HALFLIFE_PROVIDER_ADDRESS,
  { target: STRESSPROOF_HEALTH_URL },
  {},
);

complete(`Request accepted. Job created: ${color.white}${jobId}${color.reset}`);

// A job created this way is only a request. Halflife has to quote a price
// first (it sets the budget on its side), and then the buyer has to actually
// pay it. Until the buyer funds the job, Halflife is not allowed to start
// work, which is why the job would otherwise sit at "open" forever.
step('03', 'Wait for Halflife to quote a price', 'Halflife is putting a price on the request');

const priceDeadline = Date.now() + MAX_PRICE_WAIT_SECONDS * 1000;
let session = null;
let quotedJob = null;
let priceDots = '';

while (Date.now() < priceDeadline) {
  await new Promise((resolve) => setTimeout(resolve, 3000));

  priceDots = priceDots.length >= 3 ? '' : `${priceDots}.`;
  process.stdout.write(`\r     ${color.cyan}Waiting${priceDots.padEnd(3, ' ')}${color.reset}${color.dim} Halflife is quoting a price for the job${color.reset}`);

  session = buyer.getSession(base.id, jobId.toString());
  if (!session) continue;

  let job = null;
  try {
    job = await session.fetchJob();
  } catch {
    continue;
  }

  if (job && job.budget && job.budget.amount > 0) {
    quotedJob = job;
    break;
  }
}

say('');

if (!quotedJob) {
  say('');
  divider();
  say(`${color.yellow}${color.bold}  NO PRICE QUOTED YET${color.reset}`);
  say(`  Halflife has not put a price on job ${jobId} within ${MAX_PRICE_WAIT_SECONDS} seconds,`);
  say(`  so there is nothing to pay for yet. No money has been spent.`);
  divider();
  process.exit(2);
}

complete(`Halflife quoted ${color.white}${quotedJob.budget.amount} ${quotedJob.budget.symbol}${color.reset} for this job.`);

step('04', 'Pay for the job', 'Sending the live USDC payment so Halflife can start work');

await session.fetchJob();
await session.fund();

complete('Payment sent. Halflife is now cleared to do the work.');

step('05', 'Await independent verification', 'Halflife is checking StressProof in real time');

const deadline = Date.now() + MAX_WAIT_SECONDS * 1000;
let deliverable = null;
let finalStatus = null;
let waitingDots = '';

while (Date.now() < deadline) {
  await new Promise((resolve) => setTimeout(resolve, 3000));

  waitingDots = waitingDots.length >= 3 ? '' : `${waitingDots}.`;
  process.stdout.write(`\r     ${color.cyan}Checking${waitingDots.padEnd(3, ' ')}${color.reset}${color.dim} Halflife is processing the live request${color.reset}`);

  session = buyer.getSession(base.id, jobId.toString()) ?? session;
  if (!session) continue;
  finalStatus = session.status;

  const delivery = session.entries.find((entry) => entry.contentType === 'deliverable');
  if (delivery) {
    deliverable = delivery.content;
    break;
  }

  // Fallback: the answer is also recorded on the job itself once submitted.
  try {
    const latest = await session.fetchJob();
    if (latest?.deliverable) {
      deliverable = latest.deliverable;
      break;
    }
  } catch {
    // ignore a single failed refresh and try again on the next tick
  }
  if (finalStatus === 'completed' || finalStatus === 'rejected' || finalStatus === 'expired') break;
}

say('');
say('');

if (deliverable) {
  divider();
  say('');
  say(`${color.green}${color.bold}  ✓ LIVE JOB COMPLETE${color.reset}`);
  say('');
  say(`  ${color.bold}Halflife answered successfully.${color.reset}`);
  say(`  The buyer hired Halflife through Virtuals and the payment settled.`);
  say('');
  say(`${color.cyan}${color.bold}  HALFLIFE'S VERDICT${color.reset}`);
  divider();

  try {
    console.log(JSON.stringify(JSON.parse(deliverable), null, 2));
  } catch {
    console.log(deliverable);
  }

  say('');
  divider();
  say(`${color.dim}  Halflife keeps trust certificates current by checking again over time.${color.reset}`);
  say('');
} else {
  divider();
  say('');
  say(`${color.yellow}${color.bold}  RESPONSE NOT YET CONFIRMED${color.reset}`);
  say('');
  say(`  Halflife has not returned a confirmed answer within ${MAX_WAIT_SECONDS} seconds.`);
  say(`  Last known job status: ${color.white}${finalStatus ?? 'unknown'}${color.reset}`);
  say('');
  say(`${color.dim}  The request may still be processing. Check the live Halflife job log:${color.reset}`);
  say(`  https://halflife-b0o4.onrender.com/about`);
  say('');
  divider();
}

process.exit(deliverable ? 0 : 2);
