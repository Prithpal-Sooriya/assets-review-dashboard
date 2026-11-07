import { formatInt, formatMonthKey } from '../data/format'
import type { MonthAggregate } from '../data/metrics'

export interface TableColumn {
  key: string
  header: string
  value: (a: MonthAggregate) => string
  /** Raw value for the totals row; omit to skip summing this column. */
  total?: (a: MonthAggregate) => number
}

interface ChartTableProps {
  caption: string
  aggregates: MonthAggregate[]
  columns: TableColumn[]
  showTotals?: boolean
}

/** Accessible data-table alternative for every chart. */
export function ChartTable({ caption, aggregates, columns, showTotals = true }: ChartTableProps) {
  if (aggregates.length === 0) return null
  return (
    <details className="data-table">
      <summary>View as table</summary>
      <div className="table-scroll">
        <table className="data">
          <caption className="hidden-visually">{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Month</th>
              {columns.map((c) => (
                <th key={c.key} scope="col" className="num">
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {aggregates.map((a) => (
              <tr key={a.month}>
                <th scope="row">{formatMonthKey(a.month)}</th>
                {columns.map((c) => (
                  <td key={c.key} className="num">
                    {c.value(a)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
          {showTotals && (
            <tfoot>
              <tr>
                <th scope="row">Total</th>
                {columns.map((c) => (
                  <td key={c.key} className="num">
                    {c.total ? formatInt(aggregates.reduce((s, a) => s + c.total!(a), 0)) : '—'}
                  </td>
                ))}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </details>
  )
}
