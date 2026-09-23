import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

export const DEFAULT_ARC_DEMO_RESULT_PATH = path.join(process.cwd(), 'halflife-arc-demo-result.json');

function readEnv(env, name, fallback) {
  const value = typeof env[name] === 'string' ? env[name].trim() : '';
  return value || fallback;
}

export function buildPaidArcDemoSnapshot({ payment, input, result, savedAt }) {
  return {
    savedAt,
    payment,
    targetUrl: input.targetUrl,
    agentAddress: input.agentAddress,
    requestMethod: input.request.method ?? 'POST',
    checkedAt: result.checkedAt,
    measured: result.measured,
    standing: result.standing,
    standingReason: result.standingReason,
    currentVerdict: result.currentVerdict,
    previousVerdict: result.previousVerdict,
    revoked: result.revoked,
    reason: result.reason,
    specVersion: result.specVersion,
    reportHash: result.current?.reportHash ?? null,
    arc: result.arc,
    erc8004: result.arc?.erc8004 ?? null,
    journalLine: result.journalLine,
  };
}

export function createArcDemoResultStore({ env = process.env, filePath } = {}) {
  const resolvedPath = filePath ?? readEnv(env, 'HALFLIFE_ARC_DEMO_RESULT_PATH', DEFAULT_ARC_DEMO_RESULT_PATH);

  return {
    path: resolvedPath,
    async read() {
      try {
        return JSON.parse(await readFile(resolvedPath, 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async write(snapshot) {
      await mkdir(path.dirname(resolvedPath), { recursive: true });
      await writeFile(resolvedPath, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      return snapshot;
    },
  };
}
