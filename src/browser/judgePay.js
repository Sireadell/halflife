import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactEvmScheme, toClientEvmSigner } from '@x402/evm';
import { createPublicClient, createWalletClient, custom, defineChain, http } from 'viem';

const ARC_CHAIN_ID = 5042;
const ARC_CAIP2 = 'eip155:5042';
const ARC_RPC_URL = 'https://rpc.mainnet.arc.io';
const ARC_EXPLORER = 'https://arc.etherscan.io';
const SAMPLE_AGENT = 'https://stressproof-demo-agent.example.invalid/chat';
const SAMPLE_AGENT_ADDRESS = '0xb3FB14FEcac09efbD0C74Fc07d50d7eD1eef2B53';

const arcMainnet = defineChain({
  id: ARC_CHAIN_ID,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
  blockExplorers: { default: { name: 'ArcScan', url: ARC_EXPLORER } },
});

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

function showWallet(state, title, body) {
  setResult('wallet-status', title, body, state);
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
  const publicClient = createPublicClient({ chain: arcMainnet, transport: http(ARC_RPC_URL) });
  const signer = toClientEvmSigner({
    address,
    signTypedData: (message) => walletClient.signTypedData({ account: address, ...message }),
  }, publicClient);

  const client = new x402Client().register(ARC_CAIP2, new ExactEvmScheme(signer));
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
