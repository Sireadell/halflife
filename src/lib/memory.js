/**
 * Halflife's memory. Every read and every write of remembered state happens in
 * this file and nowhere else.
 *
 * WHERE MEMORY IS WRITTEN:  rememberCertification(), recordRun()
 * WHERE MEMORY IS READ:     recallCertification(), readRunHistory(), searchRegistry()
 *
 * Storage is Sibyl Memory, reached through memory/bridge.py. Two of Sibyl's
 * tiers are used, for two different jobs:
 *
 *   entities ("agent")  where one agent stands right now: its latest verdict,
 *                       the certificate issued for it, and whether that
 *                       certificate still holds. One record per agent,
 *                       overwritten as the agent is re-certified. This is what
 *                       makes "has anything changed?" answerable at all.
 *
 *   events              the journal: every certification run in time order,
 *                       never rewritten. This is what makes the history real
 *                       rather than a single before-and-after snapshot.
 *
 * On failure this module throws. That is deliberate, and it is the opposite of
 * how halflife treats its optional parts. Halflife without memory is not a
 * degraded halflife, it is nothing at all: with no previous verdict there is
 * nothing to compare against and no answer to give. Returning a cheerful
 * "no change detected" while the memory was actually unreachable would be the
 * exact silent failure this project exists to catch.
 */

import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE = path.resolve(HERE, '../../memory/bridge.py');

const CALL_TIMEOUT_MS = 10_000;
const START_TIMEOUT_MS = 20_000;

/** Category name for the per-agent standing record in Sibyl's entity tier. */
export const AGENT_CATEGORY = 'agent';

/**
 * Category name for an agent's registered risk level.
 *
 * Kept in its own record rather than on the standing record, because the two
 * are different kinds of fact with different lifetimes. The standing record is
 * overwritten by every certification, so a risk level living there would be one
 * bad write away from being lost, and losing it would silently drop a payment
 * agent to the bar meant for an assistant. A risk level is also not a finding:
 * it is what whoever registered the agent said the agent is for.
 */
export const RISK_CATEGORY = 'risk-level';

export class MemoryUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryUnavailableError';
  }
}

/**
 * A live connection to the memory bridge. One long-lived Python process,
 * replies matched to callers by id.
 */
export class Memory {
  #child = null;
  #pending = new Map();
  #nextId = 1;
  #buffer = '';
  #ready = null;
  #closed = false;

  constructor({ dbPath, python } = {}) {
    this.dbPath = dbPath ?? process.env.HALFLIFE_MEMORY_DB ?? './halflife-memory.db';
    this.python = python ?? process.env.HALFLIFE_PYTHON ?? 'python';
  }

  async start() {
    if (this.#ready) return this.#ready;

    this.#ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new MemoryUnavailableError('memory bridge did not become ready in time'));
      }, START_TIMEOUT_MS);

