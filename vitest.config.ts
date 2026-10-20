import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

const src = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

/**
 * One run for every package. Tests import packages by their published names, resolved to their
 * sources here, so a test never runs against a stale build.
 */
export default defineConfig({
  resolve: {
    alias: {
      '@korsi/plugin': src('plugin'),
      '@korsi/bridge': src('bridge'),
      '@korsi/plugin-ui': src('plugin-ui'),
      '@korsi/plugin-react/mui': fileURLToPath(
        new URL('./packages/plugin-react/src/mui.ts', import.meta.url)
      ),
      '@korsi/plugin-react': src('plugin-react'),
    },
  },
  test: {
    include: ['packages/*/test/**/*.test.{ts,tsx}'],
  },
});
