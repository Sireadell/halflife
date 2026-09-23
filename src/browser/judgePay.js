import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { createWalletClient, createPublicClient, custom, defineChain, getAddress, http, parseUnits } from 'viem';

const ARC_CHAIN_ID = 5042;
const ARC_CAIP2 = 'eip155:5042';
const ARC_RPC_URL = 'https://rpc.mainnet.arc.io';
const ARC_EXPLORER = 'https://arc.etherscan.io';
// Halflife's own real demo agent (source: demo-agent/server.js in this repo,
// deployed separately at github.com/Sireadell/halflife-demo-agent). It's ours,
// so we could complete StressProof's one-time consent proof for it ourselves,
// a judge needs no cooperation from anyone to see a real run complete.
const SAMPLE_AGENT = 'https://halflife-demo-agent.onrender.com';
const SAMPLE_AGENT_ADDRESS = '0xb3FB14FEcac09efbD0C74Fc07d50d7eD1eef2B53';
const SAMPLE_BODY = { message: 'What is 2 plus 2?' };

// Circle settles this route's x402 payment from a balance the payer has already
// moved into its Gateway contract, not straight from the wallet's own USDC.
// Confirmed live 2026-09-20: a wallet holding plenty of USDC still gets
// "insufficient_balance" from Circle's facilitator if none of it has been
// deposited here first. So before paying, this checks the Gateway balance and,
// if it's short, asks the wallet to approve and deposit the shortfall.
const ARC_GATEWAY_ADDRESS = '0x77777777dcc4d5a8b6e418fd04d8997ef11000ee';
const ARC_USDC_ADDRESS = '0x3600000000000000000000000000000000000000';
const ERC20_ABI = [
  { name: 'approve', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }] },
  { name: 'allowance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] },
];
const GATEWAY_ABI = [
  { name: 'deposit', type: 'function', stateMutability: 'nonpayable', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [] },
  { name: 'availableBalance', type: 'function', stateMutability: 'view', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [{ type: 'uint256' }] },
];

const arcMainnet = defineChain({
  id: ARC_CHAIN_ID,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
  blockExplorers: { default: { name: 'ArcScan', url: ARC_EXPLORER } },
});

// @x402/evm's own ExactEvmScheme signs the EIP-3009 authorization against the
// asset address. Circle's Arc facilitator publishes a different verifyingContract
// (its GatewayWalletBatched) in `extra` and rejects anything signed against the
// token instead, so the domain is built from `extra` here. Verified against the
// live facilitator on 2026-09-20: the stock scheme fails with "invalid_signature",
// this one gets through to settlement.
const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
};

const randomNonce = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
};

class GatewayExactScheme {
  constructor(address, walletClient) {
    this.scheme = 'exact';
    this.address = address;
    this.walletClient = walletClient;
  }

  async createPaymentPayload(x402Version, requirements) {
    const now = Math.floor(Date.now() / 1000);
    const authorization = {
      from: this.address,
      to: getAddress(requirements.payTo),
      value: requirements.amount,
      validAfter: '0',
      validBefore: (now + requirements.maxTimeoutSeconds).toString(),
      nonce: randomNonce(),
    };

    const signature = await this.walletClient.signTypedData({
      account: this.address,
      domain: {
        name: requirements.extra.name,
        version: requirements.extra.version,
        chainId: ARC_CHAIN_ID,
        verifyingContract: getAddress(requirements.extra.verifyingContract ?? requirements.asset),
      },
      types: AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: getAddress(authorization.from),
        to: getAddress(authorization.to),
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce,
      },
    });

    return { x402Version, payload: { authorization, signature } };
  }
}

