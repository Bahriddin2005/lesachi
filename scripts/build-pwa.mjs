import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(scriptDir, '..');
const outputDir = join(projectRoot, 'dist');
const pwaSourceDir = join(projectRoot, 'public');

rmSync(outputDir, { recursive: true, force: true });
mkdirSync(outputDir, { recursive: true });

execFileSync('npx', ['expo', 'export', '--platform', 'web', '--output-dir', outputDir], {
  cwd: projectRoot,
  stdio: 'inherit',
});

for (const fileName of ['manifest.json', 'sw.js', 'icon-192.png', 'icon-512.png', 'vercel.json']) {
  copyFileSync(join(pwaSourceDir, fileName), join(outputDir, fileName));
}

// Vercel ignores nested `node_modules` folders during a static upload. Expo
// SQLite's web worker normally points at its WASM file inside that folder,
// which would make the deployed app fail with a blank screen. Copy the WASM
// to a public asset path and rewrite the generated worker reference.
const sqliteWasmDir = join(outputDir, 'assets', 'node_modules', 'expo-sqlite', 'web', 'wa-sqlite');
const webBundleDir = join(outputDir, '_expo', 'static', 'js', 'web');
if (existsSync(sqliteWasmDir) && existsSync(webBundleDir)) {
  const sqliteWasmFile = readdirSync(sqliteWasmDir).find((fileName) => fileName.endsWith('.wasm'));
  if (sqliteWasmFile) {
    copyFileSync(join(sqliteWasmDir, sqliteWasmFile), join(outputDir, 'assets', 'wa-sqlite.wasm'));
    for (const bundleFile of readdirSync(webBundleDir)) {
      if (!bundleFile.endsWith('.js')) continue;
      const bundlePath = join(webBundleDir, bundleFile);
      const bundleSource = readFileSync(bundlePath, 'utf8');
      const patchedSource = bundleSource.replace(
        /\/assets\/node_modules\/expo-sqlite\/web\/wa-sqlite\/[^"'`]+\.wasm/g,
        '/assets/wa-sqlite.wasm',
      );
      if (patchedSource !== bundleSource) writeFileSync(bundlePath, patchedSource);
    }
  }
}

const indexPath = join(outputDir, 'index.html');
let indexHtml = readFileSync(indexPath, 'utf8').replace('<html lang="en">', '<html lang="uz">');

const headTags = `
    <link rel="manifest" href="./manifest.json" />
    <meta name="theme-color" content="#2563EB" />
    <link rel="apple-touch-icon" href="./icon-192.png" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-status-bar-style" content="default" />
    <meta name="apple-mobile-web-app-title" content="Lesachi" />`;
const serviceWorkerRegistration = `
  <script>
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js?v=3').catch(() => {});
      });
    }
  </script>`;

if (!indexHtml.includes('rel="manifest"')) {
  indexHtml = indexHtml.replace('</head>', `${headTags}\n  </head>`);
}
if (!indexHtml.includes('serviceWorker.register')) {
  indexHtml = indexHtml.replace('</body>', `${serviceWorkerRegistration}\n</body>`);
}

writeFileSync(indexPath, indexHtml);
console.log(`PWA build tayyor: ${outputDir}`);