      let child;
      try {
        child = spawn(this.python, [BRIDGE], {
          env: { ...process.env, HALFLIFE_MEMORY_DB: this.dbPath, PYTHONUNBUFFERED: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
      } catch (cause) {
        clearTimeout(timer);
        reject(new MemoryUnavailableError(`could not start python: ${cause.message}`));
        return;
      }

      this.#child = child;

      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });

      child.on('error', (cause) => {
        clearTimeout(timer);
        const error = new MemoryUnavailableError(`python failed: ${cause.message}`);
        this.#failAllPending(error);
        reject(error);
      });

      child.on('exit', (code) => {
        clearTimeout(timer);
        this.#child = null;
        const detail = stderr.trim() || `exit code ${code}`;
        const error = new MemoryUnavailableError(`memory bridge stopped: ${detail}`);
        this.#failAllPending(error);
        if (!this.#closed) reject(error);
      });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        this.#buffer += chunk;

        let newline;
        while ((newline = this.#buffer.indexOf('\n')) !== -1) {
          const line = this.#buffer.slice(0, newline).trim();
          this.#buffer = this.#buffer.slice(newline + 1);
          if (!line) continue;

          let message;
          try {
            message = JSON.parse(line);
          } catch {
            continue; // a partial or non-JSON line is not worth killing the process over
          }

          // A null id is the bridge announcing itself, not a reply to a call.
          if (message.id === null || message.id === undefined) {
            clearTimeout(timer);
            if (message.ok) resolve(this);
            else reject(new MemoryUnavailableError(message.error ?? 'memory unavailable'));
            continue;
          }

          const waiting = this.#pending.get(message.id);
          if (!waiting) continue;
          this.#pending.delete(message.id);
          clearTimeout(waiting.timer);

          if (message.ok) waiting.resolve(message.result);
          else waiting.reject(new MemoryUnavailableError(message.error ?? 'memory call failed'));
        }
      });
    });

    return this.#ready;
  }

  #failAllPending(error) {
    for (const [, waiting] of this.#pending) {
      clearTimeout(waiting.timer);
      waiting.reject(error);
    }
    this.#pending.clear();
  }

  /** One Sibyl call. Throws MemoryUnavailableError rather than returning a default. */
  async call(op, args = [], kwargs = {}) {
    await this.start();
    if (!this.#child) throw new MemoryUnavailableError('memory bridge is not running');

    const id = this.#nextId++;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new MemoryUnavailableError(`memory call timed out: ${op}`));
      }, CALL_TIMEOUT_MS);

      this.#pending.set(id, { resolve, reject, timer });
      this.#child.stdin.write(`${JSON.stringify({ id, op, args, kwargs })}\n`);
    });
  }

  async close() {
    this.#closed = true;
    if (!this.#child) return;

    const child = this.#child;
    child.stdin.end();
    await Promise.race([once(child, 'exit'), new Promise((r) => setTimeout(r, 2000))]);
    if (this.#child) child.kill();
    this.#child = null;
    this.#ready = null;
  }

  // ---------------------------------------------------------------------
  // Halflife's memory semantics. Everything above is transport. Everything
  // below is what halflife actually chooses to remember.
  // ---------------------------------------------------------------------

  /**
   * WRITE. Record where an agent stands now: its latest verdict, the
   * certificate issued for it, and whether that certificate still holds.
   * Overwrites the previous standing on purpose. History lives in the journal.
   */
  async rememberCertification(target, record) {
    return this.call('set_entity', [AGENT_CATEGORY, target, record]);
  }

  /**
   * READ. What we knew about this agent before this run. Returns null the
   * first time an agent is ever seen, which is a real answer and not an error.
   */
  async recallCertification(target) {
    const entity = await this.call('get_entity', [AGENT_CATEGORY, target]);
    if (!entity) return null;
    return entity.body ?? null;
  }

  /**
   * WRITE. Record what an agent is registered as, so the bar it is held to
   * survives a restart. Overwrites the current registration on purpose; the
   * journal keeps every change, so the record of what it used to be is not in
   * this record's keeping.
   */
  async rememberRiskLevel(target, record) {
    return this.call('set_entity', [RISK_CATEGORY, target, record]);
  }

  /** READ. What this agent is registered as, or null if nobody has said. */
  async recallRiskLevel(target) {
    const entity = await this.call('get_entity', [RISK_CATEGORY, target]);
    if (!entity) return null;
    return entity.body ?? null;
  }

  /** WRITE. Append one run to the journal. Never rewritten. */
  async recordRun(line, extra = {}) {
    return this.call('write_event', [], { acted: [line], extra });
  }

  /** READ. The journal, most recent first. */
  async readRunHistory(limit = 20) {
    return this.call('read_events', [], { limit });
  }

  /**
   * READ. Every agent halflife has ever certified, whether or not anyone knows
   * its name.
   *
   * Separate from searchRegistry because Sibyl's search needs something to
   * search for: an empty query matches nothing, so a registry page built on
   * search would report an empty registry on a database full of agents. This
   * lists the tier instead, which is the question the registry is actually
   * asking.
   */
  async listRegistry() {
    return this.call('list_entities', [AGENT_CATEGORY]);
  }

  /**
   * READ. Every registered risk level, in one call.
   *
   * The registry needs the level for every agent it lists, and asking for them
   * one at a time would be one memory round trip per agent. Levels live in
   * their own tier, so they can be fetched in a single call and joined by name.
   */
  async listRiskLevels() {
    return this.call('list_entities', [RISK_CATEGORY]);
  }

  /**
   * READ. Find an agent halflife has certified, by name.
   *
   * Filtered to the agent tier on the way out. Sibyl searches every tier, so an
   * unfiltered result returns the same agent twice, once as a certification
   * record and once as a risk level, and a caller reading `body.verdict` off
   * the risk level record would find nothing there and conclude the agent has
   * never been certified.
   */
  async searchRegistry(query = '') {
    const found = await this.call('search_entities', [query]);
    if (!Array.isArray(found)) return found;
    return found.filter((entity) => entity?.category === AGENT_CATEGORY);
  }
}

/** Convenience for callers that want one shared connection. */
let shared = null;
export function sharedMemory(options) {
  if (!shared) shared = new Memory(options);
  return shared;
}
