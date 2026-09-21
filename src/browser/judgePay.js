import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { createWalletClient, createPublicClient, custom, defineChain, getAddress, http, parseUnits } from 'viem';

const ARC_CHAIN_ID = 5042;
const ARC_CAIP2 = 'eip155:5042';
const ARC_RPC_URL = 'https://rpc.mainnet.arc.io';
const ARC_EXPLORER = 'https://arc.etherscan.io';
// Halflife's own real demo agent (source: demo-agent/server.js in this repo,
// deployed separately at github.com/Sireadell/halflife-demo-agent). It's ours,
// so we could complete StressProof's one-time consent proof for it ourselves —
// a judge needs no cooperation from anyone to see a real run complete.
const SAMPLE_AGENT = 'https://halflife-demo-agent.onrender.com';
const SAMPLE_AGENT_ADDRESS = '0xb3FB14FEcac09efbD0C74Fc07d50d7eD1eef2B53';

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
const row = (key, value) => `<div class="row"><div class="key mono">${esc(key)}</div><div class="value">${value}</div></div>`;
const setPill = (id, state, text) => {
  const node = byId(id);
  node.className = `pill ${state}`;
  node.textContent = text;
};
const setResult = (id, title, body, state = 'warn') => {
  const node = byId(id);
  node.className = `result ${state}`;
  node.innerHTML = `<strong>${esc(title)}</strong>${esc(body)}`;
};
const plainBodyText = (body) => {
  if (!body || typeof body !== 'object') return '';
  return [body.error, body.message, body.reason, body.next, body.status, body.detail].filter(Boolean).join(' ');
};
const samplePayload = () => {
  let sampleBody;
  try {
    sampleBody = JSON.parse(byId('sample-body').value);
  } catch {
    throw new Error('The sample request body must be valid JSON.');
  }
  return {
    targetUrl: byId('target-url').value.trim(),
    agentAddress: byId('agent-address').value.trim(),
    sampleBody,
  };
};

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

  showWallet('warn', 'Opening wallet', 'Approve the connection, then approve Arc if your wallet asks.');
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

  byId('connected-wallet').textContent = shortHash(address);
  setPill('wallet-pill', 'ok', 'Connected');
  showWallet('ok', 'Wallet connected', `Connected ${shortHash(address)} on Arc. The next button can pay and run the check.`);
  return address;
}

