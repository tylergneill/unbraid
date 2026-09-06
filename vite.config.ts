import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { mudcatPlugin } from './src/mudcat/plugin';
import { readFileSync } from 'node:fs';

// Single source of truth for the version: package.json. Injected at build
// time so the app can display it without a second file to keep in sync.
const { version } = JSON.parse(readFileSync('./package.json', 'utf8')) as { version: string };

export default defineConfig({
  plugins: [react(), mudcatPlugin()],
  server: { port: 5173 },
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
});
