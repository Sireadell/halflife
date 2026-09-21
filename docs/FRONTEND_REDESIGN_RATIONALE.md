# Halflife frontend redesign: what changed and why

Written 2026-09-21. This is for handoff to another reviewer (including another
AI, e.g. ChatGPT) who has no prior context on this project. Read this, then
open `frontend-mockup.html` in this same folder (or paste it) to see the
actual page.

## What Halflife is, in one paragraph

Halflife is a certification service for AI agents, built on the Arc
blockchain. It tests an agent (via a separate service called StressProof),
remembers the verdict, and re-checks later. If the agent's behavior gets
worse, the certificate is automatically revoked. Every issue and revoke event
is written permanently to Arc mainnet as a blockchain transaction, so the
record can't be quietly edited later by Halflife or anyone else. This is
being submitted to "Arc Microgrants," a grant program for projects built on
Arc, deadline Oct 14 2026.

## The problem with the existing frontend

The existing live page (`public/judge.html` in this repo, live at
`halflife-b0o4.onrender.com/judge.html`) was built specifically for grant
reviewers to click through and verify claims. It works, but it was never
redesigned into something you'd show a real customer or outsider. Concretely:

1. **The title and header talk to the grader, not a customer.** It's
   literally titled "Halflife Judge Console" with the subhead "Arc
   Microgrants review screen." Anyone who isn't a grant reviewer lands on
   this and immediately reads it as "this isn't a real product, it's a
   hackathon submission prop."

2. **The structure is a QA checklist, not a product pitch.** The page is
   four numbered "review cards": (1) see the app is alive, (2) verify Arc
   proof, (3) run a live paid check, (4) open the certificate proof. This is
   a test plan surfaced as UI. A real visitor doesn't care about "proving
   the app is alive" — they care about whether an agent is trustworthy.

3. **No explanation of the problem before the mechanics.** The page never
   says, in plain language, *why* this matters (agents drift and get worse
   silently) before diving into technical verification steps.

4. **It literally tells the reader how to grade it.** There's a section
   titled "What A Judge Should See In Under 60 Seconds" — the page narrating
   its own evaluation criteria back at the person evaluating it.

5. **Button copy is internal/QA language.** "Verify through app," "Check
   setup without paying" — debug actions, not something an outsider clicks
   to get something they want.

The visual design system underneath (warm parchment palette, Fraunces serif
+ IBM Plex Sans/Mono type pairing, the certificate-card look) is good and was
kept. The problem was entirely the *narrative structure and copy* — organized
for a grader instead of for a customer, with the actual certify action buried
as step 3 of 4.

## What changed in the mockup (`frontend-mockup.html`)

| Old (judge console) | New (mockup) |
|---|---|
| "Halflife Judge Console" / "Arc Microgrants review screen" | "Halflife" — plain product name, zero grading language |
| Opens on a 4-item numbered checklist | Opens on the actual problem: "AI agents get worse over time. Most people never find out." |
| Certify action buried as step 3 of 4 | Certify action is the hero CTA and gets its own full section |
| "What a judge should see in under 60 seconds" | Removed entirely |
| "Verify through app," "Check setup without paying" | "Certify your agent," "Connect wallet & certify" |
| Proof presented as a checklist item | Proof presented as a story: the real issue-then-revoke example on Arc mainnet, framed as "this actually happened," not "step 2, verify this" |

Structure of the new page, top to bottom:
1. Nav (plain wordmark, no console framing)
2. Hero: the problem in plain language, primary CTA, a live certificate
   preview card (visual proof this is a real, running product)
3. "How it works" — three steps, plain language, no checklist styling
4. "Certify an agent, right now" — the actual interactive certify flow,
   given a full section instead of being buried
5. "Proof" — the real Day 3 on-chain example (agent issued, then caught
   drifting and revoked), presented as a compelling case study
6. Footer with technical/verify links tucked away for people who want to
   dig deeper, not front-loaded

## What this mockup is and isn't

- It's a layout and copy redesign — colors, type, and information
  architecture are final-ish; the actual wallet/payment JavaScript
  (`src/browser/judgePay.js`) is NOT wired into this file yet.
- It's meant to replace `public/judge.html` as the default landing page,
  not sit alongside it.
- Nothing about the underlying product, payment mechanism, or Arc
  integration changed. This is presentation only.

## What to critique

Genuinely open questions, not settled:
- Is the hero headline too blunt/negative ("agents get worse") for a first
  impression, or is that honesty exactly the point of an audit product?
- Is burying the wallet-connect mechanics until the "Certify" section the
  right call, or should trust signals (Arc mainnet, transaction proof) be
  even earlier?
- Is one long scrolling page the right shape, or should "Certify" be its own
  route/page separate from the pitch?
- Copy tone: is "Most people never find out" too dramatic, or appropriately
  direct for a security/trust product?
