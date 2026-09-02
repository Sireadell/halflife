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
| Write | `recordRun()` | events, the journal |
| Read | `recallCertification()` | entities |
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

**17 tests passing.** Counted, not estimated. Run `npm test`.

Not built yet: the certifier that calls StressProof, the HTTP surface, the
public page, and both partner integrations. Nothing in this README describes
something that does not exist, and it stays that way as the build goes.

The revocation rule is built and tested. It is in
[`src/lib/drift.js`](src/lib/drift.js) and it is pure, so a revocation can be
argued with rather than taken on faith. Revocation follows the verdict, not the
raw score: agents are allowed to vary between runs, and a run that could not
measure enough never revokes anything.

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
