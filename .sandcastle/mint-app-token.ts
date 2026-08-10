// Mints short-lived GitHub App installation tokens on demand (toon-meta#248,
// ported from connector#463).
//
// App installation tokens expire ONE HOUR after mint. This runner mints once
// at job start (the "Generate GitHub App token" workflow step) and, before
// this fix, pushed only at the very end of a long implement+review cycle —
// any run crossing that hour died at the final `git push` after every
// expensive agent iteration had already been spent (connector#462, diagnosed
// live on connector#459). This module signs the App JWT and exchanges it for
// an installation token itself (RS256 via node:crypto — no jsonwebtoken
// dependency), so the caller can mint immediately before EVERY push instead.
//
// `createTokenMinter` returns `undefined` when APP_ID/APP_PRIVATE_KEY are not
// set on the host, so a local run (or any run with only an ambient GH_TOKEN)
// falls back unchanged — that fallback lives in this file's caller
// (agent-implement-issue.ts's `pushBranch`).
//
// Standalone copy, mirrors sandbox-secrets.ts's duplication pattern: this
// stage-0 runner is executed directly via tsx (`pnpm sandcastle:implement`),
// not through the pnpm workspace, so it cannot import
// @toon-protocol/forge-core's copy of this same logic.

import { createSign } from "node:crypto";

export interface MintAppTokenConfig {
  readonly appId: string;
  readonly privateKey: string;
  /** "owner/repo" — the installation minting a token is resolved from this repo. */
  readonly repo: string;
  /** Injectable for tests. Default: the global `fetch`. */
  readonly fetchFn?: typeof fetch;
  /** Clock seam for tests. Default: `Date.now`. */
  readonly now?: () => number;
}

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Signs a short-lived (9 minute) App JWT — GitHub's cap is 10 minutes; 9
 * leaves room for clock drift between this host and GitHub's.
 */
export function signAppJwt(
  appId: string,
  privateKey: string,
  nowMs: number,
): string {
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  // Backdate `iat` by 60s: GitHub rejects a JWT issued in the future, which a
  // few seconds of clock drift can otherwise trigger.
  const iatSeconds = Math.floor(nowMs / 1000) - 60;
  const payload = base64url(
    JSON.stringify({ iat: iatSeconds, exp: iatSeconds + 9 * 60, iss: appId }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256")
    .update(signingInput)
    .sign(privateKey)
    .toString("base64url");
  return `${signingInput}.${signature}`;
}

/**
 * Mints one fresh installation access token: resolve the App's installation
 * on `config.repo`, then exchange it for an access token. Throws on any API
 * failure — a failed mint must surface loud, never fall back silently
 * mid-push.
 */
export async function mintInstallationToken(
  config: MintAppTokenConfig,
): Promise<string> {
  const fetchFn = config.fetchFn ?? fetch;
  const now = config.now ?? Date.now;
  const jwt = signAppJwt(config.appId, config.privateKey, now());
  const authHeaders = {
    Authorization: `Bearer ${jwt}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };

  const installationResp = await fetchFn(
    `https://api.github.com/repos/${config.repo}/installation`,
    { headers: authHeaders },
  );
  if (!installationResp.ok) {
    throw new Error(
      `mint-app-token: failed to resolve the App installation for '${config.repo}' (HTTP ${installationResp.status}).`,
    );
  }
  const installation = (await installationResp.json()) as { id: number };

  const tokenResp = await fetchFn(
    `https://api.github.com/app/installations/${installation.id}/access_tokens`,
    { method: "POST", headers: authHeaders },
  );
  if (!tokenResp.ok) {
    throw new Error(
      `mint-app-token: failed to mint an installation token for '${config.repo}' (HTTP ${tokenResp.status}).`,
    );
  }
  const minted = (await tokenResp.json()) as { token: string };
  return minted.token;
}

/**
 * Builds a "mint one fresh token" function from ambient env, or `undefined`
 * when the App credentials are absent from the host — the signal the caller
 * uses to fall back to an ambient GH_TOKEN / an already-wired credential
 * helper instead (local dev, or any run with no App installed).
 */
export function createTokenMinter(
  env: NodeJS.ProcessEnv = process.env,
): (() => Promise<string>) | undefined {
  const appId = env.APP_ID;
  const privateKey = env.APP_PRIVATE_KEY;
  const repo = env.GITHUB_REPOSITORY;
  if (!appId || !privateKey || !repo) {
    return undefined;
  }
  return () => mintInstallationToken({ appId, privateKey, repo });
}
