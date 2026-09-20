// A "provider adapter" for the Virtuals ACP network that uses an ordinary
// Ethereum wallet (a normal private key you hold yourself) instead of a
// Privy-managed wallet.
//
// Why this exists: the SDK's built-in PrivyAlchemyEvmProviderAdapter expects a
// Privy dashboard-issued authorization key, so handing it a normal wallet key
// fails with "Invalid wallet authorization private key". The SDK also ships an
// empty base class, ViemProviderAdapter, that is meant to be filled in for
// exactly this case. This file fills it in.
//
// One important difference from the Privy path: Privy sponsored the gas fees.
// A plain wallet pays its own gas, so the wallet needs a small amount of ETH on
// Base as well as the USDC it is spending.

import { createPublicClient, createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { ViemProviderAdapter } from '@virtuals-protocol/acp-node-v2';

/**
 * Turns a private key into an ACP-compatible provider backed by viem.
 *
 * The private key is used once, in memory, to derive the account. It is never
 * logged, stored, or included in any error message.
 */
export class EoaViemProviderAdapter extends ViemProviderAdapter {
  /**
   * @param {{ privateKey: string, chain?: import('viem').Chain, rpcUrl?: string }} params
   */
  static create({ privateKey, chain = base, rpcUrl }) {
    if (!privateKey || typeof privateKey !== 'string') {
      throw new Error('EoaViemProviderAdapter: a private key is required.');
    }
    const trimmed = privateKey.trim();
    const normalised = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(normalised)) {
      // Deliberately says nothing about the value itself.
      throw new Error(
        'EoaViemProviderAdapter: the private key is not in the expected format ' +
          '(64 hex characters, with or without a leading 0x).',
      );
    }

    const account = privateKeyToAccount(normalised);
    const transport = http(rpcUrl ?? chain.rpcUrls.default.http[0]);
    const publicClient = createPublicClient({ chain, transport });
    const walletClient = createWalletClient({ account, chain, transport });

    return new EoaViemProviderAdapter({ account, chain, publicClient, walletClient });
  }

  constructor({ account, chain, publicClient, walletClient }) {
    super('EOA Viem');
    this.account = account;
    this.chain = chain;
    this.publicClient = publicClient;
    this.walletClient = walletClient;
  }

  /** Throws if the SDK asks for a chain this adapter was not built for. */
  assertChain(chainId) {
    if (chainId !== this.chain.id) {
      throw new Error(
        `EoaViemProviderAdapter: this wallet is configured for chain ${this.chain.id} ` +
          `(${this.chain.name}), but chain ${chainId} was requested.`,
      );
    }
  }

  async getAddress() {
    return this.account.address;
  }

  async getSupportedChainIds() {
    return [this.chain.id];
  }

  // getNetworkContext() is inherited from ViemProviderAdapter, which already
  // resolves the chain correctly via the SDK's own createEvmNetworkContext.

  /**
   * Sends one call (or several, one after another) and waits for each to be
   * mined. A plain wallet cannot bundle several actions into a single
   * transaction the way a smart wallet can, so they go out in order, each one
   * confirmed before the next is sent. That ordering matters: an "approve
   * spending" step must be mined before the step that spends.
   */
  async sendCallsSequentially(chainId, calls) {
    this.assertChain(chainId);
    const hashes = [];
    for (const call of calls) {
      const hash = await this.walletClient.sendTransaction({
        to: call.to,
        data: call.data ?? '0x',
        value: call.value ?? 0n,
      });
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') {
        throw new Error(`Transaction ${hash} was mined but reverted on chain ${chainId}.`);
      }
      hashes.push(hash);
    }
    return hashes;
  }

  async sendTransaction(chainId, call) {
    const calls = Array.isArray(call) ? call : [call];
    const hashes = await this.sendCallsSequentially(chainId, calls);
    // Matches the smart-wallet adapter's shape: one hash for the whole action.
    return hashes[hashes.length - 1];
  }

  async sendCalls(chainId, calls) {
    // Returned as an array. The SDK reads element 0 when it needs the hash of a
    // single-call action (for example, reading the new job number out of the
    // createJob receipt), and that action is always exactly one call.
    return this.sendCallsSequentially(chainId, calls);
  }

  async getTransactionReceipt(chainId, hash) {
    this.assertChain(chainId);
    return this.publicClient.waitForTransactionReceipt({ hash });
  }

  async readContract(chainId, params) {
    this.assertChain(chainId);
    return this.publicClient.readContract(params);
  }

  async getLogs(chainId, params) {
    this.assertChain(chainId);
    return this.publicClient.getLogs(params);
  }

  async getBlockNumber(chainId) {
    this.assertChain(chainId);
    return this.publicClient.getBlockNumber();
  }

  /**
   * Signs a short text message to prove ownership of the wallet. This is what
   * logs the agent in to the Virtuals network. Hex-prefixed input is treated as
   * raw bytes, matching how the SDK's own Privy adapter behaves.
   */
  async signMessage(chainId, message) {
    this.assertChain(chainId);
    if (typeof message === 'string' && message.startsWith('0x')) {
      return this.account.signMessage({ message: { raw: message } });
    }
    return this.account.signMessage({ message });
  }

  async signTypedData(chainId, typedData) {
    this.assertChain(chainId);
    return this.account.signTypedData(typedData);
  }
}
