import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { visualizer } from 'rollup-plugin-visualizer'

const buildId = process.env.CF_PAGES_COMMIT_SHA || process.env.COMMIT_REF || new Date().toISOString()
process.env.VITE_APP_BUILD_ID = buildId

function injectSwConfig(): Plugin {
  const replacePlaceholders = (source: string): string => {
    const mirrors = (process.env.VITE_DEFAULT_MIRRORS || 'movix.health')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const configUrl =
      process.env.VITE_MIRRORS_CONFIG_URL || 'https://rentry.co/movix'
    return source
      .replace(/__MOVIX_DEFAULT_MIRRORS__/g, JSON.stringify(mirrors))
      .replace(/__MOVIX_CONFIG_URL__/g, JSON.stringify(configUrl))
  }
  return {
    name: 'movix-sw-inject',
    // Mode build : transforme dist/sw.js après que Vite ait copié public/sw.js
    closeBundle() {
      const swPath = resolve(__dirname, 'dist/sw.js')
      if (!existsSync(swPath)) return
      const contents = readFileSync(swPath, 'utf-8')
      writeFileSync(swPath, replacePlaceholders(contents), 'utf-8')
    },
    // Mode dev : intercepte GET /sw.js et sert une version transformée
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const pathOnly = (req.url || '').split('?')[0]
        if (pathOnly !== '/sw.js') {
          return next()
        }
        const swPath = resolve(__dirname, 'public/sw.js')
        if (!existsSync(swPath)) return next()
        const contents = readFileSync(swPath, 'utf-8')
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(replacePlaceholders(contents))
      })
    },
  }
}

export default defineConfig({
  logLevel: 'warn',
  plugins: [
    react(),
    injectSwConfig(),
    ...(process.env.ANALYZE === 'true'
      ? [
          visualizer({
            filename: 'dist/stats.html',
            gzipSize: true,
            brotliSize: true,
            template: 'treemap',
            open: false,
          }),
        ]
      : []),
  ],
  server: {
    host: true,
    port: 3000,
    hmr: true,
    watch: {
      usePolling: true,
      interval: 100,
      ignored: ['**/node_modules/**', '**/.git/**'],
    },
  },
  preview: {
    host: true,
    port: 3000,
  },
  build: {
    target: 'es2020', // explicit, was implicit es2020 in Vite 5
    chunkSizeWarningLimit: 600, // uncompressed kB; warning only, doesn't fail
    reportCompressedSize: false, // skip per-chunk gzip/brotli computation (slow + verbose)
    commonjsOptions: {
      include: [/node_modules/],
      sourceMap: false,
      transformMixedEsModules: true
    },
    rollupOptions: {
      input: './index.html',
      // Silence per-occurrence noise from minified CJS-in-ESM bundles (dashjs floods 2 MiB+)
      onLog(level, log, defaultHandler) {
        if (log.code === 'COMMONJS_VARIABLE_IN_ESM') return
        defaultHandler(level, log)
      },
      output: {
        codeSplitting: {
          groups: [
            {
              name: 'react-vendor',
              test: /[\\/]node_modules[\\/](react|react-dom|react-router-dom|react-helmet-async|scheduler|uuid)[\\/]/,
            },
            {
              name: 'radix',
              test: /[\\/]node_modules[\\/](@radix-ui|@headlessui|class-variance-authority|tailwind-merge|clsx|tailwindcss-animate)[\\/]/,
            },
            {
              name: 'motion',
              test: /[\\/]node_modules[\\/](framer-motion|lenis|sonner)[\\/]/,
            },
            {
              name: 'i18n',
              test: /[\\/]node_modules[\\/](i18next|i18next-browser-languagedetector|react-i18next)[\\/]/,
            },
            {
              name: 'markdown',
              test: /[\\/]node_modules[\\/](react-markdown|remark-emoji|remark-gfm)[\\/]/,
            },
          ],
        },
      },
    }
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src'),
    }
  }
})
