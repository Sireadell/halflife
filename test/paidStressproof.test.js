// Paid re-certification tests.
//
// Nothing here touches a network, a wallet, a key or a chain. The facilitator,
// StressProof and the signer are all fakes, and that is not only for speed: the
// one thing this module must never do is spend real money because a test ran.
//
// What is being defended, test by test:
//   - a bill halflife did not agree to is never signed
//   - a failed payment produces no certification result at all
//   - a failed payment is still written to the journal, and is never worded as
//     a finding about the agent
//   - money that was spent is findable afterwards by its transaction hash

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createPaidStressProofClient,
  decodeSettlement,
  settlementTxHash,
} from '../src/lib/paidStressproof.js';
import {
  resolvePaidConfig,
  chooseAcceptableRequirement,
  toAtomicUsdc,
  formatUsdc,
  PaidRunUnavailableError,
} from '../src/lib/x402Payment.js';
import { Certifier } from '../src/lib/certifier.js';
import { DRIFT, CERTIFICATE } from '../src/lib/drift.js';

const TARGET = 'https://agent.example/v1/chat';
const PAYER = '0x1111111111111111111111111111111111111111';
const PAYEE = '0x2222222222222222222222222222222222222222';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/**
 * A complete paid environment. The private key here is a literal placeholder
 * string, not a key: nothing in this suite ever signs with it, because the
 * signer is faked. No real key belongs in this file or any other file in this
 * repository.
 */
const ENV = Object.freeze({
  HALFLIFE_STRESSPROOF_URL: 'https://stressproof.example',
  HALFLIFE_PAYER_ADDRESS: PAYER,
  HALFLIFE_PAYER_PRIVATE_KEY: 'not-a-real-key-tests-never-sign-with-this',
  HALFLIFE_PAYMENT_NETWORK: 'base',
  HALFLIFE_X402_FACILITATOR: 'https://facilitator.example',
});

/** A journal that records into an array instead of into Sibyl. */
function fakeJournal() {
  const lines = [];
  return {
    lines,
    async recordRun(line, extra) {
      lines.push({ line, extra });
    },
  };
}

const fakePayer = () => ({
  address: PAYER,
  async signPaymentHeader() {
    return 'fake-signed-payment-header';
  },
});

function challengeBody({ amount = '250000', network = 'eip155:8453', asset = USDC_BASE, extra } = {}) {
  return {
    x402Version: 2,
    accepts: [
      {
        scheme: 'exact',
        network,
        asset,
        payTo: PAYEE,
        maxAmountRequired: amount,
        extra: extra === undefined ? { name: 'USD Coin', version: '2' } : extra,
      },
    ],
  };
}

const REPORT = {
  id: 'report-1',
  report: { target: TARGET, verdict: 'RESILIENT', score: 91, silentWrongCount: 0, probesCompleted: 9, specVersion: 'sp1-abc' },
  certificate: { reportHash: '0xfeed' },
};

function response({ status = 200, body = {}, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    async json() {
      return body;
    },
  };
}

const settlementHeader = (payload) => Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');

/**
 * A StressProof that answers the four calls in order. Each entry is either a
 * response or an Error to throw, so a network failure is expressed the same way
 * the real client would meet one.
 */
function fakeUpstream(...replies) {
  const calls = [];
  return {
    calls,
    async fetch(url, options) {
      calls.push({ url, options });
      const reply = replies.shift();
      if (reply === undefined) throw new Error('fake StressProof ran out of replies');
      if (reply instanceof Error) throw reply;
      return reply;
    },
  };
}

const happyPath = (headers = {}) =>
  fakeUpstream(
    response({ status: 201, body: { ok: true, runId: 'run-42', consentMode: 'standing' } }),
    response({ status: 402, body: challengeBody() }),
    response({ status: 200, body: REPORT, headers }),
  );

// --- configuration ----------------------------------------------------------

test('a missing setting refuses by name and says why it does not fall back', () => {
  for (const name of Object.keys(ENV)) {
    const env = { ...ENV };
    delete env[name];
    const config = resolvePaidConfig(env);
    assert.equal(config.ok, false, `${name} should have been required`);
    assert.ok(config.missing.includes(name), `${name} should be named in the refusal`);
    assert.match(config.reason, /free demo/);
  }
});

