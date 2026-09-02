/**
 * The certifier: the one operation halflife actually performs.
 *
 * It is glue and nothing else. The judgement lives in drift.js, the storage
 * lives in memory.js, and the probing lives in StressProof, which is a separate
 * service halflife pays rather than a library it imports. This file's whole job
 * is to put those three in the right order and to be honest about what happened
 * when one of them does not answer.
 *
 * Order of operations, and why it is that order:
 *
 *   1. recall what memory holds for this agent
 *   2. ask StressProof for a fresh certification
 *   3. compare, write the new standing, append to the journal
 *
 * Memory is read first on purpose. Halflife pays StressProof per run, so
 * spending money on a certification we would then be unable to compare against
 * or store is the one ordering that wastes real funds to produce an answer
 * halflife cannot use. If memory is down, nothing is bought.
 *
 * Both outside dependencies are injected, with real defaults. That is not only
 * for tests: the StressProof client halflife will use once it is paying over
 * x402 is a different client from the free one, and the certifier should not
 * have to change when it is swapped in.
 */

import { compareCertification, DRIFT, CERTIFICATE, INCONCLUSIVE, VERDICT_RANK } from './drift.js';
import { sharedMemory } from './memory.js';
import {
  assessStanding,
  riskPolicy,
  STANDING,
  DEFAULT_RISK_LEVEL,
  isKnownRiskLevel,
} from './risk.js';

const KNOWN_VERDICTS = new Set(Object.keys(VERDICT_RANK));

/** How long to wait on StressProof before calling the run unmeasurable. */
const UPSTREAM_TIMEOUT_MS = 120_000;

export const DEFAULT_STRESSPROOF_URL =
  process.env.HALFLIFE_STRESSPROOF_URL ?? 'http://localhost:3000';

/**
 * The default StressProof client, over its free demo route.
 *
 * Still the default, and still the only route implemented in this file. The
 * paying client lives in paidStressproof.js and is passed into the constructor
 * as `stressproof`, exactly as this comment always said it would be. Nothing
 * in this file changed to accommodate it, which was the point of injecting the
 * dependency rather than importing one.
 *
 * The free route stays the default deliberately. It costs nothing, it needs no
 * wallet, and it is what the demo and the test suite run against. A deployment
 * that means to pay says so by constructing the paid client, so there is no
 * configuration mistake that silently turns a paid product into a free one.
 * The reverse mistake is guarded on the other side: the paid client refuses to
 * exist at all on incomplete configuration rather than falling back here.
 */
