/**
 * The read side: what halflife knows about an agent at the moment somebody
 * asks, as opposed to at the moment it last ran a check.
 *
 * WHY THIS IS A SEPARATE FILE FROM THE CERTIFIER.
 *
 * The certifier writes. It runs a check, compares, and stores a standing. This
 * reads, and reading is not a smaller version of the same job: it happens at a
 * different time, and the answer changes between the two even though nothing
 * was written in between.
 *
 * THE POINT OF THE WHOLE PRODUCT LIVES IN ONE LINE OF THIS FILE.
 *
 * Staleness is computed here, against the clock, every single time somebody
 * asks. It is NOT read back out of the stored record. If halflife answered with
 * the `standing` field that was written at check time, then a certificate
 * written as `valid` on the first of the month would still read `valid` in
 * March, because nothing came along to rewrite it. Nobody re-checked, so nobody
 * changed the word, so the word goes on saying the agent is fine. That is
 * exactly the silent reassurance halflife exists to remove, and it would be
 * indefensible for this product of all products to ship it.
 *
 * So the stored record is treated as evidence of what was measured and when,
 * and never as the answer. The answer is recomputed from that evidence plus the
 * current time, by risk.js, which is pure and can be argued with.
 *
 * THE RISK LEVEL IS READ FROM THE REGISTRATION, NOT FROM THE CERTIFICATE.
 *
 * The standing record carries the level the agent was judged under when it was
 * last checked. That is the right thing to keep in the history and the wrong
 * thing to answer with now: an agent moved from LOW to CRITICAL yesterday is a
 * CRITICAL agent today, and answering with the level from its last check would
 * report a monthly re-check period for an agent that is now due daily. The
 * registration is the authority on what an agent is. The certificate is the
 * authority on what was found.
 */

import { assessStanding, isKnownRiskLevel, DEFAULT_RISK_LEVEL, STANDING } from './risk.js';
import { CERTIFICATE } from './drift.js';

/** How many journal entries to pull before filtering down to one agent. */
const JOURNAL_SCAN_LIMIT = 500;

export class Registry {
  #memory;
  #clock;

  constructor({ memory, clock } = {}) {
    if (!memory) throw new TypeError('Registry requires memory. There is no answer without it.');
    this.#memory = memory;
    this.#clock = clock ?? (() => new Date().toISOString());
  }

  /**
   * Where one agent stands right now.
   *
   * Memory failures are not caught. A registry that swallowed them would answer
   * "never certified" for an agent whose revoked certificate it simply could
   * not read, which is the most dangerous wrong answer this service can give.
   */
  async standingOf(target) {
    const [record, registration] = await Promise.all([
      this.#memory.recallCertification(target),
      this.#memory.recallRiskLevel(target),
    ]);

    return this.#describe({ target, record, registration, now: this.#clock() });
  }

