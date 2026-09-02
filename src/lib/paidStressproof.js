/**
 * The StressProof client that pays.
 *
 * It is a drop-in alternative to `createStressProofClient()` in certifier.js:
 * same one method, `certify(request)`, same report envelope back. The certifier
 * was written expecting this to arrive one day and does not change to
 * accommodate it. Nothing in this file knows what a verdict means, what drift
 * is, or when a certificate should be revoked.
 *
 * The whole flow, and why it is four calls rather than one:
 *
 *   1. POST /runs with consentMode 'standing'   free, gets a run id
 *   2. POST /runs/:id/start with no payment     expects 402, reads the bill
 *   3. sign the bill, having first checked it   nothing leaves the wallet before this
 *   4. POST /runs/:id/start with the payment    the run happens, report comes back
 *
 * Step 2 exists because the bill is written by the other side. Asking for it,
 * reading it, and deciding separately whether to pay it is the difference
 * between buying something and handing someone your wallet.
 *
 * THREE THINGS THIS FILE IS STRICT ABOUT.
 *
 * A FAILED PAYMENT PRODUCES NO RESULT. Every failure path throws, and throwing
 * is what the certifier already treats as an upstream that could not be
 * reached: the run is unmeasurable, the remembered verdict is left exactly as
 * it was, and no certificate is revoked. Halflife being unable to pay is
 * halflife's failure and says nothing whatsoever about the agent. There is no
 * path here that returns a partial report, a guessed verdict, or a report from
 * a run that was not paid for.
 *
 * A FAILED PAYMENT IS STILL WRITTEN DOWN. Refusing quietly would be its own
 * silent failure, and this project exists to catch silent failures. It would
 * also make "we tried and could not pay" indistinguishable from "nobody ever
 * tried", which is the difference between a bug and an outage. So every
 * attempt that spends or tries to spend money is journalled, in words, saying
 * what failed and when, and saying plainly that it is not a finding about the
 * agent. The agent's certificate is untouched and expires on its normal
 * schedule through the ordinary staleness path, with no special early-expiry
 * state invented for a payment problem.
 *
 * MONEY SPENT IS AUDITABLE AFTERWARDS. The journal line for a successful
 * payment carries the transaction hash as soon as one exists, along with the
 * amount, the network and who was paid. Somebody checking the chain months
 * later has to be able to find the transaction from halflife's own records
 * rather than from a screenshot.
 */

import {
  resolvePaidConfig,
  chooseAcceptableRequirement,
  createX402Payer,
  formatUsdc,
  PaidRunUnavailableError,
} from './x402Payment.js';

/** How long to wait on StressProof for one HTTP call. */
const HTTP_TIMEOUT_MS = 120_000;

/**
 * Read the settlement receipt StressProof returns once the facilitator has
 * settled. Base64 JSON, decoded here rather than by importing a library, so
 * the test suite can exercise this path without loading anything x402.
 */
