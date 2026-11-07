import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const VIRTUAL_ID = 'virtual:dashboard-data'
const RESOLVED_ID = '\0' + VIRTUAL_ID
const DEFAULT_DATA_PATH = 'data/dashboard.json'
const DEMO_DATA_PATH = 'public/sample/demo-dashboard.json'

export interface DashboardBuildInput {
  source: 'real' | 'demo' | 'none'
  dataPath: string
  raw: string
  loadError: string | null
}

/**
 * Reads dashboard data from the build filesystem (never the GitHub API).
 *
 * Resolution order:
 *  1. $DASHBOARD_DATA_PATH (explicit override, used by UI tests)
 *  2. data/dashboard.json   (real data produced by the collector)
 *  3. public/sample/demo-dashboard.json (clearly-labelled synthetic demo fixture)
 *
 * `source` is 'demo' whenever the demo fixture is used, so the UI can show a
 * prominent demo banner and never present fixture numbers as real findings.
 */
export function readDashboardBuildInput(projectRoot: string): DashboardBuildInput {
  const override = process.env.DASHBOARD_DATA_PATH
  const candidates: string[] = override
    ? [override]
    : [DEFAULT_DATA_PATH, DEMO_DATA_PATH]

  let firstError: string | null = null
  for (const candidate of candidates) {
    const abs = path.resolve(projectRoot, candidate)
    try {
      const raw = fs.readFileSync(abs, 'utf8')
      const isDemo = path.resolve(projectRoot, DEMO_DATA_PATH) === abs
      return { source: isDemo ? 'demo' : 'real', dataPath: candidate, raw, loadError: firstError }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        if (candidate === DEFAULT_DATA_PATH && !override) continue // expected: fall back to demo
        firstError = firstError ?? `Could not read ${candidate}: ${code ?? 'unknown error'}`
        continue
      }
      firstError = firstError ?? `Could not read ${candidate}: ${code ?? String(err)}`
    }
  }
  return {
    source: 'none',
    dataPath: override ?? DEFAULT_DATA_PATH,
    raw: '',
    loadError:
      firstError ??
      `No dashboard data found at ${override ?? DEFAULT_DATA_PATH} and demo fixture missing at ${DEMO_DATA_PATH}`,
  }
}

function dashboardDataPlugin(projectRoot: string): Plugin {
  let input: DashboardBuildInput | null = null

  const code = (): string => {
    input = input ?? readDashboardBuildInput(projectRoot)
    return [
      `export const source = ${JSON.stringify(input.source)};`,
      `export const dataPath = ${JSON.stringify(input.dataPath)};`,
      `export const raw = ${JSON.stringify(input.raw)};`,
      `export const loadError = ${JSON.stringify(input.loadError)};`,
    ].join('\n')
  }

  return {
    name: 'dashboard-data',
    enforce: 'pre',
    resolveId(id) {
      return id === VIRTUAL_ID ? RESOLVED_ID : null
    },
    load(id) {
      if (id !== RESOLVED_ID) return undefined
      return code()
    },
    configureServer(server) {
      // Restart-free reload when the underlying data file changes during dev.
      const watched = [
        process.env.DASHBOARD_DATA_PATH ?? DEFAULT_DATA_PATH,
        DEMO_DATA_PATH,
      ]
      for (const w of watched) {
        const abs = path.resolve(projectRoot, w)
        server.watcher.on('change', (file: string) => {
          if (file === abs) {
            input = null
            const modules = server.moduleGraph.getModulesByFile(
              path.resolve(projectRoot, 'src/data/loader.ts'),
            )
            const mod = modules ? Array.from(modules)[0] : undefined
            if (mod) server.moduleGraph.invalidateModule(mod)
            server.ws.send({ type: 'full-reload' })
          }
        })
      }
    },
  }
}

export default defineConfig(() => {
  const projectRoot = path.resolve(process.cwd())
  return {
    plugins: [react(), dashboardDataPlugin(projectRoot)],
    build: {
      outDir: process.env.VITE_OUT_DIR ?? 'dist',
      sourcemap: true,
    },
  }
})