const byId = (id) => document.getElementById(id);
const esc = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);
const shortHash = (value) => {
  const text = String(value ?? '');
  return text.length > 20 ? `${text.slice(0, 10)}...${text.slice(-8)}` : text;
};
const setResult = (id, title, body, state = 'warn') => {
  const node = byId(id);
  if (!node) return;
  node.className = `result ${state}`;
  node.innerHTML = `<strong>${esc(title)}</strong>${esc(body)}`;
};
const setButtonBusy = (id, busy, text) => {
  const node = byId(id);
  if (!node) return;
  if (!node.dataset.idleText) node.dataset.idleText = node.textContent;
  node.disabled = Boolean(busy);
  node.textContent = text ?? node.dataset.idleText;
};
const setButtonReady = (id, text) => {
  const node = byId(id);
  if (!node) return;
  if (!node.dataset.idleText) node.dataset.idleText = node.textContent;
  node.disabled = false;
  node.textContent = text ?? node.dataset.idleText;
};
const showOutput = (id, text) => {
  const node = byId(id);
  if (!node) return;
  node.hidden = false;
  node.textContent = text;
};
const plainBodyText = (body) => {
  if (!body || typeof body !== 'object') return '';
  return [body.error, body.message, body.reason, body.next, body.status, body.detail].filter(Boolean).join(' ');
};
const samplePayload = () => ({
  targetUrl: SAMPLE_AGENT,
  agentAddress: SAMPLE_AGENT_ADDRESS,
  sampleBody: SAMPLE_BODY,
});

let walletAddress = null;
let paidFetch = null;
let walletClientRef = null;

const arcPublicClient = createPublicClient({ chain: arcMainnet, transport: http(ARC_RPC_URL) });

function showWallet(state, title, body) {
  setResult('wallet-status', title, body, state);
}

/**
 * Tops up the wallet's Gateway balance if it's short of `requiredAtomicAmount`.
 * Deposits only the shortfall, so this never moves more of the visitor's money
 * than the current run needs. Two on-chain transactions when a deposit is
 * needed (approve, then deposit); none when the Gateway balance already covers it.
 */
