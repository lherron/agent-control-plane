export function ageLabel(ts?: string): string {
  if (!ts) return 'no events'
  const delta = Math.max(0, Date.now() - Date.parse(ts))
  if (delta < 60_000) return `${Math.round(delta / 1_000)}s`
  return `${Math.round(delta / 60_000)}m`
}

export function clockLabel(ts?: string): string {
  if (!ts) return '--:--:--'
  const date = new Date(ts)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  return date.toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

export function durationLabel(ts?: string): string {
  if (!ts) return '00:00:00'
  const delta = Math.max(0, Date.now() - Date.parse(ts))
  const totalSeconds = Math.floor(delta / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
}
