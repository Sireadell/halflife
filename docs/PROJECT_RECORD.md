# Halflife Project Record

Last updated: 2026-09-24

## One-line description

Halflife certifies AI agents on Arc, keeps the proof public, and revokes the certificate when later testing shows the agent got worse.

## Current submission status

Submitted to Arc Microgrants on DoraHacks on 2026-09-24.

The final submission framed Halflife as a safety-first trust layer for AI agents:

- paid live checks in Arc USDC through x402
- certificate issue and revoke proof written to Arc
- ERC-8004 reputation feedback written on Arc canonical registries
- owner-controlled certification first, so adversarial testing is not misused against someone else's live product

## Public links

- Live product: https://halflife-b0o4.onrender.com/judge.html
- Certificate page: https://halflife-b0o4.onrender.com/arc-certificate.html
- Public repo: https://github.com/Sireadell/halflife
- Builder profile: https://github.com/Sireadell
- X profile: https://x.com/sireadell

## Main Arc proof

Latest paid Arc run with ERC-8004 feedback:

- Demo agent owner wallet registered ERC-8004 agent `192`
- Agent registration tx: `0x6228f9ba72e4b811c2bdc11302c9ef73f3e41b001ce7edd3fc496c06d5e70dbb`
- Paid run memo: `0xb94fb2143d6ef5b183986522922bd6946f5ef4c9c314f464cde3257f6b272e9a`
- ERC-8004 feedback tx: `0x07cc5131d493a43dcdd35399ab4bd4ad851ea35a044b8aeae43247d6a6ccf880`
- Registry readback: `100 RESILIENT`, not revoked

Earlier issue and revoke proof:

- Certificate issue tx: `0xe21574e8463509ab806bc62af60eac34f9276b584da663adbf4adb3d1565b866`
- Certificate revoke tx: `0x9ec75646190b84a566f6f279bcf21678f78a3d3e310b2f896a691e051876f95b`

## Submitted short description

Halflife certifies AI agents on Arc, keeps the evidence public, and updates the record when later testing shows the agent got worse. A paid Arc USDC x402 check writes memo proof and ERC-8004 reputation feedback so reviewers can verify the trust history outside Halflife.

## Submitted Arc usage answer

Halflife uses Arc mainnet for the trust record itself: users pay for a live check in Arc USDC through x402, certificate issue and revoke events are written as Arc memo proof, and current measured results are written as ERC-8004 reputation feedback on Arc's canonical registries. The latest paid run registered the demo agent as ERC-8004 agent 192 and wrote RESILIENT feedback on-chain.

## Safety framing

For safety, Halflife currently certifies agents only when the requester can prove they control the agent. That keeps adversarial testing from being used to spam, probe, or attack someone else's live product. The long-term goal is public agent review, but this first version protects builders while still creating verifiable trust records on Arc.

## What reviewers should understand fast

1. AI agents change after launch.
2. A one-time certificate can become misleading.
3. Halflife runs adversarial checks and records the result.
4. If the agent gets worse later, Halflife records a revoke instead of letting the old certificate keep speaking.
5. Arc is where the trust record lives.

## Demo path for reviewers

1. Open the judge page.
2. Read the real Arc history and the latest paid run.
3. Open the certificate page for the issue and revoke story.
4. Check the Arc proof links and ERC-8004 feedback transaction.
5. Confirm the safety model: owner-controlled agents first.

## Post-submission priorities

1. Keep the deployed demo stable.
2. Test the product from a fresh browser daily while review is active.
3. Keep the proof links and transaction hashes easy to find.
4. Prepare a 60 to 90 second demo video if reviewers ask.
5. Watch DoraHacks messages, email, Telegram, and Discord for follow-up.

## Submitted asset

The DoraHacks submission logo is saved at `docs/halflife-logo.png`.
