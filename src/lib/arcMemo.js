// Writes a Halflife certificate onto Arc using Arc's predeployed Memo
// contract, instead of a formal ERC-8004 identity registration.
//
// Arc's own documentation only publishes ERC-8004 identity and reputation
// contract addresses for its test network. The mainnet addresses seen
// elsewhere come from a third party's own deployment, not from Arc, so this
// build does not depend on them (decided 2026-09-19). A transaction memo is
// simpler and depends on nothing but Arc itself: the memo names the agent's
// plain wallet address directly, tags the memo with a fixed id so every
// Halflife memo can be found later, and carries the certificate as a
// readable JSON string anyone can decode, not just us.
//
// The contract address below is Arc's documented Memo contract. Arc's docs
// do not say whether it differs between mainnet and testnet, so
// verifyMemoContractIsDeployed() checks it has real code at startup rather
// than assuming and failing partway through a real transaction.

import { keccak256, toHex, stringToHex, hexToString } from 'viem';

export const MEMO_CONTRACT_ADDRESS = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505';

export const MEMO_ABI = [
  {
    type: 'function',
    name: 'memo',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'target', type: 'address' },
      { name: 'data', type: 'bytes' },
      { name: 'memoId', type: 'bytes32' },
      { name: 'memoData', type: 'bytes' },
    ],
    outputs: [],
  },
  {
    type: 'event',
    name: 'Memo',
    inputs: [
      { name: 'sender', type: 'address', indexed: true },
      { name: 'target', type: 'address', indexed: true },
      { name: 'callDataHash', type: 'bytes32', indexed: false },
      { name: 'memoId', type: 'bytes32', indexed: true },
      { name: 'memo', type: 'bytes', indexed: false },
      { name: 'memoIndex', type: 'uint256', indexed: false },
    ],
  },
];

/** Tags every Halflife-on-Arc memo so they can all be found by this one id later. */
export const HALFLIFE_MEMO_ID = keccak256(stringToHex('halflife.certificate.v1'));

/**
 * Confirms the Memo contract actually has code on the chain a client is
 * pointed at. Arc's docs give one address for the contract without saying
 * whether it is the same on mainnet and testnet, so this checks rather than
 * assumes, and fails with a clear message instead of a confusing revert.
 */
export async function verifyMemoContractIsDeployed(publicClient) {
  const code = await publicClient.getBytecode({ address: MEMO_CONTRACT_ADDRESS });
  if (!code || code === '0x') {
    throw new Error(
      `arcMemo: no contract code found at ${MEMO_CONTRACT_ADDRESS} on chain ` +
        `${publicClient.chain?.id}. Confirm the Memo contract address for this ` +
        'network before sending a real transaction.',
    );
  }
}

/**
 * Builds the JSON payload written into a memo. Kept as a plain object with a
 * fixed shape so a judge reading the raw memo bytes back gets something they
 * can read without our help, per Halflife's existing rule of never claiming
 * something happened without a record that survives independently.
 *
 * @param {{ event: 'issued' | 'revoked', agentAddress: string, certificateHash: string, reason?: string }} params
 */
export function buildCertificateMemoPayload({ event, agentAddress, certificateHash, reason }) {
  if (event !== 'issued' && event !== 'revoked') {
    throw new Error(`buildCertificateMemoPayload: event must be 'issued' or 'revoked', got ${event}.`);
  }
  const payload = {
    product: 'halflife',
    event,
    agent: agentAddress,
    certificateHash,
    at: new Date().toISOString(),
  };
  if (event === 'revoked') {
    payload.reason = reason ?? 'not stated';
  }
  return payload;
}

/**
 * Writes one certificate event (issued or revoked) onto Arc as a memo
 * targeting the certified agent's own wallet address. The inner call is a
 * no-op (empty data to that address); the memo itself carries the record.
 *
 * @param {{ walletClient: import('viem').WalletClient, publicClient: import('viem').PublicClient }} clients
 * @param {{ event: 'issued' | 'revoked', agentAddress: string, certificateHash: string, reason?: string }} params
 * @returns {Promise<{ txHash: `0x${string}`, memoId: `0x${string}`, payload: object }>}
 */
export async function writeCertificateMemo(clients, params) {
  const { walletClient, publicClient } = clients;
  await verifyMemoContractIsDeployed(publicClient);

  const payload = buildCertificateMemoPayload(params);
  const memoData = stringToHex(JSON.stringify(payload));

  const txHash = await walletClient.writeContract({
    address: MEMO_CONTRACT_ADDRESS,
    abi: MEMO_ABI,
    functionName: 'memo',
    args: [params.agentAddress, '0x', HALFLIFE_MEMO_ID, memoData],
  });

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
  if (receipt.status !== 'success') {
    throw new Error(`writeCertificateMemo: transaction ${txHash} was mined but reverted.`);
  }

  return { txHash, memoId: HALFLIFE_MEMO_ID, payload };
}

/** Decodes a memo's raw bytes back into the JSON payload written above. */
export function decodeCertificateMemoPayload(memoDataHex) {
  return JSON.parse(hexToString(memoDataHex));
}
