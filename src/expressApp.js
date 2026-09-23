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
//   POST /demo/certify/paid         paid public Arc demo: pay Halflife, certify, write Arc memo
//   GET  /demo/certify/paid/latest  latest public paid Arc demo result
//   GET  /demo/arc-proof/verify     check the built-in Arc proof against Arc RPC
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
import { createDemoGuard } from './lib/demoGuard.js';
import { certifyOnArc } from './lib/arcCertifier.js';
import { createArcDemoPaymentGate } from './lib/arcDemoPaymentGate.js';
import { buildPaidArcDemoSnapshot, createArcDemoResultStore } from './lib/arcDemoResultStore.js';
import { createArcProofVerifier } from './lib/arcProofVerifier.js';
import { createUpstreamFundingCheck } from './lib/upstreamFunding.js';

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

function paidArcDemoRefusal(reason, next) {
  const plainReason = reason.includes('HALFLIFE_ARC_PRIVATE_KEY')
    ? 'the Arc writing key is missing'
    : reason.replace(/[.]+$/, '');
  return {
    ok: false,
    charged: false,
    checked: false,
    arcWritten: false,
    summary: `Paid route refused before charging because ${plainReason}.`,
    error: reason,
    next,
  };
}

const htmlEscape = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  })[char]);

const shortHash = (value) => {
  const text = String(value ?? '');
  return text.length > 22 ? `${text.slice(0, 10)}...${text.slice(-8)}` : text;
};

