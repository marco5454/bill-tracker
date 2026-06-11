import { defineConfig } from 'vite';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// Post-build plugin: read dist/, build the precache list of static assets, and
// stamp it (plus a version string) into service-worker.js. The SW file is
// copied verbatim from public/; here we just rewrite its placeholder tokens.
//
// We keep this inline to avoid pulling in vite-plugin-pwa or workbox.
function pwaServiceWorker() {
  return {
    name: 'pwa-service-worker',
    apply: 'build',
    closeBundle() {
      const distDir = join(process.cwd(), 'dist');
      const swPath = join(distDir, 'service-worker.js');

      let raw;
      try {
        raw = readFileSync(swPath, 'utf8');
      } catch {
        // service-worker.js wasn't copied — public/ disabled or missing.
        return;
      }

      // Walk dist/ and collect URLs the SW should precache. We grab everything
      // except the SW itself, source maps, and the manifest (which is fetched
      // separately). All paths are relative URLs that resolve from the SW's
      // own scope (which is the deploy root).
      const urls = [];
      function walk(dir) {
        for (const entry of readdirSync(dir)) {
          const p = join(dir, entry);
          const s = statSync(p);
          if (s.isDirectory()) { walk(p); continue; }
          const rel = relative(distDir, p).split('/').join('/');
          if (rel === 'service-worker.js') continue;
          if (rel.endsWith('.map')) continue;
          urls.push('./' + rel);
        }
      }
      walk(distDir);

      // Stable version stamp = newest mtime + asset count. Changes whenever
      // any built file changes, which forces the SW to update on each deploy.
      const newest = Math.max(...urls.map(u => statSync(join(distDir, u.slice(2))).mtimeMs));
      const version = `${Math.round(newest)}-${urls.length}`;

      const next = raw
        .replace(/__SW_VERSION__/g, version)
        .replace(
          /self\.__SHELL_URLS__\s*\|\|\s*\[[\s\S]*?\]/,
          `self.__SHELL_URLS__ || ${JSON.stringify(urls, null, 2)}`
        );

      writeFileSync(swPath, next);
    }
  };
}

export default defineConfig({
  root: 'client',
  // Vite copies everything under client/public/ verbatim into dist/. That's
  // where the manifest, icons, and the service worker template live.
  publicDir: 'public',
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true
      }
    }
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    sourcemap: true,
    target: 'es2022'
  },
  plugins: [pwaServiceWorker()]
});
