import { expect, test } from 'bun:test'

test('Playwright §19.3 visual suite passes', async () => {
  const packageRoot = new URL('../..', import.meta.url).pathname
  const env: Record<string, string | undefined> = { ...process.env }
  const subprocess = Bun.spawn({
    cmd: ['bunx', 'playwright', 'test'],
    cwd: packageRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    streamToText(subprocess.stdout),
    streamToText(subprocess.stderr),
    subprocess.exited,
  ])

  const output = [stdout, stderr].filter(Boolean).join('\n')
  console.log(output)

  expect(output).toContain('Running 7 tests')
  expect(exitCode).toBe(0)
}, 120_000)

async function streamToText(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text()
}