  /**
   * Everything halflife has ever certified, each judged against the clock now.
   *
   * Two list calls and a join rather than one call per agent, because the
   * registry page asks this question about every agent at once and a round trip
   * per agent would make the page slower the more the product is used.
   */
  async list() {
    const [agents, registrations] = await Promise.all([
      this.#memory.listRegistry(),
      this.#memory.listRiskLevels(),
    ]);

    const levels = new Map();
    for (const entity of registrations ?? []) {
      if (entity?.name) levels.set(entity.name, entity.body ?? null);
    }

    const now = this.#clock();
    const entries = (agents ?? []).map((entity) =>
      this.#describe({
        target: entity?.name,
        record: entity?.body ?? null,
        registration: levels.get(entity?.name) ?? null,
        now,
      }),
    );

    // Registered but never successfully checked is a real state and belongs in
    // the registry. Leaving it out would hide precisely the agents halflife has
    // promised to watch and has not managed to.
    for (const [name, registration] of levels) {
      if (!entries.some((entry) => entry.target === name)) {
        entries.push(this.#describe({ target: name, record: null, registration, now }));
      }
    }

    return { asOf: now, agents: entries };
  }

  /**
   * The agents whose certificates are expired or expiring.
   *
   * `withinMs` looks forward: an agent that is not stale yet but will be within
   * the window is due, because a scheduler that only ever noticed certificates
   * after they expired would guarantee every certificate spends time expired.
   */
  async due({ withinMs = 0 } = {}) {
    const { asOf, agents } = await this.list();
    const horizon = Date.parse(asOf) + Math.max(0, withinMs);

    const due = agents.filter((agent) => {
      if (agent.standing === STANDING.STALE) return true;
      // Never certified and never measured has no expiry to be past, but it is
      // still work outstanding: halflife was asked to watch this agent and has
      // not yet managed one completed check.
      if (agent.standing === STANDING.NOT_CERTIFIED) return agent.registered;
      if (!agent.dueAt) return false;
      return Date.parse(agent.dueAt) <= horizon;
    });

    return { asOf, due };
  }

  /**
   * One agent's history, oldest entry last, exactly as it was written.
   *
   * Filtered in this process rather than queried, because the journal is an
   * append-only event stream with no per-agent index and memory/bridge.py is
   * deliberately too dumb to grow one. The scan limit is stated in the answer
   * so a caller reading a truncated history knows that is what it is looking
   * at, instead of concluding an agent has no older history than this.
   */
  async journalOf(target, { limit = 20 } = {}) {
    const events = await this.#memory.readRunHistory(JOURNAL_SCAN_LIMIT);
    const all = Array.isArray(events) ? events : [];

    const mine = all
      .filter((event) => matchesTarget(event, target))
      .slice(0, Math.max(1, Math.min(limit, JOURNAL_SCAN_LIMIT)));

    return {
      target,
      scannedEvents: all.length,
      scanLimit: JOURNAL_SCAN_LIMIT,
      truncated: all.length >= JOURNAL_SCAN_LIMIT,
      entries: mine.map((event) => ({
        at: event?.ts ?? null,
        lines: Array.isArray(event?.acted) ? event.acted : [],
        detail: event?.extra ?? null,
      })),
    };
  }

  /** The journal as written, across every agent. */
  async journal({ limit = 20 } = {}) {
    const events = await this.#memory.readRunHistory(Math.max(1, Math.min(limit, JOURNAL_SCAN_LIMIT)));
    return (Array.isArray(events) ? events : []).map((event) => ({
      at: event?.ts ?? null,
      lines: Array.isArray(event?.acted) ? event.acted : [],
      detail: event?.extra ?? null,
    }));
  }

  #describe({ target, record, registration, now }) {
    const riskLevel = isKnownRiskLevel(registration?.riskLevel)
      ? registration.riskLevel
      : DEFAULT_RISK_LEVEL;

    const assessment = assessStanding({
      riskLevel,
      verdict: record?.verdict ?? null,
      certificateStatus: record?.certificateStatus ?? CERTIFICATE.VALID,
      // Qualification is stored with the level it was earned at, so raising an
      // agent's level does not carry a lower bar's qualification across. An
      // agent that qualified at LOW and was then moved to CRITICAL has not held
      // the CRITICAL bar, and calling a later fall a revocation would accuse it
      // of losing something it never had.
      everQualified: record?.qualifiedForRiskLevel === riskLevel,
      lastMeasuredAt: record?.certifiedAt ?? null,
      now,
    });

    return {
      target,
      asOf: now,
      // Whether anybody chose this level, or whether it is the default an
      // unregistered agent gets. A reader has to be able to tell the two apart
      // before treating the bar as one the agent's owner agreed to.
      registered: isKnownRiskLevel(registration?.riskLevel),
      riskLevel,
      riskLevelSetAt: registration?.setAt ?? null,
      // Null means an unattended re-check cannot be run for this agent, which
      // is why it can sit stale forever without anything being wrong.
      checkRequest: registration?.checkRequest ?? null,
      standing: assessment.standing,
      standingReason: assessment.reason,
      minimumVerdict: assessment.minimumVerdict,
      meetsMinimumBand: assessment.meetsMinimumBand,
      recheckEvery: assessment.recheckEvery,
      stale: assessment.stale,
      dueAt: assessment.dueAt,
      overdueByMs: assessment.overdueByMs,
      certificate: record
        ? {
            verdict: record.verdict ?? null,
            score: record.score ?? null,
            specVersion: record.specVersion ?? null,
            certificateStatus: record.certificateStatus ?? null,
            certifiedAt: record.certifiedAt ?? null,
            judgedAtRiskLevel: record.riskLevel ?? null,
            qualifiedForRiskLevel: record.qualifiedForRiskLevel ?? null,
            silentWrongCount: record.silentWrongCount ?? null,
            probesCompleted: record.probesCompleted ?? null,
            verdictReason: record.verdictReason ?? null,
            reportId: record.reportId ?? null,
            reportHash: record.reportHash ?? null,
            signed: record.signed ?? false,
          }
        : null,
      // The last attempt, successful or not. Reported separately from
      // `certifiedAt` on purpose: a run of failed checks leaves an agent looking
      // untouched unless somebody can see the attempts, and "we keep trying and
      // cannot reach it" is a different story from "nobody has tried".
      lastCheckedAt: record?.lastCheckedAt ?? null,
      lastCheckFailedAt: record?.lastCheckFailedAt ?? null,
      lastCheckFailure: record?.lastCheckFailure ?? null,
    };
  }
}

function matchesTarget(event, target) {
  if (event?.extra?.target === target) return true;
  // Older lines were written before every journal entry carried structured
  // fields. Falling back to the text keeps that history readable rather than
  // silently dropping it out of an agent's page.
  return Array.isArray(event?.acted) && event.acted.some((line) => String(line).startsWith(`${target}:`));
}