test('a complete environment resolves, and the ceiling defaults to the price', () => {
  const config = resolvePaidConfig(ENV);
  assert.equal(config.ok, true, config.reason);
  assert.equal(config.network, 'eip155:8453');
  assert.equal(config.payerAddress, PAYER.toLowerCase());
  assert.equal(config.priceUsdc, '0.25');
  assert.equal(config.maxAtomic, 250000n);
});

test('an unknown network is refused rather than guessed at', () => {
  const config = resolvePaidConfig({ ...ENV, HALFLIFE_PAYMENT_NETWORK: 'ethereum' });
  assert.equal(config.ok, false);
  assert.match(config.reason, /ethereum/);
});

test('the client refuses to be built at all on incomplete config', () => {
  const env = { ...ENV };
  delete env.HALFLIFE_PAYER_PRIVATE_KEY;
  assert.throws(
    () => createPaidStressProofClient({ env, journal: fakeJournal(), payer: fakePayer() }),
    PaidRunUnavailableError,
  );
});

test('the client refuses to be built without somewhere to record what it spends', () => {
  assert.throws(() => createPaidStressProofClient({ env: ENV, payer: fakePayer() }), TypeError);
});

test('USDC amounts convert both ways without floating point anywhere near them', () => {
  assert.equal(toAtomicUsdc('0.25'), 250000n);
  assert.equal(toAtomicUsdc('1'), 1000000n);
  assert.equal(formatUsdc(250000n), '0.25');
  assert.equal(formatUsdc(1000000n), '1');
  assert.throws(() => toAtomicUsdc('0.1234567'), PaidRunUnavailableError);
});

// --- deciding what to pay ---------------------------------------------------

test('a bill above the ceiling is refused before anything is signed', () => {
  const config = resolvePaidConfig(ENV);
  const chosen = chooseAcceptableRequirement(challengeBody({ amount: '5000000' }), config);
  assert.equal(chosen.ok, false);
  assert.match(chosen.reason, /ceiling/);
});

test('a bill on the wrong chain is refused even when the amount is right', () => {
  const config = resolvePaidConfig(ENV);
  const chosen = chooseAcceptableRequirement(challengeBody({ network: 'eip155:84532' }), config);
  assert.equal(chosen.ok, false);
  assert.match(chosen.reason, /Base mainnet/);
});

test('a bill in some other token is refused', () => {
  const config = resolvePaidConfig(ENV);
  const chosen = chooseAcceptableRequirement(
    challengeBody({ asset: '0x9999999999999999999999999999999999999999' }),
    config,
  );
  assert.equal(chosen.ok, false);
  assert.match(chosen.reason, /USDC/);
});

test('a bill with no EIP-712 domain is refused rather than failing inside a library', () => {
  const config = resolvePaidConfig(ENV);
  const chosen = chooseAcceptableRequirement(challengeBody({ extra: null }), config);
  assert.equal(chosen.ok, false);
  assert.match(chosen.reason, /EIP-712/);
});

test('an empty challenge is refused', () => {
  const config = resolvePaidConfig(ENV);
  assert.equal(chooseAcceptableRequirement({ accepts: [] }, config).ok, false);
  assert.equal(chooseAcceptableRequirement(null, config).ok, false);
});

// --- the happy path ---------------------------------------------------------

test('a paid run asks for standing consent, pays, and returns the report', async () => {
  const journal = fakeJournal();
  const upstream = happyPath({ 'payment-response': settlementHeader({ success: true, transaction: '0xabc123' }) });
  const client = createPaidStressProofClient({
    env: ENV,
    journal,
    payer: fakePayer(),
    fetch: upstream.fetch,
  });

  const report = await client.certify({ targetUrl: TARGET, sampleBody: { query: 'hi' } });
  assert.deepEqual(report, REPORT);

  const asked = JSON.parse(upstream.calls[0].options.body);
  assert.equal(asked.consentMode, 'standing');
  assert.equal(asked.payerAddress, PAYER.toLowerCase());

  // The unpaid probe carries no payment header, and the paid call does.
  assert.equal(upstream.calls[1].options.headers['payment-signature'], undefined);
  assert.equal(upstream.calls[2].options.headers['payment-signature'], 'fake-signed-payment-header');
});

