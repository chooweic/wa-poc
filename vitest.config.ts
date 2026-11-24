import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      // Wrangler bundles .html files as text; do the same for tests.
      name: 'html-as-text',
      enforce: 'pre',
      load(id) {
        if (id.endsWith('.html')) return `export default ${JSON.stringify(readFileSync(id, 'utf8'))};`;
        return null;
      },
    },
  ],
  test: { include: ['test/**/*.test.ts'], environment: 'node' },
});
