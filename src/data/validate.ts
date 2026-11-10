import {
  type CoverageEntry,
  type CoverageStatus,
  type DashboardData,
  type FirstReviewSample,
  type MonthEntry,
  type Ownership,
  type OwnershipReason,
  type PrEntry,
  type PrState,
  type TeamMergeSample,
  type WeekEntry,
} from './types'
import { isMondayMidnightUtc, isValidISOTimestamp, isValidMonthKey, isValidWeekKey, isoWeekKeyFromIso } from './format'

export interface ValidationIssue {
  path: string
  message: string
}

export interface ValidationResult {
  errors: ValidationIssue[]
  warnings: ValidationIssue[]
}

const COVERAGE_STATUSES: readonly CoverageStatus[] = ['complete', 'partial', 'pending', 'error']
const OWNERSHIPS: readonly Ownership[] = ['internal', 'external']
const OWNERSHIP_REASONS: readonly OwnershipReason[] = ['team-label', 'team-author', 'other']
const PR_STATES: readonly PrState[] = ['OPEN', 'CLOSED', 'MERGED']

export interface ParsedDashboard {
  data?: DashboardData
  parseError?: string
}

export function parseDashboardJson(raw: string): ParsedDashboard {
  if (raw.trim() === '') {
    return { parseError: 'Data file is empty' }
  }
  try {
    const value: unknown = JSON.parse(raw)
    return { data: value as DashboardData }
  } catch (err) {
    return { parseError: `Invalid JSON: ${(err as Error).message}` }
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function checkStringList(
  value: unknown,
  path: string,
  errors: ValidationIssue[],
): void {
  if (!Array.isArray(value)) {
    errors.push({ path, message: 'expected an array of strings' })
    return
  }
  for (const [i, item] of value.entries()) {
    if (typeof item !== 'string') {
      errors.push({ path: `${path}[${i}]`, message: 'expected a string' })
    }
  }
}

function checkNonNegativeInt(value: unknown, path: string, errors: ValidationIssue[]): boolean {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    errors.push({ path, message: 'expected a non-negative integer' })
    return false
  }
  return true
}

function checkEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  path: string,
  errors: ValidationIssue[],
): boolean {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    errors.push({ path, message: `expected one of: ${allowed.join(', ')}` })
    return false
  }
  return true
}

/**
 * Structural validation of DashboardData against the shared contract v1.
 *
 * Errors mean the data cannot be trusted for rendering (the UI shows an
 * invalid-data state instead of wrong numbers). Warnings are data-quality
 * diagnostics surfaced to the operator.
 */
