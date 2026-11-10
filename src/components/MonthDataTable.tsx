import { formatMonthKey } from '../data/format'

export interface MonthTableColumn {
  key: string
  header: string
  cells: string[]
  /** Precomputed total. Omit to leave the totals cell blank. */
  total?: string
}

interface MonthDataTableProps {
  caption: string
  months: string[]
  columns: MonthTableColumn[]
  /** Visible disclosure label. The caption stays the accessible table name. */
  summary?: string
}

/** Month-by-row table for charts whose columns are not the shared month aggregate. */
export function MonthDataTable({ caption, months, columns, summary = 'View as table' }: MonthDataTableProps) {
  if (months.length === 0) return null
  const showTotals = columns.some((c) => c.total !== undefined)
  return (
    <details className="data-table">
      <summary>{summary}</summary>
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
            {months.map((month, i) => (
              <tr key={month}>
                <th scope="row">{formatMonthKey(month)}</th>
                {columns.map((c) => (
                  <td key={c.key} className="num">
                    {c.cells[i]}
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
                    {c.total ?? '—'}
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