test('the transaction hash is written to the journal so it can be checked on chain later', async () => {
  const journal = fakeJournal();
  const client = createPaidStressProofClient({
    env: ENV,
    journal,
    payer: fakePayer(),
    fetch: happyPath({ 'payment-response': settlementHeader({ success: true, transaction: '0xabc123' }) }).fetch,
  });

  await client.certify({ targetUrl: TARGET, sampleBody: { query: 'hi' } });

  assert.equal(journal.lines.length, 1);
  const [{ line, extra }] = journal.lines;
  assert.match(line, /paid 0\.25 USDC/);
  assert.match(line, /0xabc123/);
  assert.equal(extra.event, 'payment-settled');
  assert.equal(extra.paid, true);
  assert.equal(extra.txHash, '0xabc123');
  assert.equal(extra.amountUsdc, '0.25');
  assert.equal(extra.payTo, PAYEE);
  assert.equal(extra.network, 'eip155:8453');
  assert.equal(extra.reportId, 'report-1');
});

test('a settled payment with no readable receipt still yields the report and says the hash is missing', async () => {
  // The payment was accepted, or the run would not have started. Throwing away
  // a certification that was genuinely paid for because the receipt was
  // unreadable would waste money to gain nothing.
  const journal = fakeJournal();
  const client = createPaidStressProofClient({
    env: ENV,
    journal,
    payer: fakePayer(),
    fetch: happyPath().fetch,
  });

  const report = await client.certify({ targetUrl: TARGET, sampleBody: { query: 'hi' } });
  assert.deepEqual(report, REPORT);
  assert.equal(journal.lines[0].extra.txHash, null);
  assert.match(journal.lines[0].line, /no transaction hash/);
});

test('settlement receipts are decoded, and an unreadable one is null rather than a crash', () => {
  const decoded = decodeSettlement(settlementHeader({ transaction: '0xdead' }));
  assert.equal(settlementTxHash(decoded), '0xdead');
  assert.equal(decodeSettlement('not base64 json at all !!'), null);
  assert.equal(decodeSettlement(null), null);
  assert.equal(settlementTxHash(null), null);
});

// --- failure --------------------------------------------------------------

async function expectFailure(replies, { payer = fakePayer() } = {}) {
  const journal = fakeJournal();
  const client = createPaidStressProofClient({
    env: ENV,
    journal,
    payer,
    fetch: fakeUpstream(...replies).fetch,
  });
  await assert.rejects(() => client.certify({ targetUrl: TARGET, sampleBody: { query: 'hi' } }));
  return journal;
}

test('an unreachable StressProof produces no result and one journal line', async () => {
  const journal = await expectFailure([new Error('connect ECONNREFUSED')]);
  assert.equal(journal.lines.length, 1);
  assert.equal(journal.lines[0].extra.event, 'payment-failed');
  assert.equal(journal.lines[0].extra.paid, false);
});

test('a failed attempt is never worded as a finding about the agent', async () => {
  const journal = await expectFailure([new Error('connect ECONNREFUSED')]);
  const { line } = journal.lines[0];
  assert.match(line, /not a finding about the agent/);
  assert.match(line, /nothing was revoked/);
  assert.match(line, /certificate is untouched/);
  // No verdict word may appear at all. A journal line that named a band would
  // read as a measurement, and nothing was measured.
  assert.doesNotMatch(line, /RESILIENT|PARTIAL|BRITTLE|INCONCLUSIVE/);
});

test('a refused consent file stops the run before any money is discussed', async () => {
  const journal = await expectFailure([
    response({ status: 400, body: { error: 'this target was certified recently' } }),
  ]);
  assert.match(journal.lines[0].line, /asking StressProof for a run/);
  assert.match(journal.lines[0].extra.detail, /certified recently/);
});

