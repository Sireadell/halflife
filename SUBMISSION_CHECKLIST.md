# Arc Microgrants Submission Checklist

- [x] Public repository contains the complete Halflife source code.
- [x] Arc paid route uses x402 payment before certification.
- [x] Existing Arc memo proof remains in place.
- [x] ERC-8004 issue and revoke feedback are implemented against Arc's canonical registries.
- [x] Final automated checks pass: `npm run build:judge` and `npm test`.
- [x] Push this completed commit to the public repository.
- [x] Confirm the public deployment serves the new commit.
- [x] Complete one paid Arc mainnet run that shows ERC-8004 feedback on-chain.
  Done 2026-09-24. Demo agent registered by its owner wallet as ERC-8004
  agent 192 (tx 0x6228f9ba72e4b811c2bdc11302c9ef73f3e41b001ce7edd3fc496c06d5e70dbb).
  Paid run: memo 0xb94fb2143d6ef5b183986522922bd6946f5ef4c9c314f464cde3257f6b272e9a,
  feedback 0x07cc5131d493a43dcdd35399ab4bd4ad851ea35a044b8aeae43247d6a6ccf880,
  read back from the Reputation Registry as 100 RESILIENT, not revoked.
- [ ] Add the deployed project link, public repository link, short description and builder profile to the official Arc Microgrants form.

## Submission Description

Halflife certifies AI agents, remembers the evidence, and takes a certificate
away when fresh testing shows the agent has become less reliable. A paid Arc
USDC x402 run creates public Arc proof. Measured certificates and revocations
also write canonical ERC-8004 reputation feedback, so other tools can inspect
the trust record instead of relying on Halflife alone.
