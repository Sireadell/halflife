import { createPublicClient, decodeEventLog, http } from 'viem';

import { arcMainnet } from './arcChain.js';
import {
  decodeCertificateMemoPayload,
  HALFLIFE_MEMO_ID,
  MEMO_ABI,
  MEMO_CONTRACT_ADDRESS,
} from './arcMemo.js';

export const ARC_MANUAL_PROOF = Object.freeze({
  issued: Object.freeze({
    event: 'issued',
    txHash: '0xe21574e8463509ab806bc62af60eac34f9276b584da663adbf4adb3d1565b866',
    certificateHash: '0xbb3735f892a1e75e356aaeb580649832c1419806b89ae8f69977b285fe8830a3',
  }),
  revoked: Object.freeze({
    event: 'revoked',
    txHash: '0x9ec75646190b84a566f6f279bcf21678f78a3d3e310b2f896a691e051876f95b',
    certificateHash: '0x8e566df80ac7b7b5b13fc0172ebe4ba7c969fc09becd4c7da685259180bd91df',
  }),
});

function createArcReader(env = process.env) {
  const rpcUrl = (env.ARC_RPC_URL ?? '').trim() || arcMainnet.rpcUrls.default.http[0];
  return createPublicClient({ chain: arcMainnet, transport: http(rpcUrl) });
}

function findHalflifeMemo(receipt) {
  for (const log of receipt.logs ?? []) {
    if (log.address.toLowerCase() !== MEMO_CONTRACT_ADDRESS.toLowerCase()) continue;
    try {
      const decoded = decodeEventLog({ abi: MEMO_ABI, data: log.data, topics: log.topics });
      if (decoded.eventName !== 'Memo') continue;
      if (String(decoded.args.memoId).toLowerCase() !== HALFLIFE_MEMO_ID.toLowerCase()) continue;
      return {
        sender: decoded.args.sender,
        target: decoded.args.target,
        memoId: decoded.args.memoId,
        payload: decodeCertificateMemoPayload(decoded.args.memo),
      };
    } catch {
      continue;
    }
  }
  return null;
}

async function verifyOne(publicClient, proof) {
  const receipt = await publicClient.getTransactionReceipt({ hash: proof.txHash });
  const transaction = await publicClient.getTransaction({ hash: proof.txHash });
  const memo = findHalflifeMemo(receipt);
  const problems = [];
  const actionText = proof.event === 'issued' ? 'issued a certificate' : 'revoked a certificate';

  if (receipt.status !== 'success') problems.push('transaction did not succeed');
  if (transaction.to?.toLowerCase() !== MEMO_CONTRACT_ADDRESS.toLowerCase()) {
    problems.push('transaction did not call Arc Memo contract');
  }
  if (!memo) {
    problems.push('Halflife memo event was not found');
  } else {
    if (memo.payload.event !== proof.event) problems.push(`expected ${proof.event}, got ${memo.payload.event}`);
    if (memo.payload.certificateHash?.toLowerCase() !== proof.certificateHash.toLowerCase()) {
      problems.push('certificate hash does not match');
    }
  }

  return {
    event: proof.event,
    ok: problems.length === 0,
    summary:
      problems.length === 0
        ? `Arc proof verified: this transaction ${actionText} for the expected certificate fingerprint.`
        : `Arc proof could not be verified: ${problems.join('; ')}.`,
    txHash: proof.txHash,
    blockNumber: receipt.blockNumber.toString(),
    status: receipt.status,
    memoContract: MEMO_CONTRACT_ADDRESS,
    memoId: HALFLIFE_MEMO_ID,
    payload: memo?.payload ?? null,
    problems,
  };
}

export function createArcProofVerifier({ env = process.env, publicClient = createArcReader(env) } = {}) {
  return {
    async verifyManualProof() {
      const [issued, revoked] = await Promise.all([
        verifyOne(publicClient, ARC_MANUAL_PROOF.issued),
        verifyOne(publicClient, ARC_MANUAL_PROOF.revoked),
      ]);
      const ok = issued.ok && revoked.ok;
      return {
        chain: { id: arcMainnet.id, name: arcMainnet.name },
        checkedAt: new Date().toISOString(),
        ok,
        summary: ok
          ? 'Arc proof verified. Halflife found the expected issue transaction and the expected revoke transaction on Arc.'
          : 'Arc proof was checked, but at least one expected transaction did not match.',
        issued,
        revoked,
      };
    },
  };
}