async function ensureGatewayBalance(walletClient, address, requiredAtomicAmount) {
  const available = await arcPublicClient.readContract({
    address: ARC_GATEWAY_ADDRESS,
    abi: GATEWAY_ABI,
    functionName: 'availableBalance',
    args: [ARC_USDC_ADDRESS, address],
  });
  if (available >= requiredAtomicAmount) {
    return { deposited: false };
  }

  const shortfall = requiredAtomicAmount - available;
  const walletBalance = await arcPublicClient.readContract({
    address: ARC_USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [address],
  });
  if (walletBalance < shortfall) {
    throw new Error(
      `Wallet does not hold enough Arc USDC. Needs ${shortfall} more atomic units in Circle's Gateway, wallet only holds ${walletBalance}.`,
    );
  }

  showWallet('warn', 'Depositing into Circle Gateway', 'Circle settles this payment from a balance held in its Gateway contract, not your wallet directly. Approve the deposit in your wallet.');
  const allowance = await arcPublicClient.readContract({
    address: ARC_USDC_ADDRESS,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [address, ARC_GATEWAY_ADDRESS],
  });
  if (allowance < shortfall) {
    const approveHash = await walletClient.writeContract({
      address: ARC_USDC_ADDRESS,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [ARC_GATEWAY_ADDRESS, shortfall],
    });
    await arcPublicClient.waitForTransactionReceipt({ hash: approveHash });
  }

  showWallet('warn', 'Depositing into Circle Gateway', 'Approval confirmed. Approve the deposit itself in your wallet.');
  const depositHash = await walletClient.writeContract({
    address: ARC_GATEWAY_ADDRESS,
    abi: GATEWAY_ABI,
    functionName: 'deposit',
    args: [ARC_USDC_ADDRESS, shortfall],
  });
  await arcPublicClient.waitForTransactionReceipt({ hash: depositHash });

  return { deposited: true, depositHash };
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function ensureArcNetwork(provider) {
  const chainId = `0x${ARC_CHAIN_ID.toString(16)}`;
  try {
    await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (error) {
    if (error?.code !== 4902) throw error;
    await provider.request({
      method: 'wallet_addEthereumChain',
      params: [{
        chainId,
        chainName: 'Arc',
        nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
        rpcUrls: [ARC_RPC_URL],
        blockExplorerUrls: [ARC_EXPLORER],
      }],
    });
  }
}

async function connectWallet() {
  if (!window.ethereum) {
    showWallet('bad', 'Wallet not found', 'Open this page in a browser with MetaMask or another injected wallet.');
    return null;
  }

  setButtonBusy('connect-wallet', true, 'Opening wallet');
  showWallet('warn', 'Opening wallet', 'Approve the connection, then approve Arc if your wallet asks.');
  try {
    await ensureArcNetwork(window.ethereum);
    const [address] = await window.ethereum.request({ method: 'eth_requestAccounts' });
    walletAddress = address;

    const walletClient = createWalletClient({
      account: address,
      chain: arcMainnet,
      transport: custom(window.ethereum),
    });
    walletClientRef = walletClient;
    const client = new x402Client().register(ARC_CAIP2, new GatewayExactScheme(address, walletClient));
    // Arc's USDC is not one of the SDK's built-in default assets, so without this
    // the client refuses the facilitator's own token before asking the wallet.
    client.setSpendControls({ allowedAssets: true });
    paidFetch = wrapFetchWithPayment(window.fetch.bind(window), client);

    setButtonReady('connect-wallet', `Connected ${shortHash(address)}`);
    showWallet('ok', 'Wallet connected', `Connected ${shortHash(address)} on Arc. The next button can pay and run the check.`);
    return address;
  } catch (error) {
    setButtonReady('connect-wallet', 'Connect wallet');
    throw error;
  }
}

// The facilitator's real rejection reason (self_transfer, insufficient_balance,
// authorization_validity_too_short, ...) travels in this header as base64 JSON,
// never in the response body, which stays "{}" on every rejection. Without
// decoding it, a real payment failure looks identical to "never tried to pay"
// and just repeats forever with no visible reason. Confirmed live 2026-09-22.
function decodeFacilitatorError(headers) {
  const header = headers?.get?.('payment-required');
  if (!header) return null;
  try {
    const decoded = JSON.parse(atob(header));
    return decoded?.error ?? null;
  } catch {
    return null;
  }
}

const FACILITATOR_ERROR_EXPLANATIONS = {
  self_transfer: 'The connected wallet is the same address the app is set to receive payment at. Connect a different wallet to pay.',
  insufficient_balance: "The connected wallet doesn't have enough deposited in Circle's Gateway to cover this payment.",
  authorization_validity_too_short: "The payment window offered was too short for Circle's facilitator to accept.",
  invalid_signature: 'The payment signature was not accepted. Try again, or reconnect the wallet.',
  unsupported_scheme: "The app and Circle's facilitator disagree on how to sign this payment.",
};

function summarizePaidResponse(status, body, headers) {
  const facilitatorError = decodeFacilitatorError(headers);
  if (facilitatorError) {
    return {
      title: 'Payment was rejected',
      body: FACILITATOR_ERROR_EXPLANATIONS[facilitatorError] ?? `Circle's facilitator refused this payment: ${facilitatorError}`,
      state: 'bad',
    };
  }

  const text = `${status} ${plainBodyText(body)}`.toLowerCase();
  if (status === 402 || text.includes('payment') || text.includes('x-payment')) {
    return {
      title: 'Payment needed',
      body: 'The app asked for payment. Connect a wallet and use the live pay button to continue.',
      state: 'warn',
    };
  }
  if (status >= 500 || text.includes('not configured') || text.includes('private key') || text.includes('arc writing')) {
    return {
      title: 'Stopped before charging',
      // The server says which refusal this is. Guessing "a setting is missing"
      // is wrong for the common case where halflife simply cannot afford the
      // upstream run, and that difference matters to someone deciding whether
      // to wait or give up.
      body:
        plainBodyText(body) ||
        'The server refused before taking payment. Nothing was charged.',
      state: 'warn',
    };
  }
  if (status >= 200 && status < 300) {
    // The server answers 200 even when it could not reach StressProof, because
    // the request itself was handled correctly. Saying "check completed" there
    // would tell the visitor they got something they did not actually get.
    if (body && body.measured === false) {
      return {
        title: 'Paid, but nothing was checked',
        body: `The payment went through, but Halflife could not run the check: ${body.unmeasurableReason ?? 'the run could not be measured'}. The certificate is unchanged.`,
        state: 'bad',
      };
    }
    return {
      title: 'Paid check completed',
      body: 'The payment was accepted and Halflife returned a certification result.',
      state: 'ok',
    };
  }
  if (status >= 400) {
    return {
      title: 'Request refused',
      body: 'The app rejected the request. Check the full response below for the reason.',
      state: 'warn',
    };
  }
  return {
    title: 'Response received',
    body: 'The app answered. Check the full response below for the exact result.',
    state: 'warn',
  };
}

async function loadAbout() {
  try {
    const response = await fetch('/about', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const arc = data.arcPaidDemo?.payment;
    const priceNote = byId('pay-price-note');
    if (priceNote) {
      const amount = arc?.price?.amount || '0.01';
      const currency = arc?.price?.currency || 'USDC';
      priceNote.textContent = arc?.enabled
        ? `Runs against Halflife's own demo agent for ${amount} ${currency}.`
        : "Runs against Halflife's own demo agent.";
    }
  } catch {
    // Status pill removed from the page; nothing to update here on failure.
  }
}

async function verifyArcProof() {
  setButtonBusy('verify-history', true, 'Verifying');
  setResult('arc-summary', 'Checking Arc now', 'Halflife is checking both proof records through the app.');
  showOutput('arc-verify-result', 'Checking Arc now...');
  try {
    const response = await fetch('/demo/arc-proof/verify', { headers: { accept: 'application/json' } });
    const body = await readJson(response);
    const proofs = Array.isArray(body.proofs) ? body.proofs : [];
    const allOk = Boolean(body.ok) || (proofs.length > 0 && proofs.every((item) => item.ok));
    const count = proofs.length || (body.ok ? 2 : 0);
    setResult(
      'arc-summary',
      allOk ? 'Arc proof verified' : 'Arc proof needs review',
      allOk
        ? `Halflife confirmed ${count} Arc records match the certificate history.`
        : 'Halflife did not confirm every Arc record. Check the full response below.',
      allOk ? 'ok' : 'bad',
    );
    showOutput('arc-verify-result', JSON.stringify(body, null, 2));
  } catch (error) {
    setResult('arc-summary', 'Could not verify Arc proof', error.message, 'bad');
    showOutput('arc-verify-result', JSON.stringify({ error: error.message }, null, 2));
  } finally {
    setButtonReady('verify-history', 'Verify both records');
  }
}

async function payAndRun() {
  setButtonBusy('pay-live', true, 'Preparing payment');
  try {
    if (!paidFetch) await connectWallet();
    if (!paidFetch) return;
    const payload = samplePayload();

    const aboutResponse = await fetch('/about', { headers: { accept: 'application/json' } });
    const about = await readJson(aboutResponse);
    const arcPayment = about.arcPaidDemo?.payment;

    // Checked before touching the wallet on purpose: ensureGatewayBalance below
    // spends real gas moving the visitor's money into Circle's Gateway. Doing
    // that before knowing the server can even accept payment means a visitor
    // pays a real on-chain cost for a run that was always going to be refused.
    if (!arcPayment?.enabled) {
      const reason = arcPayment?.reason || 'Arc writing is not configured on this deployment.';
      setResult('paid-summary', 'Cannot run a paid check here', reason, 'bad');
      showOutput('paid-route-result', JSON.stringify({ error: reason }, null, 2));
      return;
    }

    const priceUsdc = arcPayment.price?.amount ?? '0.01';
    const requiredAtomicAmount = parseUnits(priceUsdc, 6);

    setResult('paid-summary', 'Checking Gateway balance', 'Making sure enough Arc USDC is deposited with Circle before paying.');
    showOutput('paid-route-result', 'Checking Circle Gateway balance...');
    const gatewayResult = await ensureGatewayBalance(walletClientRef, walletAddress, requiredAtomicAmount);
    if (gatewayResult.deposited) {
      showOutput('paid-route-result', `Deposited into Circle Gateway: ${gatewayResult.depositHash}`);
    }

    setResult('paid-summary', 'Waiting for wallet', 'Approve the x402 payment in your wallet. The app will run after payment.');
    showOutput('paid-route-result', 'Waiting for wallet payment...');
    const response = await paidFetch('/demo/certify/paid', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await readJson(response);
    const summary = summarizePaidResponse(response.status, body, response.headers);
    setResult('paid-summary', summary.title, summary.body, summary.state);
    showOutput('paid-route-result', JSON.stringify({ status: response.status, payer: walletAddress, body }, null, 2));
  } catch (error) {
    setResult('paid-summary', 'Live payment did not complete', error.message, 'bad');
    showOutput('paid-route-result', JSON.stringify({ error: error.message }, null, 2));
  } finally {
    setButtonReady('pay-live', 'Pay and run live check');
  }
}

function boot() {
  byId('verify-history').addEventListener('click', verifyArcProof);
  byId('connect-wallet').addEventListener('click', () => connectWallet().catch((error) => {
    showWallet('bad', 'Wallet connection failed', error.message);
  }));
  byId('pay-live').addEventListener('click', payAndRun);

  loadAbout();
}

boot();