export function validateDashboardData(data: DashboardData): ValidationResult {
  const errors: ValidationIssue[] = []
  const warnings: ValidationIssue[] = []
  const at = (path: string) => (data as unknown as Record<string, unknown>)[path]

  if (!isRecord(data)) {
    return { errors: [{ path: '$', message: 'root must be an object' }], warnings }
  }

  if (at('schemaVersion') !== 1) {
    errors.push({ path: '$.schemaVersion', message: `expected 1, got ${JSON.stringify(at('schemaVersion'))}` })
  }

  if (!isValidISOTimestamp(at('generatedAt'))) {
    errors.push({ path: '$.generatedAt', message: 'expected an ISO UTC timestamp' })
  } else if (!data.generatedAt.endsWith('Z')) {
    warnings.push({ path: '$.generatedAt', message: 'not UTC-normalised (missing Z suffix)' })
  }

  const range = at('range')
  if (!isRecord(range) || !isValidISOTimestamp(range?.start) || !isValidISOTimestamp(range?.end)) {
    errors.push({ path: '$.range', message: 'expected { start, end } ISO timestamps' })
  } else {
    if (new Date(data.range.start).getTime() >= new Date(data.range.end).getTime()) {
      errors.push({ path: '$.range.end', message: 'range end must be after range start (end is exclusive)' })
    }
    if (!data.range.start.endsWith('Z') || !data.range.end.endsWith('Z')) {
      warnings.push({ path: '$.range', message: 'range timestamps not UTC-normalised (missing Z suffix)' })
    }
  }

  const methodology = at('methodology')
  if (!isRecord(methodology) || typeof methodology.version !== 'string' || !Array.isArray(methodology.notes)) {
    errors.push({ path: '$.methodology', message: 'expected { version: string, notes: string[] }' })
  } else {
    checkStringList(data.methodology.notes, '$.methodology.notes', errors)
  }

  const seenMonthRepo = new Set<string>()
  const monthsByRepo = new Map<string, MonthEntry[]>()
  // Safe locals: never dereference data.months / data.coverage after their
  // Array.isArray checks fail — malformed input must produce validation
  // errors, never a thrown TypeError (which would white-screen the app).
  const monthsArr: MonthEntry[] = Array.isArray(at('months')) ? (data.months as MonthEntry[]) : []
  const coverageArr: CoverageEntry[] = Array.isArray(at('coverage')) ? (data.coverage as CoverageEntry[]) : []

  if (!Array.isArray(at('months'))) {
    errors.push({ path: '$.months', message: 'expected an array' })
  } else {
    monthsArr.forEach((entry: MonthEntry, i: number) => {
      const path = `$.months[${i}]`
      if (!isRecord(entry)) {
        errors.push({ path, message: 'expected an object' })
        return
      }
      if (!isValidMonthKey(entry.month)) {
        errors.push({ path: `${path}.month`, message: `expected YYYY-MM, got ${JSON.stringify(entry.month)}` })
      }
      if (typeof entry.repo !== 'string' || entry.repo === '') {
        errors.push({ path: `${path}.repo`, message: 'expected a non-empty string' })
      }
      const key = `${entry.repo}|${entry.month}`
      if (seenMonthRepo.has(key)) {
        warnings.push({ path, message: `duplicate entry for repo ${entry.repo}, month ${entry.month}` })
      }
      seenMonthRepo.add(key)
      const numericFields: [keyof MonthEntry, string][] = [
        ['internalReviewedPrs', 'internalReviewedPrs'],
        ['externalReviewedPrs', 'externalReviewedPrs'],
        ['reviewSubmissions', 'reviewSubmissions'],
        ['reviewedUnmergedPrs', 'reviewedUnmergedPrs'],
        ['mergedInternalPrs', 'mergedInternalPrs'],
        ['mergedExternalReviewedPrs', 'mergedExternalReviewedPrs'],
      ]
      for (const [field, label] of numericFields) {
        checkNonNegativeInt(entry[field], `${path}.${label}`, errors)
      }
      const list = monthsByRepo.get(entry.repo) ?? []
      list.push(entry)
      monthsByRepo.set(entry.repo, list)
    })
  }

  if (!Array.isArray(at('coverage'))) {
    errors.push({ path: '$.coverage', message: 'expected an array' })
  } else {
    const seenCoverage = new Set<string>()
    coverageArr.forEach((entry: CoverageEntry, i: number) => {
      const path = `$.coverage[${i}]`
      if (!isRecord(entry)) {
        errors.push({ path, message: 'expected an object' })
        return
      }
      if (!isValidMonthKey(entry.month)) {
        errors.push({ path: `${path}.month`, message: `expected YYYY-MM, got ${JSON.stringify(entry.month)}` })
      }
      if (typeof entry.repo !== 'string' || entry.repo === '') {
        errors.push({ path: `${path}.repo`, message: 'expected a non-empty string' })
      }
      checkEnum(entry.status, COVERAGE_STATUSES, `${path}.status`, errors)
      if (entry.detail !== undefined && typeof entry.detail !== 'string') {
        errors.push({ path: `${path}.detail`, message: 'expected a string when present' })
      }
      const key = `${entry.repo}|${entry.month}`
      if (seenCoverage.has(key)) {
        warnings.push({ path, message: `duplicate coverage entry for ${key}` })
      }
      seenCoverage.add(key)
    })
    if (coverageArr.length === 0 && monthsArr.length > 0) {
      warnings.push({
        path: '$.coverage',
        message: 'coverage is empty although months exist; completeness cannot be shown',
      })
    }
  }

  const seenPrIds = new Set<string>()
  const seenPrRepoNumbers = new Set<string>()
  const monthKeys = new Set(monthsArr.map((m: MonthEntry) => m.month))

  if (!Array.isArray(at('prs'))) {
    errors.push({ path: '$.prs', message: 'expected an array' })
  } else {
    data.prs.forEach((pr: PrEntry, i: number) => {
      const path = `$.prs[${i}]`
      if (!isRecord(pr)) {
        errors.push({ path, message: 'expected an object' })
        return
      }
      if (typeof pr.id !== 'string' || pr.id === '') {
        errors.push({ path: `${path}.id`, message: 'expected a non-empty string' })
      } else if (seenPrIds.has(pr.id)) {
        warnings.push({ path: `${path}.id`, message: `duplicate PR id ${pr.id}` })
      }
      seenPrIds.add(pr.id)

      if (typeof pr.repo !== 'string' || pr.repo === '') {
        errors.push({ path: `${path}.repo`, message: 'expected a non-empty string' })
      }
      if (!Number.isInteger(pr.number) || pr.number <= 0) {
        errors.push({ path: `${path}.number`, message: 'expected a positive integer' })
      } else {
        const repoNumberKey = `${pr.repo}#${pr.number}`
        if (seenPrRepoNumbers.has(repoNumberKey)) {
          warnings.push({ path, message: `duplicate repo/number ${repoNumberKey}` })
        }
        seenPrRepoNumbers.add(repoNumberKey)
        if (pr.id !== repoNumberKey) {
          warnings.push({ path: `${path}.id`, message: `id "${pr.id}" does not match stable form repo#number (${repoNumberKey})` })
        }
      }
      if (typeof pr.title !== 'string') {
        errors.push({ path: `${path}.title`, message: 'expected a string' })
      }
      if (typeof pr.url !== 'string' || !/^https:\/\//.test(pr.url)) {
        errors.push({ path: `${path}.url`, message: 'expected an https URL' })
      }
      checkEnum(pr.ownership, OWNERSHIPS, `${path}.ownership`, errors)
      checkEnum(pr.ownershipReason, OWNERSHIP_REASONS, `${path}.ownershipReason`, errors)
      checkEnum(pr.state, PR_STATES, `${path}.state`, errors)

      if (pr.mergedAt !== null && !isValidISOTimestamp(pr.mergedAt)) {
        errors.push({ path: `${path}.mergedAt`, message: 'expected an ISO timestamp or null' })
      }
      if (pr.state === 'MERGED' && isValidISOTimestamp(pr.mergedAt) === false) {
        errors.push({ path: `${path}.mergedAt`, message: 'MERGED PRs must carry a mergedAt timestamp' })
      }
      if (pr.state !== 'MERGED' && pr.mergedAt != null) {
        warnings.push({ path: `${path}.mergedAt`, message: `state is ${pr.state} but mergedAt is set` })
      }

      checkStringList(pr.reviewMonths, `${path}.reviewMonths`, errors)
      if (Array.isArray(pr.reviewMonths)) {
        for (const m of pr.reviewMonths) {
          if (typeof m === 'string' && !isValidMonthKey(m)) {
            errors.push({ path: `${path}.reviewMonths`, message: `expected YYYY-MM entries, got ${JSON.stringify(m)}` })
          }
        }
      }

      if (!isRecord(pr.reviewCountsByMonth)) {
        errors.push({ path: `${path}.reviewCountsByMonth`, message: 'expected an object keyed by YYYY-MM' })
      } else {
        for (const [m, count] of Object.entries(pr.reviewCountsByMonth)) {
          if (!isValidMonthKey(m)) {
            errors.push({ path: `${path}.reviewCountsByMonth.${m}`, message: 'key is not YYYY-MM' })
          }
          checkNonNegativeInt(count, `${path}.reviewCountsByMonth["${m}"]`, errors)
        }
      }

      checkStringList(pr.labels, `${path}.labels`, errors)

      // Cross-checks (warnings): PR-level months should exist in months[].
      if (Array.isArray(pr.reviewMonths)) {
        for (const m of pr.reviewMonths) {
          if (typeof m === 'string' && monthKeys.size > 0 && !monthKeys.has(m)) {
            warnings.push({
              path: `${path}.reviewMonths`,
              message: `month ${m} is not present in $.months (drill-down list may not match aggregates)`,
            })
          }
        }
      }
    })
  }

  const countFields: [keyof WeekEntry, string][] = [
    ['internalReviewedPrs', 'internalReviewedPrs'],
    ['externalReviewedPrs', 'externalReviewedPrs'],
    ['reviewSubmissions', 'reviewSubmissions'],
    ['reviewedUnmergedPrs', 'reviewedUnmergedPrs'],
    ['mergedInternalPrs', 'mergedInternalPrs'],
    ['mergedExternalReviewedPrs', 'mergedExternalReviewedPrs'],
  ]

  if (!Array.isArray(at('weeks'))) {
    errors.push({ path: '$.weeks', message: 'expected an array' })
  } else {
    const seenWeek = new Set<string>()
    data.weeks.forEach((entry: WeekEntry, i: number) => {
      const path = `$.weeks[${i}]`
      if (!isRecord(entry)) {
        errors.push({ path, message: 'expected an object' })
        return
      }
      if (!isValidWeekKey(entry.week)) {
        errors.push({ path: `${path}.week`, message: `expected YYYY-Www, got ${JSON.stringify(entry.week)}` })
      }
      if (typeof entry.weekStart !== 'string' || !isMondayMidnightUtc(entry.weekStart)) {
        errors.push({ path: `${path}.weekStart`, message: 'expected Monday 00:00:00.000Z' })
      } else if (isValidWeekKey(entry.week) && isoWeekKeyFromIso(entry.weekStart) !== entry.week) {
        errors.push({ path: `${path}.week`, message: `week ${entry.week} does not match weekStart` })
      }
      if (typeof entry.repo !== 'string' || entry.repo === '') {
        errors.push({ path: `${path}.repo`, message: 'expected a non-empty string' })
      }
      if (typeof entry.partial !== 'boolean') {
        errors.push({ path: `${path}.partial`, message: 'expected a boolean' })
      }
      const key = `${entry.repo}|${entry.week}`
      if (seenWeek.has(key)) {
        warnings.push({ path, message: `duplicate entry for repo ${entry.repo}, week ${entry.week}` })
      }
      seenWeek.add(key)
      for (const [field, label] of countFields) {
        checkNonNegativeInt(entry[field], `${path}.${label}`, errors)
      }
    })
  }

  const rangeStartMs = isRecord(range) && isValidISOTimestamp(range.start) ? Date.parse(range.start) : NaN
  const rangeEndMs = isRecord(range) && isValidISOTimestamp(range.end) ? Date.parse(range.end) : NaN

  if (!Array.isArray(at('firstReviews'))) {
    errors.push({ path: '$.firstReviews', message: 'expected an array' })
  } else {
    data.firstReviews.forEach((sample: FirstReviewSample, i: number) => {
      const path = `$.firstReviews[${i}]`
      if (!isRecord(sample)) {
        errors.push({ path, message: 'expected an object' })
        return
      }
      if (typeof sample.repo !== 'string' || sample.repo === '') {
        errors.push({ path: `${path}.repo`, message: 'expected a non-empty string' })
      }
      checkEnum(sample.ownership, OWNERSHIPS, `${path}.ownership`, errors)
      if (!isValidISOTimestamp(sample.at)) {
        errors.push({ path: `${path}.at`, message: 'expected an ISO timestamp' })
      } else if (Number.isFinite(rangeStartMs) && (Date.parse(sample.at) < rangeStartMs || Date.parse(sample.at) >= rangeEndMs)) {
        errors.push({ path: `${path}.at`, message: 'timestamp falls outside the collection range' })
      }
      checkNonNegativeInt(sample.minutes, `${path}.minutes`, errors)
    })
  }

  if (!Array.isArray(at('teamMerges'))) {
    errors.push({ path: '$.teamMerges', message: 'expected an array' })
  } else {
    data.teamMerges.forEach((sample: TeamMergeSample, i: number) => {
      const path = `$.teamMerges[${i}]`
      if (!isRecord(sample)) {
        errors.push({ path, message: 'expected an object' })
        return
      }
      if (typeof sample.repo !== 'string' || sample.repo === '') {
        errors.push({ path: `${path}.repo`, message: 'expected a non-empty string' })
      }
      if (!isValidISOTimestamp(sample.mergedAt)) {
        errors.push({ path: `${path}.mergedAt`, message: 'expected an ISO timestamp' })
      } else if (
        Number.isFinite(rangeStartMs) &&
        (Date.parse(sample.mergedAt) < rangeStartMs || Date.parse(sample.mergedAt) >= rangeEndMs)
      ) {
        errors.push({ path: `${path}.mergedAt`, message: 'timestamp falls outside the collection range' })
      }
      checkNonNegativeInt(sample.minutes, `${path}.minutes`, errors)
    })
  }

  // Cross-check (warning): months[] aggregates vs PR-level derivation.
  if (errors.length === 0 && monthsArr.length > 0) {
    const derived = deriveAggregatesFromPrs(data.prs)
    for (const entry of monthsArr) {
      const d = derived.get(`${entry.repo}|${entry.month}`)
      if (!d) {
        if (entry.internalReviewedPrs + entry.externalReviewedPrs > 0) {
          warnings.push({
            path: `$.months[repo=${entry.repo},month=${entry.month}]`,
            message: 'no PRs in $.prs support the reviewed-PR counts for this repo-month',
          })
        }
        continue
      }
      const mismatches: string[] = []
      if (d.internalReviewedPrs !== entry.internalReviewedPrs) mismatches.push(`internalReviewedPrs ${d.internalReviewedPrs}!=${entry.internalReviewedPrs}`)
      if (d.externalReviewedPrs !== entry.externalReviewedPrs) mismatches.push(`externalReviewedPrs ${d.externalReviewedPrs}!=${entry.externalReviewedPrs}`)
      if (d.reviewSubmissions !== entry.reviewSubmissions) mismatches.push(`reviewSubmissions ${d.reviewSubmissions}!=${entry.reviewSubmissions}`)
      if (d.reviewedUnmergedPrs !== entry.reviewedUnmergedPrs) mismatches.push(`reviewedUnmergedPrs ${d.reviewedUnmergedPrs}!=${entry.reviewedUnmergedPrs}`)
      if (d.mergedExternalReviewedPrs !== entry.mergedExternalReviewedPrs) mismatches.push(`mergedExternalReviewedPrs ${d.mergedExternalReviewedPrs}!=${entry.mergedExternalReviewedPrs}`)
      if (mismatches.length > 0) {
        warnings.push({
          path: `$.months[repo=${entry.repo},month=${entry.month}]`,
          message: `aggregates differ from PR-level derivation: ${mismatches.join('; ')}`,
        })
      }
    }
  }

  return { errors, warnings }
}