export function decodeSettlement(headerValue) {
  if (!headerValue) return null;
  try {
    return JSON.parse(Buffer.from(String(headerValue), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * Pull the transaction hash out of a settlement receipt.
 *
 * Tolerant about where it sits, because the field name is the other side's
 * choice and a receipt whose hash we failed to find is still a settled payment.
 * A missing hash is recorded as missing rather than as a failure: the payment
 * was accepted, and refusing the report over an unreadable receipt would
 * discard a certification that was genuinely paid for.
 */
export function settlementTxHash(settlement) {
  const candidate =
    settlement?.transaction ??
    settlement?.txHash ??
    settlement?.transactionHash ??
    settlement?.payer?.transaction ??
    null;
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : null;
}

/**
 * Build the paying client.
 *
 * `journal` is halflife's memory, used only for `recordRun`. It is required
 * rather than optional: a payment nobody wrote down is exactly the thing this
 * module promises not to do, so a client that could be constructed without
 * somewhere to write would be a way to lose that promise by accident.
 *
 * `payer` is injectable so the suite can sign with a fake. Its default is the
 * real x402 signer, built lazily, on the first payment.
 */
export function createPaidStressProofClient({
  env = process.env,
  config = resolvePaidConfig(env),
  journal,
  payer = null,
  fetch: fetchImpl = globalThis.fetch,
  clock = () => new Date().toISOString(),
  timeoutMs = HTTP_TIMEOUT_MS,
} = {}) {
  if (!journal || typeof journal.recordRun !== 'function') {
    throw new TypeError('createPaidStressProofClient requires a journal to record what it spends');
  }
  // Refused at construction, not at the first run. A deployment that cannot
  // pay should fail when it is wired up, where somebody is looking, rather
  // than at 3am inside a scheduled re-check.
  if (!config.ok) {
    throw new PaidRunUnavailableError(config.reason);
  }

  let cachedPayer = payer;
  const getPayer = async () => {
    if (!cachedPayer) cachedPayer = await createX402Payer(config);
    return cachedPayer;
  };

  /** One journal line, plus the structured fields an auditor can filter on. */
  const record = (line, extra) => journal.recordRun(line, { ...extra, at: clock() });

  /**
   * Record the failure, then throw. Always in that order: a throw that
   * happened before the write would be the silent failure this module exists
   * to avoid, and the write is cheap.
   */
  const failed = async (target, stage, detail, extra = {}) => {
    const at = clock();
    await record(
      `${target}: paid re-certification did not happen. It failed while ${stage}: ${detail}. ` +
        `Nothing was certified and nothing was revoked. This is halflife failing to buy a check, ` +
        `not a finding about the agent, and the agent's existing certificate is untouched and ` +
        `expires on its normal schedule.`,
      {
        target,
        event: 'payment-failed',
        stage,
        detail,
        network: config.network,
        payer: config.payerAddress,
        priceUsdc: config.priceUsdc,
        paid: false,
        txHash: null,
        ...extra,
      },
    );
    const error = new Error(`paid re-certification failed while ${stage}: ${detail}`);
    error.stage = stage;
    error.at = at;
    throw error;
  };

  const post = async (path, body, headers = {}) => {
    return fetchImpl(`${config.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  };

  const readJson = async (response) => {
    try {
      return await response.json();
    } catch {
      return null;
    }
  };

  return {
    payerAddress: config.payerAddress,
    network: config.network,
    priceUsdc: config.priceUsdc,

    async certify({ targetUrl, method = 'POST', sampleBody, authHeaders } = {}) {
      const target = targetUrl;

      // 1. Ask for a run. Free, and it commits nothing, which is why this is
      //    the step that happens before any money is discussed.
      const asked = await post('/runs', {
        targetUrl,
        method,
        sampleBody,
        authHeaders,
        payerAddress: config.payerAddress,
        // Standing consent is the whole reason an unattended re-check is
        // possible. The target's owner published one file naming this wallet;
        // StressProof re-reads it before every run.
        consentMode: 'standing',
      }).catch((error) => error);

      if (asked instanceof Error) {
        return failed(target, 'asking StressProof for a run', asked.message);
      }
      const askedBody = await readJson(asked);
      if (!asked.ok) {
        return failed(
          target,
          'asking StressProof for a run',
          `HTTP ${asked.status}: ${askedBody?.error ?? 'no reason given'}`,
        );
      }
      const runId = askedBody?.runId;
      if (typeof runId !== 'string' || runId.length === 0) {
        return failed(target, 'asking StressProof for a run', 'the reply carried no run id');
      }

      // 2. Ask what it costs. An unpaid start is expected to be refused, and
      //    the refusal is the bill.
      const challenged = await post(`/runs/${runId}/start`, {}).catch((error) => error);
      if (challenged instanceof Error) {
        return failed(target, 'asking StressProof for its payment terms', challenged.message, { runId });
      }

      if (challenged.status !== 402) {
        // A 200 here would mean the run happened without being paid for. That
        // is not a windfall, it is a sign the upstream is not the paid service
        // halflife thinks it is, and accepting it would mean halflife's paid
        // product quietly runs on somebody's free tier.
        const body = await readJson(challenged);
        return failed(
          target,
          'asking StressProof for its payment terms',
          challenged.ok
            ? `it answered HTTP ${challenged.status} without asking to be paid, so this is not the paid route halflife was configured against`
            : `HTTP ${challenged.status}: ${body?.error ?? 'no reason given'}`,
          { runId },
        );
      }

      const challenge = await readJson(challenged);
      if (!challenge) {
        return failed(target, 'reading the payment challenge', 'the 402 carried no readable body', { runId });
      }

      // 3. Decide whether this is a bill halflife agreed to pay, BEFORE
      //    anything is signed. Amount, token, network and recipient all have
      //    to match what this deployment was configured for.
      const chosen = chooseAcceptableRequirement(challenge, config);
      if (!chosen.ok) {
        return failed(target, 'checking the bill against what halflife agreed to pay', chosen.reason, { runId });
      }

      let paymentHeader;
      try {
        paymentHeader = await (await getPayer()).signPaymentHeader(challenge);
      } catch (error) {
        return failed(target, 'signing the payment', error.message, { runId });
      }

      // 4. Pay and run. From here a failure may mean money moved and no report
      //    came back, which is why the journal line for this stage says so
      //    rather than implying nothing was spent.
      const paid = await post(`/runs/${runId}/start`, {}, { 'payment-signature': paymentHeader }).catch(
        (error) => error,
      );
      if (paid instanceof Error) {
        return failed(
          target,
          'starting the paid run',
          `${paid.message}. The payment was sent, so check the wallet before retrying: a settled payment with no report is possible here`,
          { runId, mayHaveSpent: true },
        );
      }

      const settlement = decodeSettlement(
        paid.headers?.get?.('payment-response') ?? paid.headers?.get?.('x-payment-response'),
      );
      const txHash = settlementTxHash(settlement);

      if (!paid.ok) {
        const body = await readJson(paid);
        return failed(
          target,
          'starting the paid run',
          `HTTP ${paid.status}: ${body?.error ?? 'no reason given'}`,
          { runId, txHash, mayHaveSpent: true },
        );
      }

      const report = await readJson(paid);
      if (!report) {
        return failed(target, 'reading the report', 'the reply was not readable JSON', {
          runId,
          txHash,
          mayHaveSpent: true,
        });
      }

      // The money line. Written before the report is handed back, so a caller
      // that crashes on the report still leaves a record of what was spent.
      const amount = formatUsdc(chosen.requirement.maxAmountRequired);
      await record(
        `${target}: paid ${amount} USDC on ${config.networkLabel} to ${chosen.requirement.payTo} for one StressProof ` +
          `re-certification (run ${runId}). ` +
          (txHash
            ? `Transaction ${txHash}, checkable on chain by anyone holding this line.`
            : `StressProof returned no transaction hash with the report, so the payment cannot be pointed at from here. ` +
              `The run was paid for, because it would not have started otherwise.`),
        {
          target,
          event: 'payment-settled',
          runId,
          paid: true,
          amountUsdc: amount,
          asset: chosen.requirement.asset,
          payTo: chosen.requirement.payTo,
          payer: config.payerAddress,
          network: config.network,
          networkName: config.networkName,
          facilitator: config.facilitatorUrl,
          txHash,
          reportId: typeof report.id === 'string' ? report.id : null,
        },
      );

      return report;
    },
  };
}
