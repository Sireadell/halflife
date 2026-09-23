# Handoff: Halflife (Sibyl Labs hackathon entry)

## Current handoff, 2026-09-23

### Arc Microgrants submission state

Halflife is the active Arc Microgrants project. The official deadline is
2026-10-14 23:59 ET. The public repo is
`https://github.com/Sireadell/halflife` and the live judge entry point is
`https://halflife-b0o4.onrender.com/judge.html`.

The official submission portal is
`https://dorahacks.io/hackathon/arc-microgrants`. It requires a working Arc
mainnet deployment, public repository, short project description and public
builder profile. The project meets the deployment and repository requirements.
It still needs the founder to sign into DoraHacks, review the form, and confirm
the final external submission action.

`SUBMISSION_CHECKLIST.md` is the current source of truth for submission tasks.
It records two remaining items:

- A new paid Arc mainnet run that creates ERC-8004 feedback on-chain. This is
  strongly recommended proof for judges but requires an approved real payment.
- The DoraHacks form submission.

### ERC-8004 Arc work completed

Commits `58b9abc` and `3c186cf` are pushed to `master`. The live Render
deployment was checked after the push: `/health` and `/about` return 200, and
the live `judge.html` and `judge-pay.js` include the ERC-8004 proof UI.

Implemented:

- `src/lib/erc8004.js` uses Arc's canonical ERC-8004 Identity and Reputation
  registries and verifies them before writing.
- The existing Arc memo proof remains unchanged. Measured issue and revoke
  results now also write ERC-8004 feedback.
- A revoke calls `revokeFeedback()` for the prior feedback before writing the
  lower replacement feedback.
- Unmeasured results, missing report hashes and unchanged certificates make no
  ERC-8004 write.
- Registry failures are returned honestly without crashing certification.
- Agent records, paid result JSON and the judge page surface ERC-8004 details.

Verification completed: `npm run build:judge`, `npm test` with 156/156 passing,
`git diff --check`, no-em-dash scan, and live read-only Arc RPC registry checks.
No new paid ERC-8004 transaction has been sent.

### Current judge-page UX

The live page was reviewed at a 390 by 844 mobile size. It has no horizontal
overflow and clearly explains the issue then revoke story. The one small UX
fix worth making before final submission is to show the exact Arc USDC price
beside the `Pay and run live check` action, plus one sentence saying what the
payment triggers. The live `/about` endpoint currently reports the visitor
price as 0.01 USDC.

### Proposed next build, not yet started

The founder wants a visitor to experience a certificate being issued and then
revoked in one live guided demonstration. Do not fake a result or reuse a
global mutable demo state.

Recommended design:

- One clearly priced payment covers two real checks.
- The first check uses a controlled Halflife demonstration agent in its passing
  state and writes the certificate plus ERC-8004 feedback.
- The visitor then chooses a plainly labelled controlled failure step.
- The same agent is rechecked in its planned failing state, causing real
  ERC-8004 feedback revocation and a new lower feedback record.
- The page shows the transaction links and a live issue-to-revoke timeline.
- Isolate each visitor through a leased, pre-registered pool of demo agent
  identities. This avoids two visitors revoking one another's records.

The guided demo is a meaningful build. It needs session handling, controlled
demo-agent modes, a two-run payment route, identity leasing, progress states,
and tests. It has not been implemented or approved for spending yet.

Last updated 2026-09-02. Read this first, then README.md.

## Open TODO (added 2026-09-10, not yet actioned)

- Add a cronjob. Not yet clarified whether this means an external scheduled
  trigger for the sweep (`src/lib/sweep.js`, currently runs on an in-process
  timer only, so it resets on every restart) or something else. Confirm scope
  before building.

## What this is

Halflife is a certification for AI agents that expires. It does not run tests
itself. It calls StressProof, remembers the verdict, compares it with last
time, and revokes the certificate if the agent got worse.

Two repos, both public, both on branch `master`, both pushed:

- `C:\Users\DELL\halflife` (this one) https://github.com/Sireadell/halflife
- `C:\Users\DELL\stressproof` https://github.com/Sireadell/stressproof

