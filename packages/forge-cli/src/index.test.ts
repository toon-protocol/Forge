import { describe, expect, it } from 'vitest';
import { version } from './index.js';

describe('forge-cli scaffold', () => {
  it('reports the linked forge-core version', () => {
    expect(version()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
