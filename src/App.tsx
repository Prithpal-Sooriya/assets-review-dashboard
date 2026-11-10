import { useEffect, useMemo, useState } from 'react'
import { dashboard } from './data/dashboardData'
import {
  aggregateMonths,
  coverageLookup,
  displayWindow,
  incompleteCoverageMonths,
  latestMonth,
  orderedMonthKeys,
  reposInData,
  totalAggregate,
} from './data/metrics'
import { buildWindowLabel } from './data/format'
import { Header } from './components/Header'
import { DataNotice } from './components/DataNotice'
import { FilterBar } from './components/FilterBar'
import { StatCards } from './components/StatCards'
import { TimelineSection } from './components/TimelineSection'
import { WeeklyBreakdownSection } from './components/WeeklyBreakdownSection'
import { TimeToFirstReviewSection } from './components/TimeToFirstReviewSection'
import { MergeVsReviewSection } from './components/MergeVsReviewSection'
import { TeamMergeSection } from './components/TeamMergeSection'
import { UnmergedSection } from './components/UnmergedSection'
import { MonthPanel } from './components/MonthPanel'
import { CoveragePanel } from './components/CoveragePanel'
import { MethodologyCard, WarningsCard } from './components/NotesCards'
import { EmptyState, InvalidState, MissingState } from './components/StateCards'
import { Footer } from './components/Footer'
import { TodayPanel } from './components/today/TodayPanel'
import { resolvePage, shouldResyncOnUrlChange, type Page, type UrlLocation } from './routing'

export default function App() {
  const [repoFilter, setRepoFilter] = useState<string | null>(null)
  // Page routing: Daily lives at / (the landing page), Historical at
  // /historical. Route-shaped hashes are honored on any path: #/today is the
  // LIVE share-link format for Daily (filter state lives in its query) and
  // #/history is a legacy alias — see src/routing.ts (unit-tested there).
  const [page, setPage] = useState<Page>(() =>
    typeof window === 'undefined' ? 'daily' : resolvePage(window.location.pathname, window.location.hash),
  )
  useEffect(() => {
    // Same-document URL changes: browsers fire popstate for every one of them
    // (hash edits and in-page anchors included, not just back/forward), so
    // both handlers share the guard in routing.ts — re-resolve only on an
    // explicit page navigation. Filter updates use history.replaceState,
    // which fires neither event — filters change state, not the page.
    const sync = () => setPage(resolvePage(window.location.pathname, window.location.hash))
    let last: UrlLocation = { pathname: window.location.pathname, hash: window.location.hash }
    const onUrlChange = () => {
      const next: UrlLocation = { pathname: window.location.pathname, hash: window.location.hash }
      if (shouldResyncOnUrlChange(last, next)) sync()
      last = next
    }
    window.addEventListener('popstate', onUrlChange)
    window.addEventListener('hashchange', onUrlChange)
    return () => {
      window.removeEventListener('popstate', onUrlChange)
      window.removeEventListener('hashchange', onUrlChange)
    }
  }, [])
  const loaded = dashboard

  // Defensive access: in missing/invalid/empty states `data` may be present
  // but malformed — never dereference its fields before `ok` is established.
  const monthKeys = useMemo(
    () => (loaded.data && Array.isArray(loaded.data.months) ? orderedMonthKeys(loaded.data.months) : []),
    [loaded.data],
  )
  const { shown: windowMonths, omittedCount, gapCount } = useMemo(
    () => displayWindow(monthKeys),
    [monthKeys],
  )
  const [selectedMonth, setSelectedMonth] = useState<string>(() => latestMonth(windowMonths) ?? '')

  const ok = loaded.status === 'ok' && loaded.data !== null
  const data = loaded.data

  const repos = useMemo(
    () => (data && Array.isArray(data.months) && Array.isArray(data.coverage)
      ? reposInData(data.months, data.coverage)
      : []),
    [data],
  )
  const aggregates = useMemo(
    () => (data && Array.isArray(data.months) ? aggregateMonths(data.months, repoFilter, windowMonths) : []),
    [data, repoFilter, windowMonths],
  )
  const total = useMemo(() => totalAggregate(aggregates), [aggregates])
  const partialMonths = useMemo(
    () => (data && Array.isArray(data.coverage) ? incompleteCoverageMonths(data.coverage) : new Set<string>()),
    [data],
  )
  const effectiveSelected = windowMonths.includes(selectedMonth)
    ? selectedMonth
    : (latestMonth(windowMonths) ?? '')

  // The window caption lives in buildWindowLabel (src/data/format.ts) with
  // its own unit tests; the invalid-state path renders no caption at all.
  const windowLabel = ok && data ? buildWindowLabel(windowMonths, data.range, gapCount) : ''

  const selectMonth = (month: string) => setSelectedMonth(month)

  if (page === 'daily') {
    return (
      <>
        <Header loaded={loaded} page="daily" />
        <main className="container" id="main">
          <TodayPanel />
        </main>
        <Footer loaded={loaded} />
      </>
    )
  }

  return (
    <>
      <Header loaded={loaded} page="historical" />
      <main className="container" id="main">
        <DataNotice loaded={loaded} />
        {!ok && (
          <>
            {loaded.status === 'missing' && <MissingState loaded={loaded} />}
            {loaded.status === 'invalid' && <InvalidState loaded={loaded} />}
            {loaded.status === 'empty' && <EmptyState loaded={loaded} />}
          </>
        )}
        {ok && data && (
          <>
            <FilterBar
              repos={repos}
              repoFilter={repoFilter}
              onRepoFilter={setRepoFilter}
              windowLabel={windowLabel}
              omittedCount={omittedCount}
            />
            <StatCards total={total} />
            <TimelineSection
              aggregates={aggregates}
              selectedMonth={effectiveSelected || null}
              onSelectMonth={selectMonth}
              partialMonths={partialMonths}
            />
            <WeeklyBreakdownSection
              weeks={data.weeks}
              windowMonths={windowMonths}
              repoFilter={repoFilter}
            />
            <TimeToFirstReviewSection
              samples={data.firstReviews}
              weeks={data.weeks}
              windowMonths={windowMonths}
              rangeEnd={data.range.end}
              repoFilter={repoFilter}
            />
            <MergeVsReviewSection aggregates={aggregates} />
            <TeamMergeSection
              samples={data.teamMerges}
              weeks={data.weeks}
              windowMonths={windowMonths}
              rangeEnd={data.range.end}
              repoFilter={repoFilter}
            />
            <UnmergedSection aggregates={aggregates} />
            {effectiveSelected && (
              <MonthPanel
                data={data}
                windowMonths={windowMonths}
                selectedMonth={effectiveSelected}
                onSelectMonth={selectMonth}
                repoFilter={repoFilter}
              />
            )}
            <CoveragePanel data={data} repos={repos} />
          </>
        )}
        <WarningsCard loaded={loaded} />
        <MethodologyCard loaded={loaded} />
      </main>
      <Footer loaded={loaded} />
    </>
  )
}
