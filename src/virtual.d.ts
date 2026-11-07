declare module 'virtual:dashboard-data' {
  export const source: 'real' | 'demo' | 'none'
  export const dataPath: string
  export const raw: string
  export const loadError: string | null
}