export function createStressProofClient({
  baseUrl = DEFAULT_STRESSPROOF_URL,
  fetch: fetchImpl = globalThis.fetch,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
} = {}) {
  return {
    async certify({ targetUrl, method = 'POST', sampleBody, authHeaders, demoMode } = {}) {
      const body = demoMode ? { demoMode } : { targetUrl, method, sampleBody, authHeaders };

      const response = await fetchImpl(`${String(baseUrl).replace(/\/$/, '')}/demo/certify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`StressProof answered HTTP ${response.status}: ${detail.slice(0, 300)}`);
      }

      return response.json();
    },
  };
}

/**
 * Turn whatever StressProof sent back into the small shape drift.js compares.
 *
 * Defensive on purpose. StressProof is a separate service on a separate
 * deployment cycle, so its report can change shape without halflife being
 * rebuilt. The rule when a field halflife needs is absent is the same rule the
 * rest of the product follows: a run that could not be read is a run that
 * measured nothing, which is INCONCLUSIVE. It is never a zero score, because a
 * zero score is a claim about the agent and this is a claim about the run.
 *
 * A verdict StressProof knows but halflife does not is treated the same way.
 * drift.js refuses to rank an unknown verdict, and it is right to: guessing
 * where a new band sits could invent a revocation out of a renaming.
 */
export function normaliseReport(payload) {
  const envelope = payload && typeof payload === 'object' ? payload : {};
  // The HTTP routes wrap the report; a caller holding a bare report is fine too.
  const report =
    envelope.report && typeof envelope.report === 'object' ? envelope.report : envelope;
  const certificate =
    envelope.certificate && typeof envelope.certificate === 'object' ? envelope.certificate : null;

  const rawVerdict = typeof report.verdict === 'string' ? report.verdict.toUpperCase() : null;
  const measured = rawVerdict !== null && KNOWN_VERDICTS.has(rawVerdict);

  let unmeasurableReason = null;
  if (rawVerdict === null) {
    unmeasurableReason = 'the report carried no verdict, so nothing was learned about the agent';
  } else if (!measured && rawVerdict !== INCONCLUSIVE) {
    unmeasurableReason = `the report carried a verdict halflife does not know how to rank (${rawVerdict}), so it is not treated as a finding`;
  } else if (rawVerdict === INCONCLUSIVE) {
    unmeasurableReason =
      report.verdictReason ?? 'StressProof could not measure enough to reach a verdict';
  }

  return {
    verdict: measured ? rawVerdict : INCONCLUSIVE,
    // Which version of StressProof's test produced this. Null when the report
    // predates version stamping, which is a different thing from a version that
    // disagrees and is handled as such below.
    specVersion: typeof report.specVersion === 'string' ? report.specVersion : null,
    score: numberOrNull(report.score),
    silentWrongCount: numberOrNull(report.silentWrongCount) ?? 0,
    probesCompleted: numberOrNull(report.probesCompleted),
    verdictReason: typeof report.verdictReason === 'string' ? report.verdictReason : null,
    reportId: typeof envelope.id === 'string' ? envelope.id : null,
    reportHash: typeof certificate?.reportHash === 'string' ? certificate.reportHash : null,
    // An unsigned report is not a failed one. StressProof says so itself: a
    // deployment with no signing key produces sound reports with no
    // certificate. Recorded as a fact rather than silently ignored.
    signed: certificate !== null,
    upstreamReached: true,
    unmeasurableReason,
  };
}

/** What a run looks like when StressProof itself could not be reached. */
function unreachedRun(error) {
  return {
    verdict: INCONCLUSIVE,
    specVersion: null,
    score: null,
    silentWrongCount: 0,
    probesCompleted: null,
    verdictReason: null,
    reportId: null,
    reportHash: null,
    signed: false,
    upstreamReached: false,
    unmeasurableReason: `StressProof could not be reached: ${error.message}`,
  };
}

/**
 * WHY A RESULT FROM A DIFFERENT TEST VERSION IS NOT COMPARED.
 *
 * drift.js answers one question: is this agent worse than it was. That question
 * only means anything if both verdicts came out of the same test. StressProof
 * stamps every report with the version of its frozen spec, derived from the
 * probe list and every threshold, so a moved threshold changes the stamp on its
 * own. If halflife compared across a change it would read a change in the TEST
 * as a change in the AGENT, and revoke a certificate from an agent that did
 * nothing. A revocation is an accusation, and that is the one way this product
 * cannot afford to be wrong.
 *
 * So the remembered result is not fed into the comparison at all. The choice
 * was between comparing and flagging it, and refusing to compare:
 *
 *   - Comparing and flagging still produces a REVOKED, and a revocation with an
 *     asterisk on it is still an accusation. Whoever reads the registry sees
 *     the word, not the footnote.
 *   - Calling the run UNVERIFIABLE would be wrong in the other direction. This
 *     run measured the agent perfectly well; it is the COMPARISON that cannot
 *     be made. UNVERIFIABLE also carries the behaviour documented on
 *     #writeStanding, where the remembered verdict is deliberately preserved,
 *     so a good new measurement would never be written down and the agent would
 *     be stuck on a verdict from a test that no longer exists.
 *
 * What is left is the honest reading: under this version of the test, halflife
 * has no earlier result for this agent, so this is a first certification and it
 * is flagged as one caused by the test changing. The earlier result is not
 * deleted, it stays in the journal with the version that produced it.
 *
 * Two things this deliberately does NOT do. A revoked certificate is not
 * reinstated by a change of test, because standing only returns on a
 * demonstrated improvement and no improvement can be demonstrated across a
 * version change. And a run that measured nothing makes no version claim at
 * all, so an outage never looks like a test change.
 */
export function comparableAcrossVersions(previous, current) {
  if (!previous) {
    return { previous: null, specVersionChanged: false, previousSpecVersion: null, currentSpecVersion: current.specVersion ?? null };
  }

  const before = previous.specVersion ?? null;
  const after = current.specVersion ?? null;

  // An unmeasurable run carries no verdict and no version claim, so there is
  // nothing to disagree with. Treating a StressProof outage as a test change
  // would throw away a standing record for no reason.
  if (current.verdict === INCONCLUSIVE || before === after) {
    return { previous, specVersionChanged: false, previousSpecVersion: before, currentSpecVersion: after };
  }

  // One side unstamped counts as a disagreement. An older record written before
  // versions existed cannot be shown to have come from this test, and "cannot
  // be shown" is not "is".
  return { previous: null, specVersionChanged: true, previousSpecVersion: before, currentSpecVersion: after };
}

function describeVersion(version) {
  return version ?? 'a test version that was never recorded';
}

/**
 * Rewrite the comparison for a run that crossed a version change.
 *
 * drift.js is left alone: it was handed no previous result and correctly said
 * first certification. All that is added here is the reason a reader needs,
 * plus one refusal, which is that a certificate revoked under the old test is
 * not handed back by the test changing.
 */
function acrossVersionChange(comparison, previous, versions) {
  const from = describeVersion(versions.previousSpecVersion);
  const to = describeVersion(versions.currentSpecVersion);
  const wasRevoked = (previous?.certificateStatus ?? CERTIFICATE.VALID) === CERTIFICATE.REVOKED;

  return {
    ...comparison,
    certificateStatus: wasRevoked ? CERTIFICATE.REVOKED : comparison.certificateStatus,
    previousVerdict: previous?.verdict ?? null,
    scoreDelta: null,
    reason: wasRevoked
      ? `The remembered result for this agent came from test version ${from} and this run used ${to}, so the two are not like for like and were not compared. The agent was certified afresh under ${to}. Its certificate was already revoked and stays revoked: standing comes back on a demonstrated improvement, and no improvement can be demonstrated across a change of test.`
      : `The remembered result for this agent came from test version ${from} and this run used ${to}, so the two are not like for like and were not compared. Nothing here says the agent got better or worse. It is certified afresh under ${to}, and the earlier result stays in the journal with the version that produced it.`,
  };
}

export class Certifier {
  #memory;
  #stressproof;
  #clock;

  constructor({ memory, stressproof, clock } = {}) {
    this.#memory = memory ?? sharedMemory();
    this.#stressproof = stressproof ?? createStressProofClient();
    this.#clock = clock ?? (() => new Date().toISOString());
  }

  /**
   * Record what an agent is for, which decides how often it must be re-checked
   * and how good it has to be.
   *
   * Registration is its own operation and never happens as a side effect of a
   * certification. An agent that turns up for a check without having been
   * registered is judged at the loosest level rather than quietly registered at
   * one nobody chose for it.
   *
   * Changing the level later does not rewrite anything. The change is appended
   * to the journal with the level it moved from, and every run already recorded
   * keeps the level it was judged under, so nobody reading the history later
   * finds an agent that appears to have been held to today's bar last month.
   */
  async registerRiskLevel(target, level) {
    if (typeof target !== 'string' || target.length === 0) {
      throw new TypeError('registerRiskLevel requires the agent to register');
    }

    // Throws on an unknown level rather than falling back to a default. A typo
    // that silently produced the assistant bar for a payment agent is exactly
    // the failure this whole product is about.
    const policy = riskPolicy(level);
    const existing = await this.#memory.recallRiskLevel(target);

    if (existing?.riskLevel === policy.level) {
      return {
        target,
        riskLevel: policy.level,
        previousRiskLevel: policy.level,
        changed: false,
        setAt: existing.setAt ?? null,
        journalLine: null,
      };
    }

    const setAt = this.#clock();
    await this.#memory.rememberRiskLevel(target, {
      target,
      riskLevel: policy.level,
      setAt,
      previousRiskLevel: existing?.riskLevel ?? null,
    });

    const line = existing?.riskLevel
      ? `${target}: risk level changed from ${existing.riskLevel} to ${policy.level}. From now on it must be re-checked ${policy.period} and must hold ${policy.minimumVerdict}. Checks recorded before now were judged at ${existing.riskLevel} and are left as they were written.`
      : `${target}: registered as ${policy.level} risk (${policy.example}). It must be re-checked ${policy.period} and must hold ${policy.minimumVerdict} to keep a certificate.`;

    await this.#memory.recordRun(line, {
      target,
      riskLevel: policy.level,
      previousRiskLevel: existing?.riskLevel ?? null,
      setAt,
    });

    return {
      target,
      riskLevel: policy.level,
      previousRiskLevel: existing?.riskLevel ?? null,
      changed: true,
      setAt,
      journalLine: line,
    };
  }

  /** What an agent is registered as, or the default when nobody has said. */
  async riskLevelOf(target) {
    const record = await this.#memory.recallRiskLevel(target);
    return isKnownRiskLevel(record?.riskLevel) ? record.riskLevel : DEFAULT_RISK_LEVEL;
  }

  /**
   * Re-certify one agent and say what changed.
   *
   * `target` is how halflife knows the agent, and it is what the standing
   * record is keyed on. `request` is passed to the StressProof client
   * unchanged, because what a certification run needs (a sample request, auth
   * headers) is StressProof's business and not something to re-specify here.
   */
  async certify(target, request = {}) {
    if (typeof target !== 'string' || target.length === 0) {
      throw new TypeError('certify requires the agent to certify');
    }

    // Deliberately not wrapped. memory.js throws when memory is unreachable and
    // that has to reach the caller: a certifier that swallowed it would go on to
    // compare against "no previous record", which reads identically to an agent
    // halflife has never seen, and would hand a fresh certificate to an agent
    // whose certificate it had already revoked.
    const previous = await this.#memory.recallCertification(target);
    const riskLevel = await this.riskLevelOf(target);

    // WHY AN UPSTREAM FAILURE IS NOT A FINDING.
    //
    // A run that could not be completed is not a verdict about the agent. If
    // StressProof is down, or slow, or answering with an error, the only honest
    // thing halflife knows is that it failed to check, which says nothing about
    // whether the agent got worse. Feeding that in as INCONCLUSIVE hands it to
    // drift.js, which already has exactly this case: the comparison comes back
    // UNVERIFIABLE, the previous certificate is left untouched, and no
    // revocation is possible. Revoking on an outage would mean halflife's own
    // downtime damaging agents that did nothing, which destroys the only thing
    // it sells.
    //
    // The failure is still recorded, in the journal and on the standing record,
    // because a certificate nobody has managed to re-check is a fact a reader
    // needs. Halflife's product is that a certificate expires, and a run that
    // never happened is what expiry looks like from the inside.
    let current;
    try {
      current = normaliseReport(await this.#stressproof.certify({ targetUrl: target, ...request }));
    } catch (error) {
      current = unreachedRun(error);
    }

    const versions = comparableAcrossVersions(previous, current);
    const compared = compareCertification(versions.previous, current);
    const comparison = versions.specVersionChanged
      ? acrossVersionChange(compared, previous, versions)
      : compared;

    const checkedAt = this.#clock();

    // A run that measured nothing leaves the remembered verdict standing, so
    // that is the verdict the risk bar is applied to. Reading INCONCLUSIVE as
    // the agent's current standing would fail every agent for halflife's own
    // failure to check.
    const measured = current.verdict !== INCONCLUSIVE;
    const standingVerdict = measured ? current.verdict : (previous?.verdict ?? null);

    // The clock runs from the last check that actually learned something.
    // lastCheckedAt moves on failed checks too, so using it would let an
    // unreachable StressProof keep every certificate looking freshly checked.
    const lastMeasuredAt = measured ? checkedAt : (previous?.certifiedAt ?? null);

    const assessment = assessStanding({
      riskLevel,
      verdict: standingVerdict,
      certificateStatus: comparison.certificateStatus,
      // A qualification earned under a different version of the test is not
      // carried across the change. Otherwise a fall that is really a change in
      // the test would come out worded as a revocation.
      everQualified:
        !versions.specVersionChanged && previous?.qualifiedForRiskLevel === riskLevel,
      lastMeasuredAt,
      now: checkedAt,
      revocationReason: comparison.reason,
    });

    const standingReason = versions.specVersionChanged
      ? `${assessment.reason} This is judged only on this run, because the test version changed and the earlier result was not comparable.`
      : assessment.reason;

    const line = journalLine(target, comparison, current, assessment, versions);

    await this.#writeStanding({
      target,
      previous,
      current,
      comparison,
      checkedAt,
      riskLevel,
      assessment,
    });
    await this.#memory.recordRun(line, {
      target,
      drift: comparison.drift,
      certificateStatus: comparison.certificateStatus,
      standing: assessment.standing,
      riskLevel,
      specVersion: current.specVersion,
      specVersionChanged: versions.specVersionChanged,
      verdict: current.verdict,
      score: current.score,
      checkedAt,
    });

    return {
      target,
      checkedAt,
      drift: comparison.drift,
      certificateStatus: comparison.certificateStatus,
      previousVerdict: comparison.previousVerdict,
      currentVerdict: comparison.currentVerdict,
      scoreDelta: comparison.scoreDelta,
      reason: comparison.reason,
      // True only when this run revoked a certificate that was standing before
      // it. A first run that could not be measured issues no certificate, which
      // drift.js reports as `revoked` because there is nothing valid to hold,
      // but nothing was taken away from anybody.
      revoked:
        comparison.drift === DRIFT.REVOKED &&
        (previous?.certificateStatus ?? CERTIFICATE.VALID) === CERTIFICATE.VALID,
      measured,
      upstreamReached: current.upstreamReached,
      unmeasurableReason: current.unmeasurableReason,
      // The risk level's two jobs, answered. `standing` is the certificate's
      // state including its expiry, which is a different question from `drift`:
      // drift says whether the agent changed, standing says whether the
      // certificate is worth anything right now.
      riskLevel,
      minimumVerdict: assessment.minimumVerdict,
      standing: assessment.standing,
      standingReason,
      meetsMinimumBand: assessment.meetsMinimumBand,
      stale: assessment.stale,
      dueAt: assessment.dueAt,
      lastMeasuredAt: assessment.lastMeasuredAt,
      specVersion: current.specVersion,
      previousSpecVersion: versions.previousSpecVersion,
      specVersionChanged: versions.specVersionChanged,
      current,
      previous,
      journalLine: line,
    };
  }

  /**
   * WHY AN UNMEASURABLE RUN MUST NOT OVERWRITE THE STANDING VERDICT.
   *
   * The obvious implementation writes the fresh run over the standing record
   * every time. It is wrong, and quietly so. drift.js reads a remembered
   * INCONCLUSIVE as "no usable earlier verdict" and treats the next run as a
   * first certification. So one unreachable upstream call would erase a
   * remembered RESILIENT, and the next run coming back BRITTLE would be issued
   * a fresh valid certificate instead of revoking the old one. A failed check
   * would have laundered a real drop into a clean start.
   *
   * So an unmeasurable run keeps the remembered verdict exactly as it was and
   * only records that a check was attempted and did not land. With nothing
   * remembered at all there is no standing to protect and none is invented:
   * halflife has still never certified this agent, and the attempt lives in the
   * journal where it belongs.
   */
  async #writeStanding({ target, previous, current, comparison, checkedAt, riskLevel, assessment }) {
    if (current.verdict === INCONCLUSIVE) {
      if (!previous) return;

      return this.#memory.rememberCertification(target, {
        ...previous,
        riskLevel,
        lastCheckedAt: checkedAt,
        lastCheckFailedAt: checkedAt,
        lastCheckFailure: current.unmeasurableReason,
        // The verdict is untouched, but the certificate may have expired while
        // the checks were failing, and that has to be visible without waiting
        // for a run that succeeds.
        standing: assessment.standing,
        dueAt: assessment.dueAt,
      });
    }

    return this.#memory.rememberCertification(target, {
      target,
      verdict: current.verdict,
      // Which test produced this verdict. Without it, the next run cannot tell
      // whether it is comparing like with like.
      specVersion: current.specVersion,
      riskLevel,
      standing: assessment.standing,
      minimumVerdict: assessment.minimumVerdict,
      dueAt: assessment.dueAt,
      // Remembered rather than re-derived, because a verdict alone cannot say
      // whether an agent ever held the bar for the level it is registered at,
      // and that is what separates a revocation from an agent that never
      // qualified. It is stored with the level it was earned at, so raising an
      // agent's risk level does not silently claim it once met the higher bar.
      qualifiedForRiskLevel: assessment.meetsMinimumBand
        ? riskLevel
        : previous?.qualifiedForRiskLevel === riskLevel
          ? riskLevel
          : null,
      qualifiedAt: assessment.meetsMinimumBand
        ? (previous?.qualifiedForRiskLevel === riskLevel ? (previous.qualifiedAt ?? checkedAt) : checkedAt)
        : (previous?.qualifiedForRiskLevel === riskLevel ? (previous.qualifiedAt ?? null) : null),
      score: current.score,
      silentWrongCount: current.silentWrongCount,
      probesCompleted: current.probesCompleted,
      verdictReason: current.verdictReason,
      certificateStatus: comparison.certificateStatus,
      certifiedAt: checkedAt,
      lastCheckedAt: checkedAt,
      lastCheckFailedAt: null,
      lastCheckFailure: null,
      reportId: current.reportId,
      reportHash: current.reportHash,
      signed: current.signed,
    });
  }
}

/**
 * One line of history, written for somebody reading it months later with no
 * idea what the field names mean. The journal is append-only and is the only
 * record that survives the standing record being overwritten, so it has to
 * carry the story in words rather than in codes.
 */
function journalLine(target, comparison, current, assessment, versions) {
  const scored = current.score === null ? current.verdict : `${current.verdict} ${current.score}`;

  // Said before anything else, because a line that reported a verdict change
  // without saying the test changed would be the misreading this stamp exists
  // to prevent.
  if (versions?.specVersionChanged) {
    return `${target}: measured at ${scored} under test version ${describeVersion(versions.currentSpecVersion)}. The remembered result came from ${describeVersion(versions.previousSpecVersion)}, so the two were not compared and this run says nothing about whether the agent changed. Certificate ${assessment.standing}.`;
  }

  // Staleness is written as halflife's own failure, not the agent's. The agent
  // may be perfectly fine; what expired is our knowledge of it.
  if (assessment?.standing === STANDING.STALE) {
    return `${target}: last completed check was ${assessment.lastMeasuredAt} and a ${assessment.riskLevel} risk agent is due ${assessment.recheckEvery}, so this certificate has expired. Halflife no longer knows whether it still holds ${assessment.verdict}. Nothing here is a finding about the agent.`;
  }

  if (assessment?.standing === STANDING.NEVER_QUALIFIED) {
    return `${target}: measured at ${scored}, below the ${assessment.minimumVerdict} a ${assessment.riskLevel} risk agent must hold. No certificate has ever been issued for it at this level, so nothing has been revoked.`;
  }

  switch (comparison.drift) {
    case DRIFT.FIRST_CERTIFICATION:
      return current.verdict === INCONCLUSIVE
        ? `${target}: first check could not be completed (${current.unmeasurableReason}). No certificate issued.`
        : `${target}: certified for the first time at ${scored}. Certificate issued.`;

    case DRIFT.UNCHANGED:
      return `${target}: re-checked and still ${scored}, unchanged from ${comparison.previousVerdict}. Certificate ${comparison.certificateStatus}.`;

    case DRIFT.IMPROVED:
      return `${target}: improved from ${comparison.previousVerdict} to ${scored}. New certificate issued.`;

    case DRIFT.REVOKED:
      return `${target}: fell from ${comparison.previousVerdict} to ${scored}. Certificate revoked.`;

    case DRIFT.UNVERIFIABLE:
      return `${target}: could not be checked (${current.unmeasurableReason}). The ${comparison.previousVerdict} certificate is untouched and this is recorded as a gap in checking, not as a finding about the agent.`;

    default:
      return `${target}: re-checked, result ${comparison.drift}.`;
  }
}

function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
