/**
 * The sweep: re-check the agents whose certificates have run out of time.
 *
 * WHY THIS EXISTS AT ALL.
 *
 * Halflife's claim is that a certificate expires. Computing staleness at read
 * time makes that claim true in the answer, which is most of the work: nobody
 * is ever told a two month old certificate is fresh. But a product whose only
 * behaviour is to eventually say "I stopped knowing" is a product that gives up.
 * The sweep is the other half: it goes and finds out again.
 *
 * WHAT IT REFUSES TO DO.
 *
 * It never guesses a request. A certification needs a sample request the agent
 * accepts, and if nobody registered one for an agent the sweep skips it and says
 * so. Sending a made-up body would produce a verdict about how the agent handles
 * a request it was never told to expect, and that verdict could revoke a
 * certificate. An honest skip is a gap in checking, which halflife already has a
 * word for and already reports as its own failure rather than the agent's.
 *
 * It never lets one agent's failure stop the others. Each target is certified
 * inside its own try, because the certifier already treats an unreachable
 * upstream as a gap rather than a finding, and a sweep that aborted on the first
 * error would leave the rest of the registry unchecked for reasons that had
 * nothing to do with them.
 *
 * Memory failure is the one thing it does not survive, and deliberately: with no
 * memory there is no list of agents to sweep, and continuing would mean sweeping
 * nothing while reporting a completed sweep.
 */

export async function sweepDue({ registry, certifier, withinMs = 0, limit = 25 } = {}) {
  if (!registry || !certifier) {
    throw new TypeError('sweepDue requires a registry to read from and a certifier to run');
  }

  const { asOf, due } = await registry.due({ withinMs });

  const checked = [];
  const skipped = [];

  for (const agent of due.slice(0, limit)) {
    if (!agent.checkRequest) {
      skipped.push({
        target: agent.target,
        standing: agent.standing,
        reason:
          'no re-check request is registered for this agent, so halflife has nothing honest to send it. ' +
          'Register one with the agent to have it re-checked without anybody asking.',
      });
      continue;
    }

    try {
      const result = await certifier.certify(agent.target, agent.checkRequest);
      checked.push({
        target: agent.target,
        standing: result.standing,
        drift: result.drift,
        measured: result.measured,
        journalLine: result.journalLine,
      });
    } catch (error) {
      // Recorded rather than thrown. The certifier only throws here when memory
      // itself failed mid-run, and the caller is told which agent it happened on
      // instead of being handed a sweep that looks like it finished.
      skipped.push({
        target: agent.target,
        standing: agent.standing,
        reason: `the check could not be run: ${error.message}`,
      });
    }
  }

  return {
    asOf,
    dueCount: due.length,
    // Said plainly, because a caller that sees fewer results than due agents
    // needs to know whether that was the limit or the registry.
    limit,
    deferred: Math.max(0, due.length - Math.min(due.length, limit)),
    checked,
    skipped,
  };
}

/**
 * Run the sweep on a timer.
 *
 * Off unless a deployment asks for it. A background job that spends money on
 * StressProof for every due agent is not something a service should start doing
 * because it was deployed, so the interval is configuration and the default is
 * to do nothing.
 *
 * Errors from a sweep are logged and the timer continues. The alternative,
 * stopping the loop on the first bad night, would mean a memory blip silently
 * ends re-checking forever and every certificate quietly goes stale with nobody
 * told why.
 */
export function startSweeper({ registry, certifier, intervalMs, withinMs = 0, limit = 25, log = console }) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { running: false, stop() {} };
  }

  const timer = setInterval(async () => {
    try {
      const result = await sweepDue({ registry, certifier, withinMs, limit });
      log.log(
        `sweep: ${result.checked.length} re-checked, ${result.skipped.length} skipped, ${result.deferred} left for next time`,
      );
      for (const skip of result.skipped) log.log(`sweep skipped ${skip.target}: ${skip.reason}`);
    } catch (error) {
      log.error(`sweep failed: ${error.message}. Certificates will keep expiring until this is fixed.`);
    }
  }, intervalMs);

  // Not keeping the process alive on its own account. The HTTP server is what
  // this process is for, and a sweeper that outlived it would be a timer firing
  // into a service nobody can reach.
  timer.unref?.();

  return { running: true, intervalMs, stop: () => clearInterval(timer) };
}
