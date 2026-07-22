import { describe, expect, it } from 'vitest';
import { FORGE_CORE_VERSION } from './index.js';

describe('forge-core scaffold', () => {
  it('exposes a semver version string', () => {
    expect(FORGE_CORE_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