function renderArcProofPage(proof) {
  const explorer = 'https://arc.etherscan.io/tx/';
  const issuedPayload = proof.issued?.payload ?? {};
  const revokedPayload = proof.revoked?.payload ?? {};
  const agent = revokedPayload.agent ?? issuedPayload.agent ?? 'unknown';
  const issuedHash = proof.issued?.txHash ?? null;
  const revokedHash = proof.revoked?.txHash ?? null;
  const issuedCertificate = issuedPayload.certificateHash ?? 'unknown';
  const revokedCertificate = revokedPayload.certificateHash ?? 'unknown';
  const reason = revokedPayload.reason ?? 'The certificate was revoked after the later check no longer matched the original certificate condition.';

  const record = ({ title, status, txHash, certificateHash, at, summary }) => `
    <article class="record">
      <div>
        <span class="label">${htmlEscape(title)}</span>
        <h2>${htmlEscape(status)}</h2>
        <p>${htmlEscape(summary)}</p>
      </div>
      <dl>
        <div><dt>Time</dt><dd>${htmlEscape(at ?? 'unknown')}</dd></div>
        <div><dt>Certificate hash</dt><dd class="mono">${htmlEscape(certificateHash)}</dd></div>
        <div><dt>Transaction</dt><dd class="mono">${txHash ? `<a href="${explorer}${htmlEscape(txHash)}" target="_blank" rel="noopener">${htmlEscape(shortHash(txHash))}</a>` : 'missing'}</dd></div>
      </dl>
    </article>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Halflife Arc Proof</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%23111613'/%3E%3Cpath d='M9 12h14v8H9z' fill='none' stroke='white' stroke-width='3'/%3E%3C/svg%3E">
<style>
:root{--page:#eef1ee;--paper:#fff;--surface:#f6f7f4;--ink:#111613;--muted:#606861;--line:#d9ded8;--blue:#2b5d9a;--blue-soft:#eaf1fb;--red:#963a34;--red-soft:#f8e5e2}
*{box-sizing:border-box}body{margin:0;background:var(--page);color:var(--ink);font:15px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}a{color:var(--blue);text-decoration:none}a:hover{text-decoration:underline;text-underline-offset:3px}.page{width:min(1080px,calc(100% - 40px));margin:30px auto;background:var(--paper);border:1px solid #e1e5df;border-radius:16px;overflow:hidden;box-shadow:0 20px 55px rgba(24,32,28,.08)}header{display:flex;justify-content:space-between;gap:18px;padding:24px 30px;border-bottom:1px solid var(--line)}.brand{color:var(--ink);font-size:18px;font-weight:850}.nav{display:flex;gap:16px;flex-wrap:wrap}.hero{padding:54px 30px 30px}.label{color:var(--muted);font-size:11px;font-weight:850;letter-spacing:.08em;text-transform:uppercase}h1,h2,p{margin:0}h1{max-width:780px;margin-top:16px;font-size:clamp(42px,6vw,72px);line-height:.98;letter-spacing:0}h2{margin-top:8px;font-size:23px;line-height:1.12}.lede{max-width:690px;margin-top:20px;color:var(--muted);font-size:18px}.status{display:inline-flex;margin-top:26px;border:1px solid #9fb7d3;border-radius:5px;padding:8px 10px;background:var(--blue-soft);color:var(--blue);font-size:12px;font-weight:900;letter-spacing:.06em;text-transform:uppercase}.agent{margin-top:18px;color:var(--muted);word-break:break-all}.records{display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:0 30px 30px}.record{border:1px solid var(--line);border-radius:9px;background:var(--surface);padding:18px}.record:last-child{background:var(--red-soft);border-color:#d7a5a0}.record p{margin-top:8px;color:var(--muted)}dl{display:grid;gap:12px;margin:18px 0 0}dt{color:var(--muted);font-size:11px;font-weight:850;letter-spacing:.08em;text-transform:uppercase}dd{margin:4px 0 0;word-break:break-word}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.reason{margin:0 30px 30px;border:1px solid #d7a5a0;border-radius:9px;background:var(--red-soft);padding:18px}.reason p{margin-top:8px;color:#57231f}.raw{padding:0 30px 34px}details{border:1px solid var(--line);border-radius:9px;background:#fff}summary{cursor:pointer;padding:14px 16px;font-weight:800}pre{margin:0;border-top:1px solid var(--line);padding:16px;max-height:360px;overflow:auto;background:#111613;color:#f7f7f2;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;white-space:pre-wrap}footer{display:flex;justify-content:space-between;gap:18px;padding:20px 30px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}@media(max-width:760px){.page{width:calc(100% - 16px);margin:8px auto;border-radius:12px}header,footer{flex-direction:column;padding:19px}.hero{padding:42px 19px 24px}h1{font-size:37px}.records{grid-template-columns:1fr;padding:0 19px 24px}.reason,.raw{margin-left:19px;margin-right:19px}.raw{padding-left:0;padding-right:0}}
</style>
</head>
<body>
<div class="page">
  <header>
    <a class="brand" href="/judge.html">Halflife</a>
    <nav class="nav" aria-label="Proof links">
      <a href="/judge.html#history">Proof history</a>
      <a href="${explorer}${htmlEscape(issuedHash)}" target="_blank" rel="noopener">Issue tx</a>
      <a href="${explorer}${htmlEscape(revokedHash)}" target="_blank" rel="noopener">Revoke tx</a>
    </nav>
  </header>
  <main>
    <section class="hero">
      <span class="label">Arc proof verifier</span>
      <h1>The issue and revoke records match.</h1>
      <p class="lede">${htmlEscape(proof.summary)}</p>
      <div class="status">${proof.ok ? 'Verified on Arc' : 'Needs review'}</div>
      <p class="agent mono">Agent wallet: ${htmlEscape(agent)}</p>
    </section>
    <section class="records">
      ${record({
        title: 'Certificate issued',
        status: proof.issued?.ok ? 'Issue record verified' : 'Issue record needs review',
        txHash: issuedHash,
        certificateHash: issuedCertificate,
        at: issuedPayload.at,
        summary: proof.issued?.summary,
      })}
      ${record({
        title: 'Certificate revoked',
        status: proof.revoked?.ok ? 'Revoke record verified' : 'Revoke record needs review',
        txHash: revokedHash,
        certificateHash: revokedCertificate,
        at: revokedPayload.at,
        summary: proof.revoked?.summary,
      })}
    </section>
    <section class="reason">
      <span class="label">Why it matters</span>
      <p>${htmlEscape(reason)}</p>
    </section>
    <section class="raw">
      <details>
        <summary>Show raw verifier response</summary>
        <pre>${htmlEscape(JSON.stringify(proof, null, 2))}</pre>
      </details>
    </section>
  </main>
  <footer>
    <span class="mono">Arc chain ${htmlEscape(proof.chain?.id ?? '5042')}</span>
    <span>This page is generated from Halflife's live verifier route.</span>
  </footer>
</div>
</body>
</html>`;
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
  env = process.env,
  arcClients = null,
  arcConfigReason = null,
  paidArcDemoGate = createArcDemoPaymentGate({ env }),
  certifyOnArcFn = certifyOnArc,
  arcDemoResultStore = createArcDemoResultStore({ env }),
  arcProofVerifier = createArcProofVerifier({ env }),
  canAffordOneRun = createUpstreamFundingCheck({ paidConfig: resolvePaidConfig(env) }),
  clock = () => new Date().toISOString(),
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

  const demoGuard = process.env.NODE_ENV !== 'test' ? createDemoGuard() : (req, res, next) => next();

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
      arcPaidDemo: {
        route: 'POST /demo/certify/paid',
        payment: {
          mode: paidArcDemoGate.mode,
          enabled: Boolean(paidArcDemoGate.enabled && paidArcDemoGate.middleware && arcClients),
          reason: paidArcDemoGate.reason ?? (!arcClients ? arcConfigReason ?? 'Arc writing is not configured' : null),
          price: paidArcDemoGate.config
            ? { amount: paidArcDemoGate.config.priceUsdc, currency: 'USDC', network: paidArcDemoGate.config.network }
            : null,
          payTo: paidArcDemoGate.config?.payTo ?? null,
        },
        note:
          'A visitor pays Halflife on Arc first. Only then does Halflife buy/run the certification and write issue or revoke proof to Arc when the result changes.',
        latestResult: 'GET /demo/certify/paid/latest',
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

  app.get('/demo/arc-proof/verify', async (req, res) => {
    try {
      const proof = await arcProofVerifier.verifyManualProof();
      if (req.accepts(['html', 'json']) === 'html') {
        return res.type('html').send(renderArcProofPage(proof));
      }
      res.json(proof);
    } catch (error) {
      fail(res, error);
    }
  });

  app.get('/demo/certify/paid/latest', async (_req, res) => {
    try {
      const latest = await arcDemoResultStore.read();
      if (!latest) {
        return res.status(404).json({
          ok: false,
          summary: 'No paid Arc demo run has been recorded yet.',
          error: 'No paid Arc demo run has been recorded yet.',
          next: 'Run POST /demo/certify/paid after configuring Arc writing and x402 payment.',
        });
      }
      res.json({
        ok: true,
        summary: 'Latest paid Arc demo proof found. This is the most recent paid run Halflife saved for the judge page.',
        ...latest,
      });
    } catch (error) {
      fail(res, error);
    }
  });

  const validatePaidArcDemo = (req, res, next) => {
    if (!paidArcDemoGate.enabled || !paidArcDemoGate.middleware) {
      const reason = paidArcDemoGate.reason ?? 'the Arc paid demo payment setup is not configured';
      return res.status(503).json({
        ...paidArcDemoRefusal(
          reason,
          'Set the Arc payment settings, then try the paid demo again.',
        ),
        note: 'No payment was requested, no check was run, and nothing was written to Arc.',
      });
    }
    if (!arcClients) {
      const reason = arcConfigReason ?? 'Arc writing is not configured';
      return res.status(503).json({
        ...paidArcDemoRefusal(
          reason,
          'Set the Arc writing key, then try the paid demo again.',
        ),
        note: 'No payment was requested, no check was run, and nothing was written to Arc.',
      });
    }

    const targetUrl = typeof req.body?.targetUrl === 'string' ? req.body.targetUrl.trim() : '';
    const agentAddress = typeof req.body?.agentAddress === 'string' ? req.body.agentAddress.trim() : '';
    const request = req.body?.request && typeof req.body.request === 'object'
      ? req.body.request
      : {
          method: req.body?.method,
          sampleBody: req.body?.sampleBody,
          authHeaders: req.body?.authHeaders,
        };

    if (!targetUrl) {
      return res.status(400).json({
        ...paidArcDemoRefusal(
          'targetUrl is missing',
          'Send targetUrl, the agent API address Halflife should check.',
        ),
        error: 'targetUrl is required: the agent API Halflife should certify',
      });
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(agentAddress)) {
      return res.status(400).json({
        ...paidArcDemoRefusal(
          'agentAddress is missing or is not a valid Arc wallet address',
          'Send an Arc wallet address that starts with 0x and has 40 letters or numbers after it.',
        ),
        error: 'agentAddress is required and must be a valid Arc wallet address',
      });
    }
    if (!request || typeof request !== 'object' || request.sampleBody == null || typeof request.sampleBody !== 'object') {
      return res.status(400).json({
        ...paidArcDemoRefusal(
          'sampleBody is missing',
          'Send sampleBody so StressProof has one example request to test.',
        ),
        error:
          'sampleBody is required, either at the top level or inside request.sampleBody, so StressProof has one valid request shape to mutate.',
      });
    }

    req.paidArcDemo = {
      targetUrl,
      agentAddress,
      request: {
        ...request,
        method: (request.method ?? 'POST').toUpperCase(),
      },
    };
    next();
  };

  /**
   * The order here is the whole point.
   *
   * The payment middleware takes the visitor's money as the request passes
   * through it, and the handler that spends halflife's own wallet on the
   * StressProof run does not execute until after that. So this sits in front
   * of the payment middleware, not inside the handler: by the time the handler
   * could notice the problem, the visitor has already paid for a run that
   * cannot happen.
   */
  const refuseIfUpstreamUnaffordable = async (_req, res, next) => {
    let verdict;
    try {
      verdict = await canAffordOneRun();
    } catch {
      // The check failing is not evidence that the run would fail. Left open
      // on purpose, which is no worse than before this check existed.
      return next();
    }
    if (verdict.ok) return next();

    return res.status(503).json({
      ...paidArcDemoRefusal('halflife cannot buy the test run right now', verdict.reason),
      error: verdict.reason,
    });
  };

  const paidArcDemoMiddlewares = [validatePaidArcDemo, refuseIfUpstreamUnaffordable];
  if (paidArcDemoGate.middleware && arcClients) paidArcDemoMiddlewares.push(paidArcDemoGate.middleware);

  app.post('/demo/certify/paid', ...paidArcDemoMiddlewares, async (req, res) => {
    try {
      const result = await certifyOnArcFn(
        { certifier, arcClients },
        {
          targetUrl: req.paidArcDemo.targetUrl,
          agentAddress: req.paidArcDemo.agentAddress,
          request: req.paidArcDemo.request,
        },
      );
      const payment = {
        network: paidArcDemoGate.config.network,
        price: { amount: paidArcDemoGate.config.priceUsdc, currency: 'USDC' },
        payTo: paidArcDemoGate.config.payTo,
      };
      const latest = buildPaidArcDemoSnapshot({
        payment,
        input: req.paidArcDemo,
        result,
        savedAt: clock(),
      });
      await arcDemoResultStore.write(latest);

      // A run that never reached StressProof measured nothing, and the visitor
      // paid for it anyway. Reporting `checked: true` there would be the exact
      // silent failure this product exists to catch, so what the visitor
      // actually got is said plainly instead.
      const measured = Boolean(result.measured);
      const arcWritten = Boolean(result.arc?.written);

      res.json({
        ok: true,
        charged: true,
        checked: measured,
        arcWritten,
        summary: !measured
          ? `The visitor paid, but Halflife could not run the check: ${result.unmeasurableReason ?? 'the run could not be measured'}. Nothing was measured, and the stored certificate is left exactly as it was.`
          : arcWritten
            ? 'Paid Arc demo completed. The visitor paid, Halflife ran the check, and Halflife wrote the result to Arc.'
            : `Paid Arc demo completed. The visitor paid and Halflife ran the check, but no new Arc write was needed: ${result.arc?.reason ?? 'the stored certificate did not need to change'}.`,
        paid: true,
        payment,
        target: result.target,
        agentAddress: req.paidArcDemo.agentAddress,
        checkedAt: result.checkedAt,
        measured: result.measured,
        upstreamReached: result.upstreamReached,
        unmeasurableReason: result.unmeasurableReason,
        standing: result.standing,
        standingReason: result.standingReason,
        currentVerdict: result.currentVerdict,
        previousVerdict: result.previousVerdict,
        revoked: result.revoked,
        reason: result.reason,
        specVersion: result.specVersion,
        reportHash: result.current?.reportHash ?? null,
        arc: result.arc,
        journalLine: result.journalLine,
        latestResult: 'GET /demo/certify/paid/latest',
      });
    } catch (error) {
      fail(res, error);
    }
  });

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
  // The open certify route remains for internal operation. The public Arc demo
  // route above is the paid path a visitor can call without spending our wallet
  // before they have paid Halflife.
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
