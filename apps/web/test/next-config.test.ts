import { describe, expect, it } from 'vitest';
import config from '../next.config.ts';

describe('next.config.ts', () => {
  it('turns on Cache Components, Partial Prefetching, typed routes and the React Compiler', () => {
    expect(config).toEqual({
      cacheComponents: true,
      partialPrefetching: true,
      typedRoutes: true,
      reactCompiler: true,
    });
  });
});