export interface DerivedRepoMonth {
  internalReviewedPrs: number
  externalReviewedPrs: number
  reviewSubmissions: number
  reviewedUnmergedPrs: number
  mergedInternalPrs: number
  mergedExternalReviewedPrs: number
}

function emptyDerived(): DerivedRepoMonth {
  return {
    internalReviewedPrs: 0,
    externalReviewedPrs: 0,
    reviewSubmissions: 0,
    reviewedUnmergedPrs: 0,
    mergedInternalPrs: 0,
    mergedExternalReviewedPrs: 0,
  }
}

/** PR-level derivation of the months[] aggregates (contract semantics). */
export function deriveAggregatesFromPrs(prs: PrEntry[]): Map<string, DerivedRepoMonth> {
  const out = new Map<string, DerivedRepoMonth>()
  const get = (repo: string, month: string): DerivedRepoMonth => {
    const key = `${repo}|${month}`
    let v = out.get(key)
    if (!v) {
      v = emptyDerived()
      out.set(key, v)
    }
    return v
  }
  for (const pr of prs) {
    const reviewedMonths = pr.reviewMonths.filter((m) => isValidMonthKey(m))
    for (const m of reviewedMonths) {
      const agg = get(pr.repo, m)
      if (pr.ownership === 'internal') agg.internalReviewedPrs += 1
      else agg.externalReviewedPrs += 1
      agg.reviewSubmissions += pr.reviewCountsByMonth[m] ?? 0
      if (pr.state !== 'MERGED') agg.reviewedUnmergedPrs += 1
    }
    if (pr.state === 'MERGED' && pr.mergedAt) {
      const mergedMonth = `${new Date(pr.mergedAt).getUTCFullYear()}-${String(new Date(pr.mergedAt).getUTCMonth() + 1).padStart(2, '0')}`
      if (isValidMonthKey(mergedMonth)) {
        const agg = get(pr.repo, mergedMonth)
        if (pr.ownership === 'internal') {
          agg.mergedInternalPrs += 1
        } else {
          // qualifying team review at/before merge: any review month <= merged month
          const hasQualifyingReview = pr.reviewMonths.some((m) => m <= mergedMonth)
          if (hasQualifyingReview) agg.mergedExternalReviewedPrs += 1
        }
      }
    }
  }
  return out
}
