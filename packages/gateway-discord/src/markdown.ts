const MAX_CELL_WIDTH = 50

function wrapText(text: string, maxWidth: number): string[] {
  if (text.length <= maxWidth) {
    return [text]
  }

  const words = text.split(/\s+/)
  const lines: string[] = []
  let currentLine = ''

  for (const word of words) {
    if (word.length > maxWidth) {
      if (currentLine) {
        lines.push(currentLine)
        currentLine = ''
      }

      for (let index = 0; index < word.length; index += maxWidth) {
        lines.push(word.slice(index, index + maxWidth))
      }
      continue
    }

    if (currentLine.length + (currentLine ? 1 : 0) + word.length <= maxWidth) {
      currentLine += `${currentLine ? ' ' : ''}${word}`
      continue
    }

    if (currentLine) {
      lines.push(currentLine)
    }
    currentLine = word
  }

  if (currentLine) {
    lines.push(currentLine)
  }

  return lines.length > 0 ? lines : ['']
}

export function padMarkdownTables(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let tableLines: string[] = []

  const flushTable = () => {
    if (tableLines.length === 0) {
      return
    }

    const rows = tableLines.map((line) =>
      line
        .split('|')
        .slice(1, -1)
        .map((cell) => cell.trim())
    )

    if (rows.length === 0) {
      result.push(...tableLines)
      tableLines = []
      return
    }

    const colCount = Math.max(...rows.map((row) => row.length))
    const wrappedRows: string[][][] = []

    for (const row of rows) {
      const isSeparator = row.every((cell) => /^-+$/.test(cell) || cell === '')
      const wrappedRow: string[][] = []

      for (let col = 0; col < colCount; col += 1) {
        const cell = row[col] ?? ''
        wrappedRow.push(isSeparator ? [cell] : wrapText(cell, MAX_CELL_WIDTH))
      }

      wrappedRows.push(wrappedRow)
    }

    const colWidths: number[] = []
    for (let col = 0; col < colCount; col += 1) {
      let maxWidth = 0
      for (const wrappedRow of wrappedRows) {
        const cellLines = wrappedRow[col] ?? ['']
        if (cellLines.length === 1 && /^-+$/.test(cellLines[0] ?? '')) {
          continue
        }
        for (const line of cellLines) {
          maxWidth = Math.max(maxWidth, line.length)
        }
      }
      colWidths.push(Math.min(maxWidth, MAX_CELL_WIDTH))
    }

    for (let rowIndex = 0; rowIndex < wrappedRows.length; rowIndex += 1) {
      const wrappedRow = wrappedRows[rowIndex] ?? []
      const rawRow = rows[rowIndex] ?? []
      const isSeparator = rawRow.every((cell) => /^-+$/.test(cell) || cell === '')

      if (isSeparator) {
        result.push(`| ${colWidths.map((width) => '-'.repeat(width)).join(' | ')} |`)
        continue
      }

      const maxLines = Math.max(...wrappedRow.map((cell) => cell.length))
      for (let lineIndex = 0; lineIndex < maxLines; lineIndex += 1) {
        const paddedCells = colWidths.map((width, col) => {
          const cellLines = wrappedRow[col] ?? ['']
          return (cellLines[lineIndex] ?? '').padEnd(width)
        })
        result.push(`| ${paddedCells.join(' | ')} |`)
      }
    }

    tableLines = []
  }

  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      tableLines.push(line)
      continue
    }

    flushTable()
    result.push(line)
  }

  flushTable()
  return result.join('\n')
}
