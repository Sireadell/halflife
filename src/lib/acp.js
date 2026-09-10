/**
 * Virtuals ACP: halflife as a service other agents can hire.
 *
 * The job is one question, asked by an agent that is about to rely on another
 * agent: does this counterparty's certificate still hold right now. That is the
 * moment halflife's answer is worth anything, and ACP is where that decision
 * gets made at volume.
 *
 * HOW THIS FILE IS SPLIT, AND WHY IT MATTERS.
 *
 * `answerStandingJob` is all of halflife's behaviour and none of Virtuals'. It
 * takes a job-shaped object and the registry, and returns the deliverable. It
 * has no SDK import, no network, no wallet and no chain, so the whole of what
 * halflife actually promises a buyer is exercised by the test suite and by the
 * HTTP route below it.
 *
 * `createAcpService` is the adapter that would put that function on the live
 * network. It is thin on purpose, because it is the part that cannot be tested
 * here: registering an agent profile on ACP is a live action against a service
 * halflife has not been registered with. Everything that could be built and
 * proved without that registration is above the line, and everything that could
 * not is below it and is marked as unverified in the README and in
 * docs/PARTNERS.md rather than quietly counted as working.
 *
 * TWO REFUSALS THIS FILE INHERITS FROM THE REST OF THE PRODUCT.
 *
 * A job about an agent halflife has never certified is ANSWERED, not failed.
 * "I have never checked this agent" is a real and useful answer to a buyer
 * deciding whether to trust a counterparty, and it is a very different answer
 * from "its certificate was revoked". Collapsing the two into an error would
 * throw away the distinction the whole product is built on.
 *
 * A job asked while memory is unreachable is REJECTED, not answered. Halflife
 * cannot say anything about an agent it cannot remember, and a reassuring
 * "nothing on file" produced by a broken database is the exact silent failure
 * this project exists to catch. It is also the one case where a buyer would be
 * paying for an answer that is not an answer.
 */

import { STANDING } from './risk.js';

/** What halflife sells on ACP, in the words a buyer sees. */
export const SERVICE = Object.freeze({
  name: 'Certificate standing check',
  question: 'Does this agent hold a resilience certificate right now, and is it still current?',
  deliverableType: 'application/json',
  note:
    'Halflife answers from what it has actually measured. It does not run a fresh test as part of ' +
    'this job, so the answer is about the certificate on file and how old it is, which is the ' +
    'question being asked.',
});

/**
 * The five standings, each turned into one sentence a buying agent can act on.
 *
 * Written out rather than generated, because this is the text somebody makes a
 * trust decision on and it should be readable in the file that decides it.
 * `trustworthy` is deliberately not a field: reducing five states to a boolean
 * is what halflife exists not to do, and a buyer that wants one can decide for
 * itself which of the five it will accept.
 */
const ADVICE = Object.freeze({
  [STANDING.VALID]:
    'This agent holds a current certificate at the bar its risk level requires, and it has been re-checked inside its period.',
  [STANDING.STALE]:
    'This agent held its certificate when it was last checked, and that was longer ago than its risk level allows. Halflife no longer knows whether it still holds. This is halflife failing to check, not a finding about the agent.',
  [STANDING.REVOKED]:
    'This agent held its certificate and no longer does. It got worse. This is the only one of the five answers that is a finding about the agent.',
  [STANDING.NEVER_QUALIFIED]:
    'This agent has never reached the bar its risk level requires. Nothing was ever issued to it, so nothing has been taken away.',
  [STANDING.NOT_CERTIFIED]:
    'Halflife has never completed a check of this agent. This says nothing about the agent, only that it is not on halflife\'s books.',
});

