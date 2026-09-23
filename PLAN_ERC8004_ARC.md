# Build plan: publish Halflife certificates to ERC-8004 on Arc mainnet

Written 2026-09-23. Target: Arc Microgrants submission, closes 2026-10-14 23:59 ET.

This plan is for an engineer (or an AI assistant) implementing it in the
`halflife` repository. Everything in the "Verified facts" section was checked
directly against Arc mainnet or the EIP text on 2026-09-23. Do not re-derive it
from memory, and do not replace any address here with one recalled from
training data.

---

## 1. Why this work exists

Halflife's one original idea is that a certificate can be taken away when an
agent gets worse. Today that idea is expressed in a private format only
Halflife understands: a memo transaction on Arc carrying a report hash. Nobody
else's tooling can read it, so the claim is unverifiable by anyone who is not
already using Halflife.

ERC-8004 is the Ethereum standard for agent identity and reputation. Its
Reputation Registry has `revokeFeedback` as a first-class operation. That means
Halflife's central idea maps directly onto a standard other people's tools
already read, rather than onto a bespoke memo.

The goal of this work: **a Halflife certificate becomes ERC-8004 feedback, and
a Halflife revocation becomes an ERC-8004 feedback revocation, both on Arc
mainnet.**

---

## 2. Verified facts (checked 2026-09-23, do not assume)

| Fact | Value | How it was verified |
|---|---|---|
| Arc mainnet chain id | `5042` | live RPC |
| Arc RPC | `https://rpc.mainnet.arc.io` | live |
| Arc explorer | `https://arc.etherscan.io` | in use already |
| ERC-8004 IdentityRegistry on Arc | `0x8004A169FB4a3325136EB29fA0ceB6D2e539a432` | `eth_getCode` returned bytecode; `name()` returned `AgentIdentity`, `symbol()` returned `AGENT` |
| ERC-8004 ReputationRegistry on Arc | `0x8004BAa17C55a88189AE136b182e5fdA19dE9b63` | `eth_getCode` returned bytecode; it is not ERC-721, as expected |
| Arc USDC (6 decimals for payment amounts) | `0x3600000000000000000000000000000000000000` | already used in this repo |

Both registries are already deployed on Arc. **Do not deploy your own
registry.** Using the canonical address is the entire point: it is what makes
the record readable by other people's tooling.

Before writing any transaction, re-run a read against both addresses and stop
if either does not respond.

---

## 3. The exact interfaces (from the EIP, not invented)

### IdentityRegistry (ERC-721)

```solidity
function register(string agentURI, MetadataEntry[] calldata metadata) external returns (uint256 agentId);
function register(string agentURI) external returns (uint256 agentId);
function register() external returns (uint256 agentId);
function setAgentURI(uint256 agentId, string calldata newURI) external;
function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory);
function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external;
function setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes calldata signature) external;
function getAgentWallet(uint256 agentId) external view returns (address);
function unsetAgentWallet(uint256 agentId) external;

event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
```

Agents are identified by `agentId` (the ERC-721 tokenId). An agent registry is
addressed as `"{namespace}:{chainId}:{identityRegistry}"`, so Halflife's agents
live at `eip155:5042:0x8004A169FB4a3325136EB29fA0ceB6D2e539a432`.

### ReputationRegistry

```solidity
function getIdentityRegistry() external view returns (address identityRegistry);

function giveFeedback(
  uint256 agentId,
  int128 value,
  uint8 valueDecimals,
  string calldata tag1,
  string calldata tag2,
  string calldata endpoint,
  string calldata feedbackURI,
  bytes32 feedbackHash
) external;

function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external;

function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
  external view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked);

function getSummary(uint256 agentId, address[] calldata clientAddresses, string tag1, string tag2)
  external view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals);

function getClients(uint256 agentId) external view returns (address[] memory);
function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);

event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash);
event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);
```

`feedbackIndex` is per (agentId, clientAddress). Halflife is the client. Use
`getLastIndex(agentId, halflifeWallet)` to find the index it just wrote.

---

## 4. The mapping to build

| Halflife concept | ERC-8004 call |
|---|---|
| Agent is known to Halflife | `IdentityRegistry.register(agentURI)` once, store the returned `agentId` |
| Certificate issued, verdict RESILIENT score 100 | `giveFeedback(agentId, 100, 0, "halflife", "RESILIENT", targetUrl, stressproofPermanentLink, reportHash)` |
| Later check, agent degraded, certificate revoked | `revokeFeedback(agentId, feedbackIndex)` for the feedback that is no longer true, then `giveFeedback` with the new lower score |
| Run could not be measured | **write nothing.** Existing rule in `arcCertifier.js` stands: an unmeasured run changes no on-chain state |