test('an upstream that does not ask to be paid is refused, not accepted as a free run', async () => {
  // A 200 here means halflife is pointed at something other than the paid
  // route. Taking the free result would turn a paid product into a
  // rate-limited toy while every log line still said it worked.
  const journal = await expectFailure([
    response({ status: 201, body: { runId: 'run-42' } }),
    response({ status: 200, body: REPORT }),
  ]);
  assert.match(journal.lines[0].extra.detail, /without asking to be paid/);
});

test('a bill halflife did not agree to is journalled and never signed', async () => {
  let signed = false;
  const journal = await expectFailure(
    [
      response({ status: 201, body: { runId: 'run-42' } }),
      response({ status: 402, body: challengeBody({ amount: '99000000' }) }),
    ],
    {
      payer: {
        address: PAYER,
        async signPaymentHeader() {
          signed = true;
          return 'should-never-happen';
        },
      },
    },
  );
  assert.equal(signed, false, 'nothing may be signed once the bill is refused');
  assert.match(journal.lines[0].extra.detail, /ceiling/);
});

test('a payment the upstream rejects produces no report and warns that money may have moved', async () => {
  const journal = await expectFailure([
    response({ status: 201, body: { runId: 'run-42' } }),
    response({ status: 402, body: challengeBody() }),
    response({ status: 403, body: { error: 'the wallet that paid is not the wallet that proved control' } }),
  ]);
  assert.equal(journal.lines[0].extra.mayHaveSpent, true);
  assert.match(journal.lines[0].extra.detail, /proved control/);
});

test('a signing failure is recorded and no request is sent with a broken header', async () => {
  const journal = await expectFailure(
    [response({ status: 201, body: { runId: 'run-42' } }), response({ status: 402, body: challengeBody() })],
    {
      payer: {
        address: PAYER,
        async signPaymentHeader() {
          throw new Error('the key is not for this wallet');
        },
      },
    },
  );
  assert.match(journal.lines[0].extra.stage, /signing the payment/);
});

// --- how the certifier sees a payment failure -------------------------------

test('a failed payment reaches the certifier as an unmeasurable run, never a revocation', async () => {
  // The point of the whole design: halflife being unable to pay must not
  // damage an agent that did nothing. The certifier already handles an
  // upstream it cannot reach, and a paid client that throws lands in exactly
  // that path.
  const journal = fakeJournal();
  const paid = createPaidStressProofClient({
    env: ENV,
    journal,
    payer: fakePayer(),
    fetch: fakeUpstream(new Error('facilitator unreachable')).fetch,
  });

  const remembered = {
    target: TARGET,
    verdict: 'RESILIENT',
    specVersion: 'sp1-abc',
    score: 91,
    certificateStatus: CERTIFICATE.VALID,
    certifiedAt: new Date().toISOString(),
    qualifiedForRiskLevel: 'LOW',
  };

  const written = [];
  const memory = {
    async recallCertification() {
      return remembered;
    },
    async recallRiskLevel() {
      return null;
    },
    async rememberCertification(target, record) {
      written.push(record);
    },
    async recordRun(line, extra) {
      journal.lines.push({ line, extra });
    },
  };

  const certifier = new Certifier({ memory, stressproof: paid });
  const result = await certifier.certify(TARGET, { sampleBody: { query: 'hi' } });

  assert.equal(result.measured, false);
  assert.equal(result.revoked, false);
  assert.equal(result.drift, DRIFT.UNVERIFIABLE);
  assert.equal(result.certificateStatus, CERTIFICATE.VALID);
  // The remembered verdict survives untouched, so a later real drop is still
  // seen as a drop rather than laundered into a fresh certificate.
  assert.equal(written[0].verdict, 'RESILIENT');
  assert.equal(written[0].certifiedAt, remembered.certifiedAt);

  // Two lines: the payment failure from the paid client, and the certifier's
  // own record of a check that did not land.
  assert.ok(journal.lines.some((l) => l.extra?.event === 'payment-failed'));
  assert.ok(journal.lines.some((l) => /could not be checked/.test(l.line)));
});
