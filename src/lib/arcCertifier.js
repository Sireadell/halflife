/**
 * Connects Halflife's real certifier to Arc: after a certification runs, this
 * decides whether the result changes what Arc should say, and if so writes it.
 *
 * Halflife identifies an agent by the URL it tests (`targetUrl`, passed to
 * StressProof). Arc's Memo contract targets an Ethereum address instead, so
 * this module takes both explicitly rather than guessing one from the other.
 * They are two facts about the same agent, not the same fact twice.
 *
 * Only two moments are worth a transaction: a certificate becoming valid
 * (first issued, or re-earned after improving) and a certificate being
 * revoked. Every other outcome (unchanged, stale, still not qualified, an
 * upstream failure) changes nothing Arc needs to know, and writing a memo for
 * it would spend real USDC to say nothing new.
 */

import { DRIFT, CERTIFICATE } from './drift.js';
import { writeCertificateMemo } from './arcMemo.js';
import { ARC_EXPLORER_TX, ERC8004_AGENT_REGISTRY, createErc8004 } from './erc8004.js';

/**
 * @param {{ certifier: import('./certifier.js').Certifier, arcClients: object, memory?: object, erc8004?: object, writeMemo?: typeof writeCertificateMemo }} deps
 * @param {{ targetUrl: string, agentAddress: string, request?: object }} params
 */
export async function certifyOnArc(
  { certifier, arcClients, memory, erc8004, writeMemo = writeCertificateMemo },
  { targetUrl, agentAddress, request = {} },
) {
  if (typeof agentAddress !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) {
    throw new TypeError('certifyOnArc: agentAddress must be a 20-byte hex address.');
  }

  const result = await certifier.certify(targetUrl, request);
  const action = decideArcAction(result);

  if (!action) {
    return { ...result, arc: { written: false, reason: describeNoWrite(result) } };
  }

  if (!result.current?.reportHash) {
    return {
      ...result,
      arc: {
        written: false,
        reason: `StressProof did not return a signed report hash for this run, so nothing verifiable could be written to Arc. ${action === 'issued' ? 'Certificate stands, unrecorded on chain.' : 'Revocation stands in memory, unrecorded on chain.'}`,
      },
    };
  }

  const memo = await writeMemo(arcClients, {
    event: action,
    agentAddress,
    certificateHash: result.current.reportHash,
    reason: action === 'revoked' ? result.reason : undefined,
  });

  const erc8004Result = await writeErc8004Feedback({
    action,
    arcClients,
    erc8004,
    memory,
    result,
    targetUrl,
  });

  return { ...result, arc: { written: true, event: action, ...memo, erc8004: erc8004Result } };
}

/** Which Arc event, if any, this certification result calls for. */
function decideArcAction(result) {
  const becameValid =
    (result.drift === DRIFT.FIRST_CERTIFICATION || result.drift === DRIFT.IMPROVED) &&
    result.certificateStatus === CERTIFICATE.VALID;
  if (becameValid) return 'issued';
  if (result.revoked) return 'revoked';
  return null;
}

function describeNoWrite(result) {
  if (!result.measured) {
    return `No Arc write: this run measured nothing (${result.unmeasurableReason}), so the on-chain certificate, if any, is left exactly as it was.`;
  }
  return `No Arc write: drift was ${result.drift} and the certificate is already ${result.certificateStatus} on chain, so there is nothing new to record.`;
}

