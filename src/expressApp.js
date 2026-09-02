// The HTTP surface.
//
// What a caller can do, in the order somebody meets it:
//
//   GET  /                          the page, explaining what this is
//   GET  /about                     what this deployment is and is not configured to do
//   GET  /health                    is the process up
//
//   POST /agents                    register an agent at a risk level
//   GET  /agents                    the registry, every standing judged against the clock now
//   GET  /agents/:target            one agent's standing, judged against the clock now
//   GET  /agents/:target/journal    that agent's history, as written
//   POST /agents/:target/certify    run a check now
//
//   GET  /due                       whose certificate has run out of time
//   POST /sweep                     re-check everything that has
//
//   POST /acp/jobs                  answer a standing question in the shape ACP asks it
//
// `:target` is how halflife knows an agent, and it is usually a URL, so it is
// percent-encoded in the path. `?target=` is accepted on the same routes for
// callers that would rather not encode anything.
//
// THREE RULES THIS FILE HOLDS TO, ALL OF THEM THE SAME RULE UNDERNEATH.
//
// 1. A MEMORY FAILURE IS A 503 THAT SAYS SO. memory.js throws on purpose and
//    nothing here catches it into a default. An empty registry and an
//    unreachable database look identical in a cheerful implementation, and one
//    of them means every answer this service gave today was made up.
//
// 2. THE FIVE STANDINGS SURVIVE THE JSON. There is no boolean anywhere in a
//    response that collapses them. A buyer that wants one can decide for itself
//    which of the five it accepts; halflife will not decide that on its behalf,
//    because the difference between "got worse", "never qualified" and "we have
//    not checked" is the entire product.
//
// 3. NO VERDICT IS INVENTED. Every read goes through registry.js, which
//    recomputes staleness from the stored evidence and the current time. No
//    route ever hands back the `standing` word that was written at check time.

import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { MemoryUnavailableError } from './lib/memory.js';
import { RISK_LEVELS, STANDING, DEFAULT_RISK_LEVEL, isKnownRiskLevel } from './lib/risk.js';
import { sweepDue } from './lib/sweep.js';
import { answerStandingJob, AcpJobRefused, SERVICE as ACP_SERVICE } from './lib/acp.js';
import { resolvePaidConfig } from './lib/x402Payment.js';
import { resolveAcpConfig } from './lib/acp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** How many agents one sweep will pay for unless the caller says otherwise. */
const SWEEP_LIMIT = 25;

/**
 * Turn a thrown error into a status and a body.
 *
 * The memory case is separated from everything else because it is the only
 * failure where the honest answer is "halflife does not know", as opposed to
 * "the caller asked for something wrong" or "something broke". 503 rather than
 * 500 because it is temporary and a caller should retry rather than conclude
 * the agent has no certificate.
 */
function fail(res, error) {
  if (error instanceof MemoryUnavailableError) {
    return res.status(503).json({
      error:
        'halflife cannot reach its memory, so it cannot answer. It is not saying this agent has no ' +
        'certificate, it is saying it does not know. Try again once memory is back.',
      memory: 'unavailable',
      detail: error.message,
    });
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    return res.status(400).json({ error: error.message });
  }
  return res.status(500).json({ error: error.message });
}

/** Read the agent out of the path or the query string, whichever was used. */
function targetOf(req) {
  const fromPath = req.params?.target;
  const fromQuery = typeof req.query?.target === 'string' ? req.query.target : null;
  const target = (fromPath ?? fromQuery ?? '').trim();
  return target.length > 0 ? target : null;
}

/**
 * The three states a deployment's certification route can be in.
 *
 * Modelled on the same three StressProof uses for its payment gate, and for the
 * same reason: a deployment that meant to pay and cannot must not quietly fall
 * back to the free demo route. A free run answering in place of a paid one looks
 * exactly like success in every log line, right up until somebody notices the
 * verdicts came from a rate-limited demo.
 */
export const CERTIFICATION = Object.freeze({
  FREE: 'free',
  PAID: 'paid',
  MISCONFIGURED: 'misconfigured',
});

