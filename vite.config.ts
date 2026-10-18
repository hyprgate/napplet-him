import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { nip5aManifest } from '@napplet/vite-plugin';

export default defineConfig({
  base: './',
  plugins: [
    svelte(),
    nip5aManifest({
      nappletType: 'him',
      requires: ['identity', 'common', 'relay', 'intent', 'dm', 'resource', 'storage'],
      optional: ['theme'],
      icon: { data: readFileSync(new URL('./icon.png', import.meta.url)), mimeType: 'image/png' },
      artifactMode: 'single-file',
    }),
  ],
  resolve: { conditions: ['module', 'browser', 'development|production'], dedupe: ['svelte'] },
  server: { port: 9496, cors: true },
  build: { outDir: 'dist' },
});
