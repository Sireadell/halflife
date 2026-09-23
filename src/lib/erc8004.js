const ARC_CHAIN_ID = 5042;

export const DEFAULT_IDENTITY_REGISTRY = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const DEFAULT_REPUTATION_REGISTRY = '0x8004BAa17C55a88189AE136b182e5fdA19dE9b63';
export const ERC8004_AGENT_REGISTRY =
  `eip155:${ARC_CHAIN_ID}:${DEFAULT_IDENTITY_REGISTRY}`;
export const ARC_EXPLORER_TX = 'https://arc.etherscan.io/tx/';

export const IDENTITY_ABI = [
  {
    type: 'function',
    name: 'register',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'agentURI', type: 'string' }],
    outputs: [{ name: 'agentId', type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'name',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    type: 'function',
    name: 'symbol',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
];

export const REPUTATION_ABI = [
  {
    type: 'function',
    name: 'getIdentityRegistry',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: 'identityRegistry', type: 'address' }],
  },
  {
    type: 'function',
    name: 'giveFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'endpoint', type: 'string' },
      { name: 'feedbackURI', type: 'string' },
      { name: 'feedbackHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'revokeFeedback',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'readFeedback',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
      { name: 'feedbackIndex', type: 'uint64' },
    ],
    outputs: [
      { name: 'value', type: 'int128' },
      { name: 'valueDecimals', type: 'uint8' },
      { name: 'tag1', type: 'string' },
      { name: 'tag2', type: 'string' },
      { name: 'isRevoked', type: 'bool' },
    ],
  },
  {
    type: 'function',
    name: 'getLastIndex',
    stateMutability: 'view',
    inputs: [
      { name: 'agentId', type: 'uint256' },
      { name: 'clientAddress', type: 'address' },
    ],
    outputs: [{ name: 'feedbackIndex', type: 'uint64' }],
  },
];

export function resolveErc8004Addresses(env = process.env) {
  return {
    identityAddress: (env.HALFLIFE_ERC8004_IDENTITY ?? DEFAULT_IDENTITY_REGISTRY).trim(),
    reputationAddress: (env.HALFLIFE_ERC8004_REPUTATION ?? DEFAULT_REPUTATION_REGISTRY).trim(),
  };
}

/**
 * Which ERC-8004 agent id belongs to a tested URL, from
 * HALFLIFE_ERC8004_AGENT_IDS (a JSON object of targetUrl to agentId).
 *
 * Halflife never registers the agents it rates. Arc's Reputation Registry
 * refuses feedback from an agent's own owner ("Self-feedback not allowed"), so
 * an agent Halflife registered is an agent Halflife can never rate. The owner
 * registers; Halflife is told the id and only ever gives feedback.
 */
export function resolveKnownAgentId(targetUrl, env = process.env) {
  const raw = env.HALFLIFE_ERC8004_AGENT_IDS;
  if (!raw || typeof targetUrl !== 'string') return null;
  let map;
  try {
    map = JSON.parse(raw);
  } catch {
    return null;
  }
  const id = map?.[targetUrl.trim()];
  return id === undefined || id === null || !/^\d+$/.test(String(id)) ? null : String(id);
}

/**
 * The viem helpers load only when the live client is built, so tests can import
 * this file without pulling in signing code.
 */
export async function createErc8004({
  walletClient,
  publicClient,
  identityAddress,
  reputationAddress,
  env = process.env,
} = {}) {
  if (!walletClient || !publicClient) {
    throw new TypeError('createErc8004 requires walletClient and publicClient.');
  }
  const { getAddress } = await import('viem');
  const resolved = resolveErc8004Addresses(env);
  const identity = getAddress(identityAddress ?? resolved.identityAddress);
  const reputation = getAddress(reputationAddress ?? resolved.reputationAddress);

  async function wait(txHash, label) {
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== 'success') {
      throw new Error(`erc8004: ${label} transaction ${txHash} was mined but reverted.`);
    }
    return txHash;
  }

  async function verifyRegistries() {
    const [identityCode, reputationCode, name, symbol, linkedIdentity] = await Promise.all([
      publicClient.getBytecode({ address: identity }),
      publicClient.getBytecode({ address: reputation }),
      publicClient.readContract({
        address: identity,
        abi: IDENTITY_ABI,
        functionName: 'name',
      }),
      publicClient.readContract({
        address: identity,
        abi: IDENTITY_ABI,
        functionName: 'symbol',
      }),
      publicClient.readContract({
        address: reputation,
        abi: REPUTATION_ABI,
        functionName: 'getIdentityRegistry',
      }),
    ]);

    if (!identityCode || identityCode === '0x') {
      throw new Error(`erc8004: no IdentityRegistry code found at ${identity}.`);
    }
    if (!reputationCode || reputationCode === '0x') {
      throw new Error(`erc8004: no ReputationRegistry code found at ${reputation}.`);
    }
    if (name !== 'AgentIdentity' || symbol !== 'AGENT') {
      throw new Error(`erc8004: IdentityRegistry at ${identity} did not answer as AgentIdentity AGENT.`);
    }
    if (getAddress(linkedIdentity) !== identity) {
      throw new Error(`erc8004: ReputationRegistry points at ${linkedIdentity}, not ${identity}.`);
    }
  }

  return {
    identityAddress: identity,
    reputationAddress: reputation,

    async registerAgent(agentURI) {
      await verifyRegistries();
      const { request, result } = await publicClient.simulateContract({
        address: identity,
        abi: IDENTITY_ABI,
        functionName: 'register',
        args: [agentURI],
        account: walletClient.account,
      });
      const txHash = await walletClient.writeContract(request);
      await wait(txHash, 'registerAgent');
      return { agentId: result.toString(), txHash };
    },

    async giveFeedback({ agentId, value, valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash }) {
      await verifyRegistries();
      // Simulated first so a registry refusal surfaces with its real reason
      // and costs no gas, instead of a mined-but-reverted transaction.
      const { request } = await publicClient.simulateContract({
        address: reputation,
        abi: REPUTATION_ABI,
        functionName: 'giveFeedback',
        args: [BigInt(agentId), BigInt(value), valueDecimals, tag1, tag2, endpoint, feedbackURI, feedbackHash],
        account: walletClient.account,
      });
      const txHash = await walletClient.writeContract(request);
      await wait(txHash, 'giveFeedback');
      return { txHash };
    },

    async revokeFeedback(agentId, index) {
      await verifyRegistries();
      const { request } = await publicClient.simulateContract({
        address: reputation,
        abi: REPUTATION_ABI,
        functionName: 'revokeFeedback',
        args: [BigInt(agentId), BigInt(index)],
        account: walletClient.account,
      });
      const txHash = await walletClient.writeContract(request);
      await wait(txHash, 'revokeFeedback');
      return { txHash };
    },

    async getLastIndex(agentId, client) {
      const index = await publicClient.readContract({
        address: reputation,
        abi: REPUTATION_ABI,
        functionName: 'getLastIndex',
        args: [BigInt(agentId), getAddress(client)],
      });
      return index.toString();
    },

    async readFeedback(agentId, client, index) {
      const [value, valueDecimals, tag1, tag2, isRevoked] = await publicClient.readContract({
        address: reputation,
        abi: REPUTATION_ABI,
        functionName: 'readFeedback',
        args: [BigInt(agentId), getAddress(client), BigInt(index)],
      });
      return {
        value: value.toString(),
        valueDecimals,
        tag1,
        tag2,
        isRevoked,
      };
    },
  };
}
