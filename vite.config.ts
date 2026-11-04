import { readFileSync } from 'node:fs'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const packageJson = JSON.parse(
  readFileSync(new URL('./package.json', import.meta.url), 'utf8'),
) as { version: string }

function removeCrossorigin(): Plugin {
  return {
    name: 'remove-crossorigin',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replaceAll(/\bcrossorigin\b/g, '');
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), removeCrossorigin()],
  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version),
  },
  base: './',
  build: {
    outDir: 'dist',
  },
})
