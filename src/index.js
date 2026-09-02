/**
 * Boot.
 *
 * Every decision this process makes about what it is allowed to do is made here,
 * once, at start, and said out loud on the way up. The failure worth shouting
 * about is a deployment that looks healthy and is quietly not doing the thing it
 * was deployed to do, which is the same failure halflife sells a product to
 * catch in other people's agents.
 *
 * WHAT REFUSES, AND WHAT ONLY WARNS.
 *
 * A deployment that asked for paid runs and cannot pay REFUSES: the certify and
 * sweep routes answer 503 rather than falling back to StressProof's free demo
 * route. A free verdict standing in for a paid one is invisible from every log
 * line, so it has to be impossible rather than unlikely.
 *
 * An unreachable memory does NOT stop the process from starting. It is loud in
 * the log and honest in /about and in every route that needs it, but the server
 * comes up. The alternative, exiting, means a service that cannot tell anybody
 * why it is down, and memory here is a separate Python process that can come
 * back without this one being restarted.
 *
 * Nothing is read from a file that might not exist, and no secret has a default.
 * A missing variable is a named refusal, never a fallback.
 */

import { createApp, CERTIFICATION } from './expressApp.js';
import { Certifier, createStressProofClient } from './lib/certifier.js';
import { Memory } from './lib/memory.js';
import { Registry } from './lib/registry.js';
import { startSweeper } from './lib/sweep.js';
import { createPaidStressProofClient } from './lib/paidStressproof.js';
import { resolvePaidConfig } from './lib/x402Payment.js';
import { createAcpService } from './lib/acp.js';

const PORT = process.env.PORT || 3000;

const memory = new Memory();
const registry = new Registry({ memory });

/**
 * Free or paid, decided by asking rather than by inferring.
 *
 * Paid runs have to be switched on by name. Halflife will not start paying
 * because five environment variables happen to be present: the wallet is real
 * money and turning it on should be somebody's decision, written down in the
 * deployment. The reverse mistake is the dangerous one and is refused: asked to
 * pay and unable to, it does not run for free.
 */
function chooseCertificationRoute() {
  const wanted = String(process.env.HALFLIFE_PAID_RUNS ?? '').trim().toLowerCase();
  if (wanted !== 'on' && wanted !== 'true' && wanted !== '1') {
    return {
      mode: CERTIFICATION.FREE,
      reason: null,
      client: createStressProofClient(),
    };
  }

  const config = resolvePaidConfig(process.env);
  if (!config.ok) {
    return { mode: CERTIFICATION.MISCONFIGURED, reason: config.reason, client: null };
  }

  try {
    return {
      mode: CERTIFICATION.PAID,
      reason: null,
      // The journal is required by the paying client rather than optional: a
      // payment nobody wrote down is the thing it promises not to do.
      client: createPaidStressProofClient({ journal: memory }),
    };
  } catch (error) {
    return { mode: CERTIFICATION.MISCONFIGURED, reason: error.message, client: null };
  }
}

const certification = chooseCertificationRoute();

/**
 * The certifier still gets a client when payment is misconfigured, and it is the
 * free one. That is not a fallback: the routes that could spend money refuse
 * before they reach it, and this only exists so the object can be constructed at
 * all. Nothing reaches it in that state.
 */
const certifier = new Certifier({
  memory,
  stressproof: certification.client ?? createStressProofClient(),
});

const app = createApp({ certifier, registry, memory, certification });

const server = app.listen(PORT, async () => {
  console.log(`Halflife listening on :${PORT}`);

  if (certification.mode === CERTIFICATION.PAID) {
    console.log(`Certifications: PAID. ${certification.client.priceUsdc} USDC per run on ${certification.client.network}.`);
  } else if (certification.mode === CERTIFICATION.FREE) {
    console.log(
      `Certifications: FREE. Runs go to StressProof's free demo route. Set HALFLIFE_PAID_RUNS=on to buy them instead.`,
    );
  } else {
    console.error(`Certifications: REFUSED. ${certification.reason}`);
    console.error('No check will be run on this deployment until that is fixed. It will not fall back to free runs.');
  }

  // Probed rather than assumed, and probed once at boot so a broken memory is
  // visible immediately instead of on the first request that needed it.
  try {
    await memory.recallCertification('halflife-boot-probe.invalid');
    console.log('Memory: reachable.');
  } catch (error) {
    console.error(`Memory: UNREACHABLE. ${error.message}`);
    console.error(
      'Halflife cannot answer anything about any agent until this is fixed. Requests will be refused with 503 ' +
        'rather than answered with a default, because "no certificate on file" and "the database is down" are not the same answer.',
    );
  }

  // Off unless a deployment asks for it, because a background job that pays for
  // certifications should never start because something was deployed.
  const intervalMs = Number.parseInt(process.env.HALFLIFE_SWEEP_INTERVAL_MS ?? '', 10);
  const sweeper = startSweeper({
    registry,
    certifier,
    intervalMs: certification.mode === CERTIFICATION.MISCONFIGURED ? 0 : intervalMs,
  });
  console.log(
    sweeper.running
      ? `Sweep: on, every ${sweeper.intervalMs}ms. Agents past their re-check period are certified again automatically.`
      : 'Sweep: off. Certificates still expire on read, but nothing re-checks them until POST /sweep is called.',
  );

  // Never registers anything and never signs anything by itself. With no
  // configuration it reports why it is off and the rest of halflife runs
  // unchanged, because being hirable through ACP is a distribution channel and
  // not a dependency.
  const acp = await createAcpService({ registry }).catch((error) => ({
    enabled: false,
    reason: `the ACP service could not start: ${error.message}`,
  }));
  console.log(acp.enabled ? 'Virtuals ACP: connected.' : `Virtuals ACP: off. ${acp.reason}`);
});

// Memory is a child process. Left running, it keeps a Python interpreter alive
// after the service it existed to serve has gone.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => {
      memory.close().finally(() => process.exit(0));
    });
  });
}
