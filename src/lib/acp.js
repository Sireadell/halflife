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
 */
export function resolveAcpConfig(env = process.env) {
  const missing = [];
  const read = (name) => {
    const value = (env[name] ?? '').trim();
    if (!value) missing.push(name);
    return value;
  };

  const agentWalletAddress = read('HALFLIFE_ACP_AGENT_WALLET_ADDRESS');
  const whitelistedWalletPrivateKey = read('HALFLIFE_ACP_PRIVATE_KEY');
  const entityId = read('HALFLIFE_ACP_ENTITY_ID');

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

  const entity = Number(entityId);
  if (!Number.isInteger(entity) || entity <= 0) {
    return { ok: false, missing: [], reason: `HALFLIFE_ACP_ENTITY_ID='${entityId}' is not a whole entity id` };
  }

  return { ok: true, agentWalletAddress, whitelistedWalletPrivateKey, entityId: entity };
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
  loadSdk = () => import('@virtuals-protocol/acp-node'),
} = {}) {
  const config = resolveAcpConfig(env);
  if (!config.ok) return { enabled: false, reason: config.reason, missing: config.missing };

  let sdk;
  try {
    sdk = await loadSdk();
  } catch (error) {
    return {
      enabled: false,
      reason: `the ACP SDK could not be loaded: ${error.message}. Halflife runs without it; only being hired through ACP is off.`,
      missing: [],
    };
  }

  const AcpClient = sdk.default ?? sdk.AcpClient;
  const buildContract = sdk.AcpContractClient?.build ?? sdk.AcpContractClient?.buildAcpClient;
  if (typeof AcpClient !== 'function' || typeof buildContract !== 'function') {
    return {
      enabled: false,
      reason:
        'the installed @virtuals-protocol/acp-node does not expose AcpClient and AcpContractClient.build, ' +
        'which is what this adapter was written against. Refusing to guess at a different API rather than ' +
        'accepting jobs halflife might never deliver.',
      missing: [],
    };
  }

  const contract = await buildContract(
    config.whitelistedWalletPrivateKey,
    config.entityId,
    config.agentWalletAddress,
  );

  const client = new AcpClient({
    acpContractClient: contract,
    onNewTask: async (job) => {
      try {
        const deliverable = await answerStandingJob({ registry, job, clock });
        await deliver(job, deliverable);
        log.log(`acp: answered job for ${deliverable.target}: ${deliverable.standing}`);
      } catch (error) {
        // Rejected rather than delivered empty. A job that cannot be answered
        // honestly is one halflife should not be paid for.
        log.error(`acp: refusing job: ${error.message}`);
        await reject(job, error.message).catch(() => {});
      }
    },
  });

  await client.init?.();
  return { enabled: true, client, agentWalletAddress: config.agentWalletAddress };
}

async function deliver(job, deliverable) {
  const payload = { type: 'application/json', value: JSON.stringify(deliverable) };
  if (typeof job?.deliver === 'function') return job.deliver(payload);
  if (typeof job?.deliverJob === 'function') return job.deliverJob(payload);
  throw new AcpJobRefused('the ACP job object exposes no way to deliver a result');
}

async function reject(job, reason) {
  if (typeof job?.reject === 'function') return job.reject(reason);
  if (typeof job?.respond === 'function') return job.respond(false, reason);
  throw new AcpJobRefused('the ACP job object exposes no way to refuse a job');
}