Tests: Halflife 110 passing, StressProof 264 passing. Run `npm test` in each.

## Built and committed

- Memory layer (`src/lib/memory.js`), Sibyl Memory via a Python bridge.
- Revocation rule (`src/lib/drift.js`), pure, band-based.
- Certifier (`src/lib/certifier.js`), ties the above together.
- Risk levels (`src/lib/risk.js`): LOW 30 days at PARTIAL, HIGH 7 days at
  RESILIENT, CRITICAL 1 day at RESILIENT.
- Paying client (`src/lib/paidStressproof.js`, `src/lib/x402Payment.js`),
  0.25 USDC on Base over x402.
- StressProof: spec version stamped on every report, plus standing consent.

## Decisions already made, do not relitigate

1. **Revocation follows the verdict band, never the raw score.** Agents vary
   between runs. A score threshold would need an invented noise number and
   would produce false accusations.
2. **Risk levels change only two things**: how often an agent is re-checked,
   and the minimum band it must hold. No score thresholds anywhere.
3. **Five outcomes, not two**: valid, stale, revoked, never_qualified,
   not_certified. Stale is halflife's failure, not the agent's. Never
   qualified means nothing was ever issued, so nothing was taken away. Only
   `revoked` is an accusation.
4. **Never compare results from different test versions.** Refuse and start
   fresh, flagged. A revoked certificate is not reinstated by a version change.
5. **Standing consent, five fields**, re-read live before every run: standing
   marker, agent address, paying wallet, expiry date, owner's max frequency.
   30 day ceiling enforced regardless of the file. Owner frequency and
   StressProof's 15 minute cooldown both apply, stricter wins.
6. **A failed payment**: no result, revokes nothing, certificate untouched and
   goes stale on its normal clock, but the attempt IS journalled.
7. **No role-specific test packs.** Deliberately not built, do not claim them.

## Next item: deploy StressProof to a public URL

This is the bottleneck. The Base payment cannot settle until StressProof is
reachable, and `docs/PARTNERS.md` puts Virtuals after Base works.

`render.yaml` is written and correct. Blocked on the owner because there is no
Render API key or CLI on this machine. Render will prompt for:

| Variable | What | Note |
|---|---|---|
| `STRESSPROOF_PAY_TO` | wallet receiving 0.25 USDC | public address |
| `STRESSPROOF_SIGNER_PRIVATE_KEY` | signs certificates | owner must enter this personally |
| `GROQ_API_KEY` | optional summaries | can be skipped |

Missing `STRESSPROOF_PAY_TO` makes paid runs refuse, not become free. Missing
the signer key makes reports unsigned, not falsely signed.

## After that

1. Real Base payment. Only after the owner inspects wallet, amount, recipient,
   network and expected fee by hand. Nothing signed before that.
2. Virtuals ACP. The job handler is built and tested against fake jobs and is
   reachable at `POST /acp/jobs`. The live registration is not done, and
   `@virtuals-protocol/acp-node` is not in `package.json`, so the adapter
   reports itself off at boot. Registering is still outstanding.
3. Public web page. Built, `public/index.html`, served at `/` by the existing
   static middleware.

Also since built: the HTTP surface (`src/expressApp.js`), the registry
(`src/lib/registry.js`), the sweeper (`src/lib/sweep.js`), and `render.yaml`
for halflife. The Render file has never been run on Render, and its two open
questions are written into its own header: whether python3 exists in Render's
Node image, and that a persistent disk is required or the entire registry is
destroyed on every restart.

## Known weak points, stated not hidden

- The x402 signing function has never run. It cannot be tested without a real
  key. Everything around it is tested.
- Standing consent grants up to 30 days where the one-time code granted 15
  minutes. Anyone who can write files at that origin inherits it.
- Any agent certified before version stamping gets one free "test changed"
  reset on its next check.
- StressProof's per-target cooldown lives in memory, so a restart clears it.

## House rules

No em dashes anywhere. Comments say why, not what. The README forbids
describing anything that does not exist, and that rule holds.
