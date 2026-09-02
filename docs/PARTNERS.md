# Partner integrations: required, not optional

**Both partner integrations ship. This is a build requirement, decided
2026-09-02, and it is not traded away for schedule.**

If time runs short, other things get cut first. This does not.

## Why it is worth this much

Sibyl scores a submission as:

```
final = (rubric out of 100 + PMF bonus up to 10) x partner multiplier
```

The multiplier is x1.15 for one verified partner and reaches its x1.25 ceiling
with two. On a rubric score of 80 that is the difference between 80 and 100.
With five prize places, that gap decides whether an entry places at all.

The memory layer earns none of this. Memory is compulsory for every entrant, so
it never multiplies. Only the partner stacks do.

## What actually counts

Deploying on a partner's chain is only the eligibility floor. The rules are
explicit: the integration has to be **seen doing real work in the demo video**,
and an integration that is claimed but not exercised loses the bonus entirely.

So for each partner below there is an acceptance test, and the acceptance test
is "a judge watching the video sees this happen", not "the code exists".

## Partner 1: Base

**What halflife does:** pays StressProof for every re-certification. 0.25 USDC
on Base, per run, over x402.

This is not a payment bolted on to earn a multiplier. It is the honest shape of
the product: halflife does not certify anything itself, it buys certification
from another service. One agent hiring another agent and paying for the work is
what halflife *is*, and the payment is the part that makes that true rather
than merely described.

It also closes the oldest hole in StressProof. StressProof's own honesty table
has said from the beginning that its payment config is verified but that no
real payment has ever settled, and that no transaction hash would be claimed
until one existed. Halflife's first paid re-certification is that transaction.

**Acceptance test:** the demo shows a re-certification run, and the settled
transaction is checkable on Base afterwards by anyone with the hash.

**Blocked on:** StressProof deployed to a public URL, and a funded wallet.

## Partner 2: Virtuals

**What halflife does:** registers on the Agent Commerce Protocol as a service
other agents can hire, so an agent about to rely on another agent can pay
halflife to tell it whether that counterparty's certificate still holds.

This is the product's real distribution. Halflife's answer is only worth
anything at the moment somebody is deciding whether to trust an agent, and ACP
is where that decision is actually being made, by agents, at volume.

The Node SDK is `@virtuals-protocol/acp-node`, which matches what halflife is
already written in.

**Acceptance test:** the demo shows a job arriving from ACP and halflife
answering it.

**Blocked on:** a registered agent profile, and Partner 1 working first.

## Order of work

Base first, because halflife cannot run end to end without it and because it
unblocks StressProof's own outstanding gap. Virtuals second.

If Virtuals genuinely cannot be finished to the acceptance test above before
the deadline, it is not claimed. A claimed integration that a judge cannot see
working scores worse than an honest omission, and the honesty table records
what shipped either way.
