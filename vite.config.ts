import fs from 'node:fs'
import path from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

const VIRTUAL_ID = 'virtual:dashboard-data'
const RESOLVED_ID = '\0' + VIRTUAL_ID
const DEFAULT_DATA_PATH = 'data/dashboard.json'
const DEMO_DATA_PATH = 'src/data/demo-fixture.json'

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
 *  3. src/data/demo-fixture.json (clearly-labelled synthetic demo fixture)
 *
 * `source` is 'demo' whenever the demo fixture is used, so the UI can show a
 * prominent demo banner and never present fixture numbers as real findings.
 */
export function readDashboardBuildInput(projectRoot: string): DashboardBuildInput {
  const override = process.env.DASHBOARD_DATA_PATH
  if (override !== undefined) {
    // Path safety: the override must be a repo-relative path that resolves
    // inside the project. It is embedded into the public bundle, so absolute
    // paths or traversal outside the repo would publish arbitrary build-host
    // files (credentials, ~/.vercel, etc.).
    if (path.isAbsolute(override) || override.split(path.sep).includes('..')) {
      throw new Error(
        `DASHBOARD_DATA_PATH must be a path relative to the project root (got: ${override})`,
      )
    }
  }
  const candidates: string[] = override
    ? [override]
    : [DEFAULT_DATA_PATH, DEMO_DATA_PATH]

  let firstError: string | null = null
  for (const candidate of candidates) {
    const abs = path.resolve(projectRoot, candidate)
    if (path.relative(projectRoot, abs).startsWith('..')) {
      throw new Error(
        `DASHBOARD_DATA_PATH must resolve inside the project (got: ${candidate})`,
      )
    }
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
  const input = readDashboardBuildInput(projectRoot)

  // Guard: real data must never be built for a public production target on
  // the current (hobby) Vercel plan — production is verified public and
  // password protection is unavailable (see docs/deployment.md). Deploying
  // real data requires the owner to resolve protection AND set this explicit
  // opt-in, so the barrier is code, not prose.
  const isVercelProduction = process.env.VERCEL_ENV === 'production'
  if (isVercelProduction && input.source === 'real' && process.env.DASHBOARD_ALLOW_REAL_DATA !== '1') {
    throw new Error(
      [
        'Refusing to build: this build embeds REAL dashboard data but targets a production deployment.',
        'The production alias is verified PUBLIC on the hobby plan (docs/deployment.md — protection verification).',
        'Deploy real data to protected preview URLs only, or resolve production access control and set',
        'DASHBOARD_ALLOW_REAL_DATA=1 to acknowledge it explicitly.',
      ].join(' '),
    )
  }

  return {
    plugins: [react(), dashboardDataPlugin(projectRoot)],
    build: {
      outDir: process.env.VITE_OUT_DIR ?? 'dist',
      // Sourcemaps embed full original sources (sourcesContent) — they are
      // for local debugging only and must not ship on public deployments.
      sourcemap: process.env.VITE_SOURCEMAP === '1',
    },
  }
})
