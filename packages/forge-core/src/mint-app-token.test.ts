import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createTokenMinter,
  mintInstallationToken,
  signAppJwt,
} from './mint-app-token.js';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const PRIVATE_KEY_PEM = privateKey
  .export({ type: 'pkcs1', format: 'pem' })
  .toString();

function decodeSegment(segment: string): unknown {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
}

describe('signAppJwt', () => {
  it('signs a JWT with the App id as issuer and a <=10 minute expiry', () => {
    const nowMs = 1_700_000_000_000;
    const jwt = signAppJwt('12345', PRIVATE_KEY_PEM, nowMs);
    const [header, payload, signature] = jwt.split('.');
    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();

    expect(decodeSegment(header!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    const claims = decodeSegment(payload!) as {
      iss: string;
      iat: number;
      exp: number;
    };
    expect(claims.iss).toBe('12345');
    expect(claims.iat).toBe(Math.floor(nowMs / 1000) - 60);
    expect(claims.exp - claims.iat).toBe(9 * 60);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(10 * 60);
  });

  it('produces a signature verifiable against the matching public key', () => {
    const jwt = signAppJwt('12345', PRIVATE_KEY_PEM, 1_700_000_000_000);
    const [header, payload, signature] = jwt.split('.');
    const signingInput = `${header}.${payload}`;
    const ok = verify(
      'RSA-SHA256',
      Buffer.from(signingInput),
      publicKey,
      Buffer.from(signature!, 'base64url')
    );
    expect(ok).toBe(true);
  });
});

describe('mintInstallationToken', () => {
  function fakeFetch(
    overrides: {
      installationOk?: boolean;
      installationStatus?: number;
      installationId?: number;
      tokenOk?: boolean;
      tokenStatus?: number;
      token?: string;
    } = {}
  ) {
    const {
      installationOk = true,
      installationStatus = 200,
      installationId = 999,
      tokenOk = true,
      tokenStatus = 201,
      token = 'ghs_freshtoken',
    } = overrides;
    return vi.fn(async (url: string) => {
      if (url.endsWith('/installation')) {
        return {
          ok: installationOk,
          status: installationStatus,
          json: async () => ({ id: installationId }),
        } as Response;
      }
      return {
        ok: tokenOk,
        status: tokenStatus,
        json: async () => ({ token }),
      } as Response;
    });
  }

  it('resolves the installation for the repo, then mints an access token', async () => {
    const fetchFn = fakeFetch({ installationId: 42, token: 'ghs_abc' });
    const token = await mintInstallationToken({
      appId: '1',
      privateKey: PRIVATE_KEY_PEM,
      repo: 'toon-protocol/Forge',
      fetchFn: fetchFn as unknown as typeof fetch,
      now: () => 1_700_000_000_000,
    });

    expect(token).toBe('ghs_abc');
    expect(fetchFn).toHaveBeenCalledTimes(2);

    const [installationUrl, installationInit] = fetchFn.mock.calls[0]!;
    expect(installationUrl).toBe(
      'https://api.github.com/repos/toon-protocol/Forge/installation'
    );
    expect(
      (installationInit as { headers: Record<string, string> }).headers
        .Authorization
    ).toMatch(/^Bearer /);

    const [tokenUrl, tokenInit] = fetchFn.mock.calls[1]!;
    expect(tokenUrl).toBe(
      'https://api.github.com/app/installations/42/access_tokens'
    );
    expect((tokenInit as { method: string }).method).toBe('POST');
  });

  it('throws when the installation lookup fails', async () => {
    const fetchFn = fakeFetch({
      installationOk: false,
      installationStatus: 404,
    });
    await expect(
      mintInstallationToken({
        appId: '1',
        privateKey: PRIVATE_KEY_PEM,
        repo: 'toon-protocol/Forge',
        fetchFn: fetchFn as unknown as typeof fetch,
      })
    ).rejects.toThrow(/failed to resolve the App installation.*404/s);
  });

  it('throws when minting the access token fails', async () => {
    const fetchFn = fakeFetch({ tokenOk: false, tokenStatus: 403 });
    await expect(
      mintInstallationToken({
        appId: '1',
        privateKey: PRIVATE_KEY_PEM,
        repo: 'toon-protocol/Forge',
        fetchFn: fetchFn as unknown as typeof fetch,
      })
    ).rejects.toThrow(/failed to mint an installation token.*403/s);
  });
});

describe('createTokenMinter', () => {
  it('returns undefined when APP_ID/APP_PRIVATE_KEY/GITHUB_REPOSITORY are not all set (fall back to ambient GH_TOKEN)', () => {
    expect(createTokenMinter({})).toBeUndefined();
    expect(createTokenMinter({ APP_ID: '1' })).toBeUndefined();
    expect(
      createTokenMinter({ APP_ID: '1', APP_PRIVATE_KEY: 'key' })
    ).toBeUndefined();
  });

  it('returns a mint function that mints against the repo named by GITHUB_REPOSITORY', async () => {
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/installation')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 7 }),
        } as Response;
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({ token: 'ghs_minted' }),
      } as Response;
    });

    const mint = createTokenMinter(
      {
        APP_ID: '55',
        APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
        GITHUB_REPOSITORY: 'toon-protocol/Forge',
      },
      { fetchFn: fetchFn as unknown as typeof fetch }
    );

    expect(mint).toBeDefined();
    const token = await mint!();
    expect(token).toBe('ghs_minted');
    expect(fetchFn.mock.calls[0]![0]).toBe(
      'https://api.github.com/repos/toon-protocol/Forge/installation'
    );
  });

  it('mints a fresh token on every call (no caching)', async () => {
    let calls = 0;
    const fetchFn = vi.fn(async (url: string) => {
      if (url.endsWith('/installation')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 7 }),
        } as Response;
      }
      calls += 1;
      return {
        ok: true,
        status: 201,
        json: async () => ({ token: `ghs_${calls}` }),
      } as Response;
    });

    const mint = createTokenMinter(
      {
        APP_ID: '55',
        APP_PRIVATE_KEY: PRIVATE_KEY_PEM,
        GITHUB_REPOSITORY: 'toon-protocol/Forge',
      },
      { fetchFn: fetchFn as unknown as typeof fetch }
    );

    expect(await mint!()).toBe('ghs_1');
    expect(await mint!()).toBe('ghs_2');
  });
});
