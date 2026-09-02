# Halflife

**A certification that expires.**

Halflife remembers every agent it has certified. When it sees one again it says
what changed, and if the agent got worse it revokes the certificate it issued.

A certificate that was true last Tuesday and has never been checked since is
not evidence of anything. Halflife exists because agents change: a model gets
swapped, a prompt gets edited, a rate limit gets added, and the agent that
passed a resilience test in September quietly stops passing it in October while
its certificate still says otherwise.

## Where memory is load-bearing

All of it. Halflife stores nothing else and computes nothing else.

Certification itself is not done here. Halflife calls
[StressProof](https://github.com/Sireadell/stressproof), a separate service, to
run the actual probes and produce a verdict. What halflife adds is the part
StressProof cannot do: remembering the last verdict, comparing it with this
one, and deciding whether a certificate still holds.

Remove the memory layer and there is no previous verdict, so there is no
comparison, no drift, no revocation, no history and no registry. What remains
is an empty wrapper that forwards a request to somebody else's API. That is not
a degraded halflife. There is no halflife.

**Every memory read and write lives in one file:
[`src/lib/memory.js`](src/lib/memory.js).**

| | Function | Sibyl tier |
|---|---|---|
| Write | `rememberCertification()` | entities, one record per agent |
| Write | `rememberRiskLevel()` | entities, one record per agent |
| Write | `recordRun()` | events, the journal |
| Read | `recallCertification()` | entities |
| Read | `recallRiskLevel()` | entities |
| Read | `readRunHistory()` | events |
| Read | `searchRegistry()` | entity search |

The transport between Node and Sibyl's Python library is
[`memory/bridge.py`](memory/bridge.py), which is deliberately dumb: it knows
nothing about certificates or revocation and only forwards named calls.

Two tiers, two jobs. The entity record is overwritten on every run and always
holds the current standing. The journal is append-only and never rewritten, so
the history survives even though the standing record does not.

## When memory fails, halflife fails loudly

`src/lib/memory.js` throws rather than returning a default. This is deliberate.
Halflife with an unreachable memory cannot honestly say "nothing has changed"
about an agent it is unable to remember. Reporting a reassuring answer it has
no basis for is the exact silent failure the certification is meant to catch,
and it would be indefensible for this project of all projects to do it.

One distinction is handled carefully for the same reason: Sibyl raises an error
for an entity that does not exist, which at the transport layer looks identical
to a broken memory. `memory/bridge.py` catches that one case specifically and
turns it into a successful empty answer, so halflife can always tell "I have
never seen this agent" apart from "I cannot remember anything right now".

## Partner integrations

Halflife is built to pay StressProof in USDC on Base for every
re-certification, and to register on Virtuals' Agent Commerce Protocol so other
agents can hire it. Both are required parts of the build, not optional extras,
and both must be seen working rather than merely claimed. Neither has been seen
working yet: no payment has settled and no live ACP registration exists. See
[`docs/PARTNERS.md`](docs/PARTNERS.md) for what each one has to demonstrate
before it counts as done, and the status section below for exactly how far each
one got.

The payment is not decoration. Halflife certifies nothing itself, it buys
certification from another service, so one agent paying another is the honest
shape of the product rather than something added on top of it.

## Paying for a re-certification

The paying client is built and tested. It lives in
[`src/lib/paidStressproof.js`](src/lib/paidStressproof.js) and is an
alternative to the free client, passed into the certifier as `stressproof`.
The certifier itself did not change: the dependency was always injected for
exactly this.

The flow is four calls, and it is four rather than one on purpose:

1. Ask StressProof for a run, with standing consent. Free, commits nothing.
2. Try to start it with no payment. The 402 refusal is the bill.
3. Check the bill against what this deployment agreed to pay, then sign it.
4. Start the run with the payment attached, and read the report back.

Step 3 is the one worth spelling out. The bill is written by the other side, so
the amount, the token, the network and the recipient are all checked against
configuration before anything is signed. An upstream that was repriced,
misconfigured or compromised cannot drain the wallet one re-certification at a
time, because a bill halflife did not agree to is refused and journalled
instead of paid.

**A failed payment never produces a certification result and never revokes
anything.** It throws, which the certifier already treats as an upstream it
could not reach: the run is unmeasurable, the remembered verdict is left
exactly as it was, and the certificate keeps standing until its normal expiry
arrives and it goes stale through the ordinary staleness path. There is no
special early-expiry state for a payment problem, because halflife being unable
to pay is halflife's failure and says nothing at all about the agent.

**A failed payment is still written to the journal**, with what failed and
when, worded so that nobody reads it as a finding about the agent. Refusing
quietly would make "we tried and could not pay" look identical to "nobody ever
tried", and an invisible failure is the exact thing this project exists to
catch.

**Money that was spent is findable afterwards.** The journal line for a settled
payment carries the amount, the network, who was paid, and the transaction hash
as soon as one exists, so anyone auditing a re-certification can check the
transaction on Base without taking halflife's word for it. When StressProof
returns no readable receipt the line says the hash is missing rather than
implying one exists.

### Configuration

Every one of these is required, and none of them has a default. If any is
missing, halflife refuses to attempt a paid run rather than falling back to
StressProof's free demo route, because a rate-limited demo answering in place
of a paid run would look exactly like success.

| Variable | What it is |
|---|---|
| `HALFLIFE_STRESSPROOF_URL` | Base URL of the StressProof deployment to buy from |
| `HALFLIFE_PAYER_ADDRESS` | The wallet that pays, and the wallet named in the target's consent file |
| `HALFLIFE_PAYER_PRIVATE_KEY` | The key for that wallet. Secret. Read from the environment only, never written to a file in this repository, never logged and never journalled |
| `HALFLIFE_PAYMENT_NETWORK` | `base` or `base-sepolia` |
| `HALFLIFE_X402_FACILITATOR` | The facilitator that settles the payment. Recorded on the journal line so an auditor knows which one settled it. Halflife does not call it directly; StressProof does, as the party being paid |

One optional setting, `HALFLIFE_MAX_PAYMENT_USDC`, is the ceiling on a single
payment. It defaults to `0.25`, which is StressProof's published price. It has
a default because it is not a secret and because a missing ceiling is more
dangerous than a conservative one.

### What has not happened yet

**No real payment has settled.** Not one. The code is written and tested
against fakes for the facilitator, the chain, the signer and StressProof
itself, so the whole flow runs with no network, no wallet and no money. No
transaction hash is claimed here, and none will be until one exists.

The signing step is the one part of this that no test exercises: signing needs
a real key, and no key belongs in a test. It is loaded lazily and only when a
payment is actually being made, so the suite never even imports a signing
library.

What remains before a real payment can settle is listed in
[`docs/PARTNERS.md`](docs/PARTNERS.md): a StressProof deployment reachable at a
public URL, a funded wallet, and a target whose owner has published a standing
consent file naming that wallet.

## Status

Early. The memory layer works and is tested, including the cold-start case: a
brand new process recalls what an earlier process wrote. That test is in
[`test/memory.test.js`](test/memory.test.js) and it is the one test this
project cannot survive failing.

**110 tests passing.** Counted, not estimated. Run `npm test`.

The certifier is built and tested. It is in
[`src/lib/certifier.js`](src/lib/certifier.js) and it is the one operation
halflife performs: recall what memory holds for an agent, ask StressProof for a
fresh certification, compare the two, write the new standing, and append the run
to the journal in plain words. Both outside dependencies are injected, so the
whole flow is tested without a network and without a live StressProof.

A run that could not be completed is never treated as a verdict about the agent.
If StressProof is unreachable the comparison comes back unverifiable, the
previous certificate is left exactly as it was, and the failure is recorded as a
gap in checking. Halflife's own downtime cannot revoke anybody's certificate.
The remembered verdict is also left in place through a failed check, so an
outage cannot quietly turn a later drop into a fresh certificate.

The certifier's default client is still StressProof's free demo route, which is
what the tests run against. The paying client is built and tested beside it and
is described above. It has never sent a real payment, and the README says so
there rather than leaving a reader to assume otherwise.

The revocation rule is built and tested. It is in
[`src/lib/drift.js`](src/lib/drift.js) and it is pure, so a revocation can be
argued with rather than taken on faith. Revocation follows the verdict, not the
raw score: agents are allowed to vary between runs, and a run that could not
measure enough never revokes anything.

Risk levels are built and tested too, in [`src/lib/risk.js`](src/lib/risk.js).
They add the expiry clock and the minimum band an agent has to hold, layered on
top of the drift comparison rather than replacing it. What they do not add is a
different test per role, and no such test packs are planned. See below.

### Built, and tested

- **The HTTP surface** ([`src/expressApp.js`](src/expressApp.js)). Every route
  listed below, with three rules it holds to: an unreachable memory is a 503
  that says so rather than an empty answer, none of the five standings is ever
  collapsed into a boolean, and no route hands back the `standing` word that was
  written at check time.
- **The registry** ([`src/lib/registry.js`](src/lib/registry.js)). The read
  side. Staleness is recomputed from the stored evidence and the current time on
  every request.
- **The sweeper** ([`src/lib/sweep.js`](src/lib/sweep.js)). Re-checks whatever
  is past its risk level's period. Off unless a deployment sets an interval,
  because a background job that spends money should not start just because
  something was deployed.
- **ACP job handling** ([`src/lib/acp.js`](src/lib/acp.js)). Answers a standing
  question in the shape ACP asks it, and is reachable over plain HTTP at
  `POST /acp/jobs` with no wallet and no registration.
- **The public page** ([`public/index.html`](public/index.html)), served at `/`
  by the same app. The example certificate on it is hand-written and labelled as
  an example. The rest of its numbers are fetched from the running deployment.
- **A Render deployment file** ([`render.yaml`](render.yaml)), which has never
  been run on Render. It says so in its own header comment, along with what each
  missing variable does to the running service.

### Partly built: the Virtuals integration

**The job handler is built and tested. The live registration is not, and no
real job has ever arrived.**

What works and is covered by tests: everything the handler decides. Given a job,
it produces the deliverable a buyer would receive, including which of the five
standings applies, what that means for the buyer, and where to check the same
answer for themselves. Those tests run against fake jobs.

What has never happened: halflife has no registered agent profile on the ACP
network. `createAcpService()` in [`src/lib/acp.js`](src/lib/acp.js) has never
been run against the real service, no test exercises it, and
`@virtuals-protocol/acp-node` is not currently in `package.json`, so on a
deployment today it reports itself off rather than connecting. It is written to
refuse loudly by name if the SDK does not expose what it was written against,
because a loud refusal at boot is recoverable and a job silently accepted and
never delivered is a buyer paying for nothing.

`GET /about` says the same thing in its `acp` block, so this claim can be
checked from outside rather than only read here.

### Not built: a settled payment on Base

No real payment has settled. Not one. See the payment section above for what the
code does, what the tests cover, and what remains before a real payment can go
out.

Nothing in this README describes something that does not exist, and it stays
that way as the build goes.

## The HTTP surface

`npm start` boots it. Everything answers JSON except `/`, which is the page.

| Route | What it does |
|---|---|
| `GET /` | the public page |
| `GET /about` | what this deployment is and is not configured to do, probed rather than assumed |
| `GET /health` | is the process up |
| `POST /agents` | register an agent at a risk level. Does not certify it |
| `GET /agents` | the registry, every standing judged against the clock now |
| `GET /agents/:target` | one agent's standing, judged against the clock now |
| `GET /agents/:target/journal` | that agent's history, as written |
| `POST /agents/:target/certify` | run a check now |
| `GET /due` | whose certificate has run out of time |
| `POST /sweep` | re-check everything that has |
| `POST /acp/jobs` | answer a standing question in the shape ACP asks it |

`:target` is how halflife knows an agent, and it is usually a URL, so it is
percent-encoded in the path. `?target=` is accepted on the same routes for
callers that would rather not encode anything.

## Every environment variable this service reads

Taken from the source, not from memory. Nothing secret has a default anywhere in
this list, and a missing variable is always a named refusal rather than a
fallback.

| Variable | Read by | Missing means |
|---|---|---|
| `PORT` | `src/index.js` | listens on 3000 |
| `HALFLIFE_MEMORY_DB` | `src/lib/memory.js` | `./halflife-memory.db`. On a host with an ephemeral filesystem this loses every certificate on restart |
| `HALFLIFE_PYTHON` | `src/lib/memory.js` | `python`. If that is not on PATH the memory bridge cannot start and every route that needs memory answers 503 |
| `HALFLIFE_STRESSPROOF_URL` | `src/lib/certifier.js`, `src/lib/x402Payment.js` | the free client falls back to `http://localhost:3000`. Required with no default on the paid route |
| `HALFLIFE_PAID_RUNS` | `src/index.js` | free runs. `on`, `true` or `1` switches paid runs on by name. Deliberately opt-in: halflife will not start spending because the other variables happen to be present |
| `HALFLIFE_PAYER_ADDRESS` | `src/lib/x402Payment.js` | with paid runs on, the deployment comes up misconfigured and certify and sweep answer 503 |
| `HALFLIFE_PAYER_PRIVATE_KEY` | `src/lib/x402Payment.js` | same. Secret. Never logged, never journalled, never returned in any result |
| `HALFLIFE_PAYMENT_NETWORK` | `src/lib/x402Payment.js` | same. Must be `base` or `base-sepolia` |
| `HALFLIFE_X402_FACILITATOR` | `src/lib/x402Payment.js` | same. Recorded on the journal line so an auditor knows which facilitator settled a given payment |
| `HALFLIFE_MAX_PAYMENT_USDC` | `src/lib/x402Payment.js` | `0.25`. The ceiling on a single payment, separate from the price. It has a default because it is not a secret and a missing ceiling is more dangerous than a conservative one |
| `HALFLIFE_ACP_AGENT_WALLET_ADDRESS` | `src/lib/acp.js` | halflife is not hirable over the live ACP network and reports why at `/about`. The rest of the service runs unchanged and `POST /acp/jobs` still answers |
| `HALFLIFE_ACP_PRIVATE_KEY` | `src/lib/acp.js` | same. Secret |
| `HALFLIFE_ACP_ENTITY_ID` | `src/lib/acp.js` | same. Must be a whole positive number |
| `HALFLIFE_SWEEP_INTERVAL_MS` | `src/index.js` | no background sweep. Certificates still expire on read, but nothing re-checks them until `POST /sweep` is called |

The three states a deployment can be in for certification are `free`, `paid` and
`misconfigured`, and `/about` reports which. The state that must never happen is
a deployment that meant to buy its certifications, cannot, and quietly falls back
to StressProof's free demo route. A rate-limited demo answering in place of a
paid run looks exactly like success in every log line, so it is refused instead.

## Risk levels

An agent is registered at one of three risk levels, and the level decides two
things and nothing else: how often the agent must be re-checked before its
certificate stops meaning anything, and the lowest StressProof verdict it has to
hold to have a certificate at all.

| Level | Re-checked | Must hold |
|---|---|---|
| `LOW` | every 30 days | `PARTIAL` |
| `HIGH` | every 7 days | `RESILIENT` |
| `CRITICAL` | every day | `RESILIENT` |

There are no score thresholds anywhere in this. The bar is a verdict band, for
the same reason revocation follows the band: agents are allowed to vary between
runs, and any score cutoff would need an invented noise margin. The rule is in
[`src/lib/risk.js`](src/lib/risk.js) and it is pure, like the drift rule.

The probes do not change with the level. A payment agent is not given a
different test, it is held to a higher band and re-checked more often on the
same twelve probes. There are no role-specific test packs and none are planned.

An agent nobody registered is judged at `LOW`, the loosest, and certifying an
agent never registers one for it. Reporting an agent as failing a bar nobody
chose would be an accusation halflife has no grounds to make. Changing a level
later is appended to the journal with the level it moved from, and the checks
already recorded keep the level they were judged under.

## Three ways a certificate can fail, and they are not the same thing

- **Revoked.** The agent held its band and no longer does. This is a finding
  about the agent, and it is the only one of the three that is.
- **Never qualified.** The agent has never reached the band its risk level
  requires. Nothing valid was ever issued, so nothing has been taken away, and
  calling it a revocation would accuse an agent that has not changed at all.
- **Stale.** The last completed check is older than the risk level allows. This
  says halflife stopped knowing, not that the agent got worse. Failing to check
  on schedule is halflife's failure, and the wording, the stored record and the
  journal all keep it separate from a revocation.

## Never compare across two different tests

StressProof now stamps every report with the version of its frozen test spec,
derived from the probe list and every threshold, so a moved threshold changes
the stamp without anyone having to remember to bump it.

Halflife refuses to compare two results that did not come from the same version.
A verdict that fell because the test changed is not an agent that got worse, and
revoking on it would accuse an agent that did nothing. Such a run is recorded as
a fresh certification under the new version, flagged as one, with the earlier
result left in the journal alongside the version that produced it. Two things
that deliberately does not do: it does not hand back a certificate that was
already revoked, because standing only returns on a demonstrated improvement and
none can be demonstrated across a change of test; and a run that measured
nothing makes no version claim, so a StressProof outage never looks like a test
change.

## Running it

Requires Node 22+ and Python 3.10+.

```bash
npm install && pip install sibyl-memory-client && npm test
npm start   # serves the page and the routes on :3000
```

`npm start` comes up even when memory is unreachable. That is deliberate: a
service that exits cannot tell anybody why it is down, and the memory bridge is
a separate Python process that can come back without restarting this one. The
boot log says which of free, paid or misconfigured the certification route is,
whether memory answered a probe, whether the sweep is on, and whether ACP is
connected. `GET /about` says the same from outside.

Deploying it needs one more thing than running it locally does: somewhere for
the SQLite memory file to live that survives a restart.
[`render.yaml`](render.yaml) explains why, and what is lost without it.

## Prior work

The certification engine halflife calls is StressProof, which I built earlier
and which is its own separate project and repository. Halflife is new: the
memory layer, the drift comparison and the revocation rule are written here and
do not exist in StressProof, which has no persistence of any kind and forgets
every report when it restarts.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
