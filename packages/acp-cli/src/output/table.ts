export type TableColumn<Row> = {
  header: string
  value(row: Row): string
}

function padRight(value: string, width: number): string {
  return value.padEnd(width, ' ')
}

export function renderTable<Row>(
  columns: readonly TableColumn<Row>[],
  rows: readonly Row[]
): string {
  if (columns.length === 0) {
    return ''
  }

  const matrix = rows.map((row) => columns.map((column) => column.value(row)))
  const widths = columns.map((column, index) => {
    const cellWidths = matrix.map((row) => row[index]?.length ?? 0)
    return Math.max(column.header.length, ...cellWidths)
  })

  const header = columns
    .map((column, index) => padRight(column.header, widths[index] ?? 0))
    .join('  ')
  const divider = widths.map((width) => '-'.repeat(width)).join('  ')
  const body = matrix.map((row) =>
    row.map((cell, index) => padRight(cell, widths[index] ?? 0)).join('  ')
  )

  return [header, divider, ...body].join('\n')
}

export function renderKeyValueTable(entries: Readonly<Record<string, unknown>>): string {
  const rows = Object.entries(entries).map(([key, value]) => ({
    key,
    value: typeof value === 'string' ? value : JSON.stringify(value),
  }))

  return renderTable(
    [
      { header: 'Field', value: (row) => row.key },
      { header: 'Value', value: (row) => row.value },
    ],
    rows
  )
}