async function writeErc8004Feedback({ action, arcClients, erc8004, memory, result, targetUrl }) {
  if (!memory) {
    return {
      written: false,
      reason: 'ERC-8004 feedback was skipped because Halflife memory was not available to store the agent id and feedback index.',
    };
  }

  try {
    const client = erc8004 ?? (arcClients ? await createErc8004(arcClients) : null);
    if (!client) {
      return { written: false, reason: 'ERC-8004 feedback was skipped because the Arc registry client was not configured.' };
    }

    const currentRecord = await memory.recallCertification(targetUrl);
    const previousErc = result.previous?.erc8004 ?? null;
    const existingErc = currentRecord?.erc8004 ?? previousErc ?? null;
    const registered = existingErc?.agentId
      ? { agentId: existingErc.agentId, txHash: existingErc.registerTxHash ?? null, reused: true }
      : { ...(await client.registerAgent(targetUrl)), reused: false };

    await rememberErc8004(memory, targetUrl, {
      ...(existingErc ?? {}),
      agentId: registered.agentId,
      agentRegistry: ERC8004_AGENT_REGISTRY,
      registerTxHash: registered.txHash,
      registerTxUrl: registered.txHash ? `${ARC_EXPLORER_TX}${registered.txHash}` : null,
      agentURI: targetUrl,
    });

    const revoked = await revokeOldFeedback({
      action,
      client,
      agentId: registered.agentId,
      previousErc,
    });
    const feedback = await giveFreshFeedback({
      arcClients,
      client,
      agentId: registered.agentId,
      result,
      targetUrl,
    });

    await rememberErc8004(memory, targetUrl, {
      ...(existingErc ?? {}),
      agentId: registered.agentId,
      agentRegistry: ERC8004_AGENT_REGISTRY,
      registerTxHash: registered.txHash,
      registerTxUrl: registered.txHash ? `${ARC_EXPLORER_TX}${registered.txHash}` : null,
      agentURI: targetUrl,
      lastFeedbackIndex: feedback.feedbackIndex,
      lastFeedbackTxHash: feedback.txHash,
      lastFeedbackTxUrl: `${ARC_EXPLORER_TX}${feedback.txHash}`,
      lastFeedbackHash: result.current.reportHash,
      lastFeedbackVerdict: result.current.verdict,
      lastFeedbackScore: result.current.score,
      revokedFeedbackIndex: revoked.index ?? existingErc?.revokedFeedbackIndex ?? null,
      revokeTxHash: revoked.txHash ?? existingErc?.revokeTxHash ?? null,
      revokeTxUrl: revoked.txHash ? `${ARC_EXPLORER_TX}${revoked.txHash}` : (existingErc?.revokeTxUrl ?? null),
    });

    return {
      written: true,
      agentId: registered.agentId,
      agentRegistry: ERC8004_AGENT_REGISTRY,
      txHash: feedback.txHash,
      txUrl: `${ARC_EXPLORER_TX}${feedback.txHash}`,
      feedbackIndex: feedback.feedbackIndex,
      revoked,
    };
  } catch (error) {
    return {
      written: false,
      reason: `ERC-8004 registry write failed: ${error.message}`,
    };
  }
}

async function rememberErc8004(memory, targetUrl, erc8004) {
  const latest = await memory.recallCertification(targetUrl);
  if (!latest) return;
  await memory.rememberCertification(targetUrl, { ...latest, erc8004 });
}

async function revokeOldFeedback({ action, client, agentId, previousErc }) {
  if (action !== 'revoked') return { written: false, reason: 'No revocation was needed for this certification.' };
  if (previousErc?.lastFeedbackIndex === null || previousErc?.lastFeedbackIndex === undefined) {
    return {
      written: false,
      reason: 'No earlier ERC-8004 feedback index was stored, so there was no exact feedback to revoke.',
    };
  }

  const revoked = await client.revokeFeedback(agentId, previousErc.lastFeedbackIndex);
  return {
    written: true,
    index: previousErc.lastFeedbackIndex,
    txHash: revoked.txHash,
    txUrl: `${ARC_EXPLORER_TX}${revoked.txHash}`,
  };
}

async function giveFreshFeedback({ arcClients, client, agentId, result, targetUrl }) {
  if (!Number.isInteger(result.current?.score)) {
    throw new Error('StressProof returned no integer score for ERC-8004 feedback.');
  }

  const tx = await client.giveFeedback({
    agentId,
    value: result.current.score,
    valueDecimals: 0,
    tag1: 'halflife',
    tag2: result.current.verdict,
    endpoint: targetUrl,
    feedbackURI: feedbackUri(result.current),
    feedbackHash: result.current.reportHash,
  });
  const feedbackIndex = await client.getLastIndex(agentId, halflifeAddress(arcClients));
  return { txHash: tx.txHash, feedbackIndex };
}

function feedbackUri(current) {
  if (typeof current?.reportUri === 'string' && current.reportUri.trim()) {
    return current.reportUri.trim();
  }
  if (typeof current?.reportId === 'string' && current.reportId.trim()) {
    return `/c/${current.reportId.trim()}`;
  }
  return `/c/${current.reportHash}`;
}

function halflifeAddress(arcClients) {
  const address = arcClients?.account?.address ?? arcClients?.walletClient?.account?.address;
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error('Arc wallet address is required to read the ERC-8004 feedback index.');
  }
  return address;
}
