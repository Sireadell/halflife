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

Halflife pays StressProof in USDC on Base for every re-certification, and
registers on Virtuals' Agent Commerce Protocol so other agents can hire it.
Both are required parts of the build, not optional extras, and both must be
seen working rather than merely claimed. See
[`docs/PARTNERS.md`](docs/PARTNERS.md) for what each one has to demonstrate
before it counts as done.

The payment is not decoration. Halflife certifies nothing itself, it buys
certification from another service, so one agent paying another is the honest
shape of the product rather than something added on top of it.

## Status

Early. The memory layer works and is tested, including the cold-start case: a
brand new process recalls what an earlier process wrote. That test is in
[`test/memory.test.js`](test/memory.test.js) and it is the one test this
project cannot survive failing.

**55 tests passing.** Counted, not estimated. Run `npm test`.

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

Today the certifier calls StressProof's free demo route. The paid route needs a
consent file published at the target's origin and a settled x402 payment, and
neither exists yet, so no client for it is claimed.

Not built yet: the HTTP surface, the public page, and both partner integrations.
Nothing in this README describes something that does not exist, and it stays
that way as the build goes.

The revocation rule is built and tested. It is in
[`src/lib/drift.js`](src/lib/drift.js) and it is pure, so a revocation can be
argued with rather than taken on faith. Revocation follows the verdict, not the
raw score: agents are allowed to vary between runs, and a run that could not
measure enough never revokes anything.

Risk levels are built and tested too, in [`src/lib/risk.js`](src/lib/risk.js).
They add the expiry clock and the minimum band an agent has to hold, layered on
top of the drift comparison rather than replacing it. What they do not add is a
different test per role, and no such test packs are planned. See below.

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
```

## Prior work

The certification engine halflife calls is StressProof, which I built earlier
and which is its own separate project and repository. Halflife is new: the
memory layer, the drift comparison and the revocation rule are written here and
do not exist in StressProof, which has no persistence of any kind and forgets
every report when it restarts.

## Licence

Apache-2.0. See [LICENSE](LICENSE).
