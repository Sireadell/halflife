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

/**
 * @param {{ certifier: import('./certifier.js').Certifier, arcClients: object, writeMemo?: typeof writeCertificateMemo }} deps
 * @param {{ targetUrl: string, agentAddress: string, request?: object }} params
 */
export async function certifyOnArc(
  { certifier, arcClients, writeMemo = writeCertificateMemo },
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

  return { ...result, arc: { written: true, event: action, ...memo } };
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