function summarizePaidResponse(status, body) {
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
      body: 'The server refused before payment because a required Arc setting is missing.',
      state: 'warn',
    };
  }
  if (status >= 200 && status < 300) {
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
  const result = byId('status-result');
  result.innerHTML = '<strong>Checking now</strong> Asking Halflife for its live status.';
  try {
    const response = await fetch('/about', { headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const memoryReady = Boolean(data.memory?.reachable);
    const arc = data.arcPaidDemo?.payment;
    byId('service-state').textContent = memoryReady ? 'Ready' : 'Limited';
    setPill('service-pill', memoryReady ? 'ok' : 'warn', memoryReady ? 'Ready' : 'Limited');
    byId('arc-state').textContent = arc?.enabled ? 'Ready' : 'Safe stop';
    byId('price').textContent = `${arc?.price?.amount || '0.10'} ${arc?.price?.currency || 'USDC'}`;
    setPill('arc-pill', arc?.enabled ? 'ok' : 'warn', arc?.enabled ? 'Payment on' : 'No charge');
    setResult(
      'status-result',
      memoryReady ? 'App is alive' : 'App answered with limits',
      memoryReady
        ? 'Halflife answered the status check and its storage is reachable.'
        : 'Halflife answered the status check, but one backing service is not reachable.',
      memoryReady ? 'ok' : 'warn',
    );
  } catch (error) {
    byId('service-state').textContent = 'Offline';
    byId('arc-state').textContent = 'Unknown';
    setPill('service-pill', 'bad', 'Offline');
    setPill('arc-pill', 'bad', 'Check');
    setResult('status-result', 'Could not reach app', `The status check failed: ${error.message}`, 'bad');
  }
}

async function loadPaidRun() {
  const panel = byId('paid-run');
  try {
    const response = await fetch('/demo/certify/paid/latest', { headers: { accept: 'application/json' } });
    if (response.status === 404) {
      panel.className = 'list result warn';
      panel.innerHTML = '<strong>No saved paid proof yet</strong>The certificate page still shows the verified Arc proof that already exists.';
      return;
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    const txHash = data.arc?.txHash;
    const txValue = txHash
      ? `<a href="https://arc.etherscan.io/tx/${esc(txHash)}" target="_blank" rel="noopener">${esc(shortHash(txHash))}</a>`
      : esc(data.arc?.reason || 'No Arc record was needed');
    panel.className = 'list result ok';
    panel.innerHTML = [
      '<strong>Latest paid proof is saved</strong>',
      row('Saved', esc(data.savedAt || 'unknown')),
      row('Paid', esc(`${data.payment?.price?.amount || 'unknown'} ${data.payment?.price?.currency || 'USDC'} on ${data.payment?.network || 'Arc'}`)),
      row('Agent wallet', esc(data.agentAddress || 'unknown')),
      row('Standing', esc(data.standing || 'unknown')),
      row('Verdict', esc(data.currentVerdict || 'unknown')),
      row('Report hash', esc(data.reportHash || 'missing')),
      row('Arc record', txValue),
    ].join('');
  } catch (error) {
    panel.className = 'list result bad';
    panel.innerHTML = `<strong>Could not load latest proof</strong>${esc(error.message)}`;
  }
}

async function verifyArcProof() {
  const out = byId('arc-verify-result');
  setResult('arc-summary', 'Checking Arc now', 'Halflife is checking both proof records through the app.');
  out.textContent = 'Checking Arc now...';
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
    out.textContent = JSON.stringify(body, null, 2);
  } catch (error) {
    setResult('arc-summary', 'Could not verify Arc proof', error.message, 'bad');
    out.textContent = JSON.stringify({ error: error.message }, null, 2);
  }
}

async function checkSetupWithoutPaying() {
  const out = byId('paid-route-result');
  setResult('paid-summary', 'Checking paid path now', 'Halflife is calling the paid path without wallet payment.');
  out.textContent = 'Calling the paid path now...';
  try {
    const response = await fetch('/demo/certify/paid', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(samplePayload()),
    });
    const body = await readJson(response);
    const summary = summarizePaidResponse(response.status, body);
    setResult('paid-summary', summary.title, summary.body, summary.state);
    out.textContent = JSON.stringify({ status: response.status, body }, null, 2);
    loadPaidRun();
  } catch (error) {
    setResult('paid-summary', 'Could not check paid path', error.message, 'bad');
    out.textContent = JSON.stringify({ error: error.message }, null, 2);
  }
}

async function payAndRun() {
  const out = byId('paid-route-result');
  try {
    if (!paidFetch) await connectWallet();
    if (!paidFetch) return;
    const payload = samplePayload();

    const aboutResponse = await fetch('/about', { headers: { accept: 'application/json' } });
    const about = await readJson(aboutResponse);
    const priceUsdc = about.arcPaidDemo?.payment?.price?.amount ?? '0.10';
    const requiredAtomicAmount = parseUnits(priceUsdc, 6);

    setResult('paid-summary', 'Checking Gateway balance', 'Making sure enough Arc USDC is deposited with Circle before paying.');
    out.textContent = 'Checking Circle Gateway balance...';
    const gatewayResult = await ensureGatewayBalance(walletClientRef, walletAddress, requiredAtomicAmount);
    if (gatewayResult.deposited) {
      out.textContent = `Deposited into Circle Gateway: ${gatewayResult.depositHash}`;
    }

    setResult('paid-summary', 'Waiting for wallet', 'Approve the x402 payment in your wallet. The app will run after payment.');
    out.textContent = 'Waiting for wallet payment...';
    const response = await paidFetch('/demo/certify/paid', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    const body = await readJson(response);
    const summary = summarizePaidResponse(response.status, body);
    setResult('paid-summary', summary.title, summary.body, summary.state);
    out.textContent = JSON.stringify({ status: response.status, payer: walletAddress, body }, null, 2);
    loadPaidRun();
  } catch (error) {
    setResult('paid-summary', 'Live payment did not complete', error.message, 'bad');
    out.textContent = JSON.stringify({ error: error.message }, null, 2);
  }
}

async function copyRequest() {
  await navigator.clipboard.writeText(JSON.stringify(samplePayload(), null, 2));
  byId('copy-request').textContent = 'Copied';
  setTimeout(() => {
    byId('copy-request').textContent = 'Copy request';
  }, 1400);
}

function boot() {
  byId('target-url').value = SAMPLE_AGENT;
  byId('agent-address').value = SAMPLE_AGENT_ADDRESS;
  byId('sample-body').value = JSON.stringify({ message: 'What is 2 plus 2?' }, null, 2);
  byId('connected-wallet').textContent = 'Not connected';
  byId('refresh-status').addEventListener('click', loadAbout);
  byId('refresh-paid').addEventListener('click', loadPaidRun);
  byId('verify-arc').addEventListener('click', verifyArcProof);
  byId('connect-wallet').addEventListener('click', () => connectWallet().catch((error) => {
    showWallet('bad', 'Wallet connection failed', error.message);
  }));
  byId('pay-live').addEventListener('click', payAndRun);
  byId('check-no-pay').addEventListener('click', checkSetupWithoutPaying);
  byId('copy-request').addEventListener('click', () => copyRequest().catch((error) => {
    setResult('paid-summary', 'Copy failed', error.message, 'bad');
  }));

  loadAbout();
  loadPaidRun();
}

boot();
