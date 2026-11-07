import { useMemo, useState } from 'react'
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
import { formatMonthKey } from './data/format'
import { Header } from './components/Header'
import { DataNotice } from './components/DataNotice'
import { FilterBar } from './components/FilterBar'
import { StatCards } from './components/StatCards'
import { TimelineSection } from './components/TimelineSection'
import { MergeVsReviewSection } from './components/MergeVsReviewSection'
import { UnmergedSection } from './components/UnmergedSection'
import { MonthPanel } from './components/MonthPanel'
import { CoveragePanel } from './components/CoveragePanel'
import { MethodologyCard, WarningsCard } from './components/NotesCards'
import { EmptyState, InvalidState, MissingState } from './components/StateCards'
import { Footer } from './components/Footer'

export default function App() {
  const [repoFilter, setRepoFilter] = useState<string | null>(null)
  const loaded = dashboard

  const monthKeys = useMemo(
    () => (loaded.data ? orderedMonthKeys(loaded.data.months) : []),
    [loaded.data],
  )
  const { shown: windowMonths, omittedCount } = useMemo(
    () => displayWindow(monthKeys),
    [monthKeys],
  )
  const [selectedMonth, setSelectedMonth] = useState<string>(() => latestMonth(windowMonths) ?? '')

  const ok = loaded.status === 'ok' && loaded.data !== null
  const data = loaded.data

  const repos = useMemo(
    () => (data ? reposInData(data.months, data.coverage) : []),
    [data],
  )
  const aggregates = useMemo(
    () => (data ? aggregateMonths(data.months, repoFilter, windowMonths) : []),
    [data, repoFilter, windowMonths],
  )
  const total = useMemo(() => totalAggregate(aggregates), [aggregates])
  const partialMonths = useMemo(
    () => (data ? incompleteCoverageMonths(data.coverage) : new Set<string>()),
    [data],
  )
  const effectiveSelected = windowMonths.includes(selectedMonth)
    ? selectedMonth
    : (latestMonth(windowMonths) ?? '')

  const windowLabel = data
    ? `Window: ${formatMonthKey(windowMonths[0] ?? data.range.start)} – ${formatMonthKey(windowMonths[windowMonths.length - 1] ?? data.range.end)} · ${windowMonths.length} month${windowMonths.length === 1 ? '' : 's'}`
    : ''

  const selectMonth = (month: string) => setSelectedMonth(month)

  return (
    <>
      <Header loaded={loaded} />
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
            <MergeVsReviewSection aggregates={aggregates} />
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
            <CoveragePanel data={data} repos={repos} windowMonths={windowMonths} />
          </>
        )}
        <WarningsCard loaded={loaded} />
        <MethodologyCard loaded={loaded} />
      </main>
      <Footer loaded={loaded} />
    </>
  )
}