/** Pull the agent being asked about out of whatever shape the job arrived in. */
export function targetOfJob(job) {
  const requirement = job?.serviceRequirement ?? job?.requirement ?? job?.request ?? job ?? {};
  const parsed = typeof requirement === 'string' ? tryParse(requirement) : requirement;
  const candidate =
    parsed?.target ?? parsed?.agent ?? parsed?.agentUrl ?? parsed?.targetUrl ?? parsed?.counterparty;
  return typeof candidate === 'string' && candidate.trim().length > 0 ? candidate.trim() : null;
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    // A plain string requirement is read as the agent's name rather than
    // refused. A buyer that sent the address and nothing else asked a clear
    // question and should get a clear answer.
    return { target: text };
  }
}

export class AcpJobRefused extends Error {
  constructor(message, { retryable = false } = {}) {
    super(message);
    this.name = 'AcpJobRefused';
    this.retryable = retryable;
  }
}

/**
 * Answer one job.
 *
 * Throws only for a job halflife should not have accepted (no agent named) or
 * one it cannot honestly answer (memory unreachable). Every other outcome,
 * including an agent nobody has ever heard of, comes back as a deliverable.
 */
export async function answerStandingJob({ registry, job, clock = () => new Date().toISOString() }) {
  if (!registry) throw new TypeError('answerStandingJob requires the registry');

  const target = targetOfJob(job);
  if (!target) {
    throw new AcpJobRefused(
      'this job did not name an agent to check. Send { "target": "<the agent>" } as the service requirement.',
    );
  }

  let standing;
  try {
    standing = await registry.standingOf(target);
  } catch (error) {
    // Marked retryable because it is halflife's outage and not the buyer's
    // mistake. Answering anyway would sell a reassurance halflife has no basis
    // for, which is worse than being briefly unable to trade.
    throw new AcpJobRefused(
      `halflife cannot reach its own memory, so it cannot say anything about ${target}. ` +
        `No answer is being given rather than a wrong one: ${error.message}`,
      { retryable: true },
    );
  }

  return {
    answeredAt: clock(),
    target,
    // The full five-state answer, never a boolean. The distinction between
    // "got worse", "never qualified" and "we have not checked" is the product.
    standing: standing.standing,
    meaning: ADVICE[standing.standing] ?? standing.standingReason,
    reason: standing.standingReason,
    riskLevel: standing.riskLevel,
    registered: standing.registered,
    minimumVerdict: standing.minimumVerdict,
    recheckEvery: standing.recheckEvery,
    verdict: standing.certificate?.verdict ?? null,
    certifiedAt: standing.certificate?.certifiedAt ?? null,
    dueAt: standing.dueAt,
    stale: standing.stale,
    lastCheckedAt: standing.lastCheckedAt,
    lastCheckFailure: standing.lastCheckFailure,
    // Where the buyer can read the same answer and the history behind it,
    // rather than having to take the deliverable's word for it.
    checkItYourself: {
      standing: `GET /agents/${encodeURIComponent(target)}`,
      history: `GET /agents/${encodeURIComponent(target)}/journal`,
    },
    // A certification is not run as part of this job, and the deliverable says
    // so in itself so that nobody reading it later mistakes an answer about a
    // stored certificate for a fresh test.
    freshTestRun: false,
    note: SERVICE.note,
  };
}

/**
 * Configuration the live service needs, refusing rather than defaulting.
 *
 * Same rule as x402Payment.js: nothing secret has a default, and a missing
 * variable is a named refusal. A wallet key is a wallet key whether it is
 * paying StressProof or signing an ACP job, and neither belongs in a file.
 *
 * These four map onto acp-node-v2's PrivyAlchemyEvmProviderAdapter, not the
 * older entity-id whitelisting scheme. The Virtuals console never surfaced a
 * numeric entity id for an agent created through its newer Create Agent flow
 * because that scheme belongs to the SDK this adapter no longer uses.
 */
export function resolveAcpConfig(env = process.env) {
  const missing = [];
  const read = (name) => {
    const value = (env[name] ?? '').trim();
    if (!value) missing.push(name);
    return value;
  };

  const agentWalletAddress = read('HALFLIFE_ACP_AGENT_WALLET_ADDRESS');
  const walletId = read('HALFLIFE_ACP_WALLET_ID');
  const signerPrivateKey = read('HALFLIFE_ACP_PRIVATE_KEY');

  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      reason:
        `halflife is not connected to Virtuals ACP: ${missing.join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not set. The rest of halflife runs without it; ` +
        `only the ability to be hired through ACP is off.`,
    };
  }

  return { ok: true, agentWalletAddress, walletId, signerPrivateKey };
}

