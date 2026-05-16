import { defineConfig } from 'astro/config';
import react from '@astrojs/react';

export default defineConfig({
  integrations: [react()],
  site: 'https://Caldalis.github.io',
  base: '/awesome-coding-agents',
  markdown: {
    shikiConfig: {
      theme: 'github-dark',
    },
  },
});