Field choices, with reasons:

- `value` = the StressProof score (0 to 100). `valueDecimals` = `0`, since the
  score is already an integer.
- `tag1` = `"halflife"`. This identifies who is speaking, so readers can filter
  Halflife's opinions from anyone else's using `readAllFeedback` / `getSummary`.
- `tag2` = the verdict string (`RESILIENT`, `PARTIAL`, `INCONCLUSIVE`).
- `endpoint` = the agent's target URL that was actually tested.
- `feedbackURI` = the StressProof permanent certificate link
  (`/c/sp1....`), which is self-verifying and does not depend on
  StressProof's database.
- `feedbackHash` = the signed StressProof report hash Halflife already has.
  This is the integrity commitment, and Halflife already refuses to write
  anything on chain when StressProof returns no report hash. Keep that rule.

---

## 5. Tasks, in order

### Task 1: read-only client
Create `src/lib/erc8004.js`. Export a factory that takes a viem wallet/public
client and the two addresses, and exposes:
`registerAgent(agentURI)`, `giveFeedback({...})`, `revokeFeedback(agentId, index)`,
`getLastIndex(agentId, client)`, `readFeedback(...)`.

Import viem lazily, matching the existing pattern in `src/lib/x402Payment.js`,
so the test suite never loads a signing library.

Addresses come from environment variables with the verified values above as
defaults: `HALFLIFE_ERC8004_IDENTITY`, `HALFLIFE_ERC8004_REPUTATION`.

### Task 2: remember the agentId
An agent must be registered in the Identity Registry once, and its `agentId`
stored alongside Halflife's existing record for that target. Add it to the
registry record, not to a new store. If an agent already has an `agentId`,
never register it again.

`agentURI` should resolve to something describing the agent. Use the agent's
own target URL if nothing better exists, and say so in the code rather than
inventing a metadata format.

### Task 3: write feedback on a real verdict
In `src/lib/arcCertifier.js`, where `decideArcAction()` currently returns
`'issued'` or `'revoked'`, add the ERC-8004 write alongside the existing memo.

Do not remove the existing memo write in this task. Two records briefly is
safer than a migration that loses the existing verified proof, and the existing
`/demo/arc-proof/verify` route and the judge page both depend on it.

Rules that must survive:
- an unmeasured run writes nothing on chain;
- no report hash means no write;
- a failure to write ERC-8004 feedback must not crash a certification, and must
  be reported honestly in the result (same shape as `arc: { written, reason }`).

### Task 4: revoke on degradation
When Halflife decides a certificate is revoked, call `revokeFeedback` for the
index of the feedback that is being withdrawn, then write the new lower score
as fresh feedback. Store the `feedbackIndex` when feedback is written, because
revocation needs it later and it cannot be recomputed reliably.

### Task 5: surface it
Add the ERC-8004 agentId and a link to the Arc transaction into:
- the JSON result of a certification;
- `GET /agents/:target`;
- the judge page proof section, as one extra line, not a redesign.

### Task 6: tests
Follow the existing style in `test/`: dependency injection, no network. Cover:
- feedback is written with the right value, tags, URI and hash;
- an unmeasured run writes nothing;
- a missing report hash writes nothing;
- a revocation calls `revokeFeedback` with the stored index;
- a registry failure does not fail the certification and is reported.

Run the full suite. It was 147 passing before this work; it must be at least
that after.

---

## 6. Constraints

- **Do not break what already works.** A real paid run on Arc completed on
  2026-09-23. Existing routes, the payment pre-flight in
  `src/lib/upstreamFunding.js`, and the honesty rules in `expressApp.js`
  (`checked` reflects `measured`) stay exactly as they are.
- **No em dashes anywhere**, in code, comments, commit messages or docs.
- Comments explain why, not what. This codebase's existing comments are the
  style guide.
- Every on-chain write costs real money on Arc, paid in USDC. The wallet is
  thin. Do not add writes to paths that run on a timer without saying so.
- Do not deploy contracts. Do not invent a metadata schema. Do not change the
  StressProof repository as part of this work.

---

## 7. Definition of done

1. `npm test` passes, with new tests covering the rules above.
2. A real certification on Arc mainnet produces an ERC-8004 `NewFeedback` event
   readable at the canonical Reputation Registry address, and the transaction is
   linkable on `arc.etherscan.io`.
3. A revocation produces a real `FeedbackRevoked` event.
4. `readFeedback` from an independent script, not Halflife's own code, returns
   the score and verdict Halflife claims.
5. The judge page shows the agentId and links the transaction.