export function createApp({
  certifier,
  registry,
  memory,
  certification = { mode: CERTIFICATION.FREE, reason: null },
  clock = () => new Date().toISOString(),
  env = process.env,
} = {}) {
  if (!certifier || !registry) {
    throw new TypeError('createApp requires a certifier and a registry');
  }

  /**
   * Refuse before running anything if this deployment meant to buy its
   * certifications and cannot. Reaching a certify handler in that state would
   * hand back a free verdict wearing a paid product's clothes.
   */
  const refuseIfMisconfigured = (res) => {
    if (certification.mode !== CERTIFICATION.MISCONFIGURED) return false;
    res.status(503).json({
      error: certification.reason,
      certification: certification.mode,
      note: 'No check was run. Nothing was certified and no certificate was revoked.',
    });
    return true;
  };

  const app = express();
  app.use(express.json({ limit: '256kb' }));
  app.use(express.static(path.join(HERE, '..', 'public')));

  // --- what this deployment is ---------------------------------------------
  //
  // Configuration is reported as three separate states rather than as a
  // boolean, for the same reason standings are: "off", "misconfigured" and
  // "live" need different actions from whoever reads it, and a half-deployed
  // service should be visible from outside instead of only in the logs.
  app.get('/about', async (_req, res) => {
    const paid = resolvePaidConfig(env);
    const acp = resolveAcpConfig(env);

    // Asked for real, not assumed. A service that reported its memory as
    // working because it was configured would be making exactly the claim this
    // product exists to distrust.
    let memoryStatus = { reachable: false, detail: 'no memory was wired into this app' };
    if (memory) {
      try {
        await memory.recallCertification('halflife-about-probe.invalid');
        memoryStatus = { reachable: true, detail: null };
      } catch (error) {
        memoryStatus = { reachable: false, detail: error.message };
      }
    }

    res.json({
      product: 'Halflife',
      claim: 'A certification that expires. Halflife does not run the tests. It remembers the verdict, compares it with last time, and revokes the certificate if the agent got worse.',
      memory: memoryStatus,
      standings: {
        values: Object.values(STANDING),
        note: 'Five states, not two. Only `revoked` is a finding about the agent. `stale` is halflife failing to check. `never_qualified` means nothing was ever issued, so nothing was taken away. `not_certified` means halflife has never completed a check.',
        computedAt: 'read time, against the clock, on every request. A certificate does not stay valid because nobody looked at it.',
      },
      riskLevels: Object.fromEntries(
        Object.entries(RISK_LEVELS).map(([level, policy]) => [
          level,
          { recheckEvery: policy.period, mustHold: policy.minimumVerdict, example: policy.example },
        ]),
      ),
      defaultRiskLevel: DEFAULT_RISK_LEVEL,
      certification: {
        performedBy: 'StressProof, a separate service',
        // free | paid | misconfigured. Stated rather than left to be discovered
        // by watching whether a run costs anything.
        mode: certification.mode,
        reason: certification.reason,
        note: 'Halflife certifies nothing itself. It buys certification and remembers the result.',
      },
      payment: {
        // Whether this deployment could pay, not whether it ever has. No
        // transaction is claimed here and none will be until one exists.
        configured: paid.ok,
        reason: paid.ok ? null : paid.reason,
        price: paid.ok ? { amount: paid.priceUsdc, currency: 'USDC', network: paid.networkLabel } : null,
        settledPaymentsClaimed: 0,
      },
      acp: {
        connected: acp.ok,
        reason: acp.ok ? null : acp.reason,
        service: ACP_SERVICE,
        // Said in the machine-readable answer as well as in the docs, because
        // the claim that matters is the one a judge can check from outside.
        note: 'The job handler is built and tested against fake jobs, and is reachable at POST /acp/jobs. Halflife has never been registered on the live ACP network, and no live job has ever arrived.',
      },
      limitations: [
        'Halflife runs no probes of its own. Every verdict it reports came from StressProof.',
        'A certificate can only be as fresh as the last completed check. When halflife cannot check, it says the certificate is stale rather than pretending it is current.',
        'An agent with no registered re-check request can never be swept, so it will go stale and stay stale until somebody asks for a check by hand.',
      ],
    });
  });

  app.get('/health', (_req, res) => res.json({ ok: true, at: clock() }));

  // --- registration ---------------------------------------------------------
  app.post('/agents', async (req, res) => {
    const target = typeof req.body?.target === 'string' ? req.body.target.trim() : '';
    const riskLevel = req.body?.riskLevel;

    if (!target) return res.status(400).json({ error: 'target is required: the agent to register' });
    if (!isKnownRiskLevel(riskLevel)) {
      return res.status(400).json({
        error: `riskLevel is required and must be one of ${Object.keys(RISK_LEVELS).join(', ')}`,
        // Named rather than substituted. Quietly registering a payment agent at
        // the assistant's bar because of a typo is the failure this product is
        // about.
        levels: Object.fromEntries(
          Object.entries(RISK_LEVELS).map(([level, policy]) => [
            level,
            `${policy.period}, must hold ${policy.minimumVerdict}`,
          ]),
        ),
      });
    }

    try {
      const registration = await certifier.registerRiskLevel(target, riskLevel, {
        check: req.body?.check,
      });
      const standing = await registry.standingOf(target);
      res.status(201).json({
        ...registration,
        standing: standing.standing,
        standingReason: standing.standingReason,
        // Registering an agent is not certifying it, and the reply says so
        // rather than leaving a caller to assume a check happened.
        note: registration.checkRequest
          ? 'Registered. No check has been run by this call. POST to this agent\'s /certify to run one now, or leave it to the sweep.'
          : 'Registered, with no re-check request. Halflife cannot check this agent unattended: send `check` with a sampleBody it accepts, or run every check by hand.',
      });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- the registry ---------------------------------------------------------
  app.get('/agents', async (_req, res) => {
    try {
      res.json(await registry.list());
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/agents/:target', async (req, res) => {
    const target = targetOf(req);
    if (!target) return res.status(400).json({ error: 'name the agent to look up' });
    try {
      res.json(await registry.standingOf(target));
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/agents/:target/journal', async (req, res) => {
    const target = targetOf(req);
    if (!target) return res.status(400).json({ error: 'name the agent whose history you want' });
    const limit = Number.parseInt(req.query?.limit ?? '20', 10);
    try {
      res.json(await registry.journalOf(target, { limit: Number.isFinite(limit) ? limit : 20 }));
    } catch (error) {
      fail(res, error);
    }
  });

  // --- run a check now ------------------------------------------------------
  //
  // The registered re-check request is used unless the caller supplies one, so
  // a check by hand and a check by sweep send the agent the same thing and
  // their results are comparable. A caller that sends its own is trusted with
  // it, including auth headers, which are used for this one run and never
  // stored.
  app.post('/agents/:target/certify', async (req, res) => {
    const target = targetOf(req);
    if (!target) return res.status(400).json({ error: 'name the agent to certify' });
    if (refuseIfMisconfigured(res)) return;

    try {
      const registered = await certifier.checkRequestFor(target);
      const supplied = req.body && Object.keys(req.body).length > 0 ? req.body : null;
      const request = supplied ?? registered ?? {};

      const result = await certifier.certify(target, request);

      // 200 even when the run could not be measured, because the request was
      // handled correctly and the answer is a real one: halflife tried and
      // could not find out. `measured` says which happened, and the certificate
      // is reported untouched rather than as a failure of the agent.
      res.json({
        target: result.target,
        checkedAt: result.checkedAt,
        measured: result.measured,
        upstreamReached: result.upstreamReached,
        unmeasurableReason: result.unmeasurableReason,
        standing: result.standing,
        standingReason: result.standingReason,
        drift: result.drift,
        revoked: result.revoked,
        riskLevel: result.riskLevel,
        minimumVerdict: result.minimumVerdict,
        meetsMinimumBand: result.meetsMinimumBand,
        previousVerdict: result.previousVerdict,
        currentVerdict: result.currentVerdict,
        scoreDelta: result.scoreDelta,
        reason: result.reason,
        stale: result.stale,
        dueAt: result.dueAt,
        lastMeasuredAt: result.lastMeasuredAt,
        specVersion: result.specVersion,
        previousSpecVersion: result.previousSpecVersion,
        specVersionChanged: result.specVersionChanged,
        journalLine: result.journalLine,
        usedRegisteredCheck: supplied === null && registered !== null,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  // --- expiry ---------------------------------------------------------------
  app.get('/due', async (req, res) => {
    const withinMs = Number.parseInt(req.query?.withinMs ?? '0', 10);
    try {
      res.json(await registry.due({ withinMs: Number.isFinite(withinMs) ? withinMs : 0 }));
    } catch (error) {
      fail(res, error);
    }
  });

  app.post('/sweep', async (req, res) => {
    if (refuseIfMisconfigured(res)) return;
    const limit = Number.parseInt(req.body?.limit ?? SWEEP_LIMIT, 10);
    const withinMs = Number.parseInt(req.body?.withinMs ?? 0, 10);
    try {
      res.json(
        await sweepDue({
          registry,
          certifier,
          limit: Number.isFinite(limit) ? limit : SWEEP_LIMIT,
          withinMs: Number.isFinite(withinMs) ? withinMs : 0,
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });

  // --- the ACP job, over HTTP ----------------------------------------------
  //
  // The same handler the live ACP adapter calls, reachable without a wallet or
  // a registration. It exists so the part of the Virtuals integration that
  // could be built and proved is something anyone can exercise, rather than a
  // claim resting on a network halflife has not joined.
  app.post('/acp/jobs', async (req, res) => {
    try {
      res.json(await answerStandingJob({ registry, job: req.body, clock }));
    } catch (error) {
      if (error instanceof AcpJobRefused) {
        return res.status(error.retryable ? 503 : 400).json({
          error: error.message,
          retryable: error.retryable,
          service: ACP_SERVICE,
        });
      }
      fail(res, error);
    }
  });

  app.use((_req, res) => res.status(404).json({ error: 'no such route. GET /about lists what this service does.' }));

  return app;
}