/**
 * Connect the job handler above to the live ACP network.
 *
 * NOT EXERCISED BY THE TEST SUITE, AND NOT CLAIMED TO WORK. Halflife has no
 * registered agent profile on ACP, so this has never been run against the real
 * service. What the tests do cover is everything the handler decides, which is
 * every part of the answer a buyer would receive.
 *
 * Written defensively for exactly that reason. The SDK is a beta whose method
 * names have moved between releases, so this looks for the method it needs and
 * refuses by name if it is absent, rather than calling something that happens to
 * exist and hoping. A loud refusal at boot is recoverable. A job silently
 * accepted and never delivered is a buyer paying for nothing.
 */
export async function createAcpService({
  registry,
  env = process.env,
  clock = () => new Date().toISOString(),
  log = console,
  loadSdk = () => import('@virtuals-protocol/acp-node-v2'),
  loadChain = () => import('@account-kit/infra').then((m) => m.base),
} = {}) {
  const config = resolveAcpConfig(env);
  if (!config.ok) return { enabled: false, reason: config.reason, missing: config.missing };

  let sdk, base;
  try {
    [sdk, base] = await Promise.all([loadSdk(), loadChain()]);
  } catch (error) {
    return {
      enabled: false,
      reason: `the ACP SDK could not be loaded: ${error.message}. Halflife runs without it; only being hired through ACP is off.`,
      missing: [],
    };
  }

  const { AcpAgent, PrivyAlchemyEvmProviderAdapter, AssetToken } = sdk;
  if (
    typeof AcpAgent?.create !== 'function' ||
    typeof PrivyAlchemyEvmProviderAdapter?.create !== 'function' ||
    typeof AssetToken?.usdc !== 'function'
  ) {
    return {
      enabled: false,
      reason:
        'the installed @virtuals-protocol/acp-node-v2 does not expose AcpAgent.create, ' +
        'PrivyAlchemyEvmProviderAdapter.create and AssetToken.usdc, which is what this adapter was written ' +
        'against. Refusing to guess at a different API rather than accepting jobs halflife might never deliver.',
      missing: [],
    };
  }

  const provider = await PrivyAlchemyEvmProviderAdapter.create({
    walletAddress: config.agentWalletAddress,
    walletId: config.walletId,
    signerPrivateKey: config.signerPrivateKey,
    chains: [base],
  });

  const agent = await AcpAgent.create({ evmProvider: provider });

  // Deliverables are computed when the requirement message arrives and held
  // until the job is funded, because setBudget and submit are two separate
  // steps in this SDK and the buyer's funds have to land before the answer
  // does.
  const pending = new Map();

  agent.on('entry', async (session, entry) => {
    if (entry.kind === 'message' && entry.contentType === 'requirement' && session.status === 'open') {
      const job = { serviceRequirement: JSON.parse(entry.content) };
      try {
        const deliverable = await answerStandingJob({ registry, job, clock });
        pending.set(session.jobId, deliverable);
        await session.setBudget(AssetToken.usdc(0.1, session.chainId));
      } catch (error) {
        log.error(`acp: refusing job ${session.jobId}: ${error.message}`);
      }
      return;
    }

    if (entry.kind === 'system' && entry.event?.type === 'job.funded') {
      const deliverable = pending.get(session.jobId);
      if (!deliverable) return;
      pending.delete(session.jobId);
      await session.submit(JSON.stringify(deliverable));
      log.log(`acp: answered job ${session.jobId} for ${deliverable.target}: ${deliverable.standing}`);
    }
  });

  await agent.start();
  return { enabled: true, agent, agentWalletAddress: config.agentWalletAddress };
}
