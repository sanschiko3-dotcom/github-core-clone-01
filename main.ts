// main.ts — entrypoint for the github-core-clone-01 forge.
//
// Lifecycle (RULES.txt): start the forge on an ephemeral port, register that port
// with the trial environment, poll the environment's /done endpoint until it
// reports done, then exit 0. The whole forge lives in app.ts; this file only
// wires the lifecycle around it.
//
// Usage: node --experimental-strip-types main.ts
// (Node 22, stdlib only — no dependencies, no git binary.)

import { createForge } from './app.ts';

const ENV_URL = process.env.MAKEFUN_ENV_URL ?? '';
const POLL_INTERVAL_MS = 500;
const POLL_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes of polling, then give up

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(port: number): Promise<void> {
  if (ENV_URL === '') return; // local dev: no environment to register with
  // Registration is a single POST at startup; a transient failure here would
  // waste the whole trial, so retry a few times before giving up.
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      if (res.ok) return;
      lastError = new Error(`register failed: HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
    await sleep(500 * attempt);
  }
  throw lastError instanceof Error ? lastError : new Error('register failed');
}

async function waitForDone(): Promise<void> {
  if (ENV_URL === '') return; // local dev: the process runs until killed
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const res = await fetch(`${ENV_URL}/done`);
    if (res.ok) {
      const body = (await res.json()) as { done?: boolean };
      if (body.done === true) return;
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('timed out waiting for /done');
}

const forge = createForge();
const port = await forge.listen(0);
console.log(`forge listening on port ${port}`);
await register(port);
await waitForDone();
console.log('environment done; shutting down');
await forge.close();
process.exit(0);
