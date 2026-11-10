// Explicit pre-push allowlist: new packages/tests are excluded until added here intentionally.
const fastSuiteArgs = [
  'test',
  'packages/agent-scope',
  'packages/agent-spaces',
  'packages/config',
  'packages/execution',
  'packages/harness-claude',
  'packages/harness-codex',
  'packages/harness-pi',
  'packages/harness-pi-sdk',
  'packages/hrc-core',
  'packages/hrc-events',
  'packages/hrc-sdk',
  'packages/runtime',
  'packages/cli/src/index.test.ts',
  'packages/cli/src/commands/agent/__tests__/build-bundle-ref-agent-project.test.ts',
]

const cleanEnv = { ...process.env }
cleanEnv.GIT_DIR = undefined
cleanEnv.GIT_WORK_TREE = undefined

const proc = Bun.spawn(['bun', ...fastSuiteArgs], {
  cwd: `${import.meta.dir}/..`,
  env: cleanEnv,
  stdin: 'inherit',
  stdout: 'inherit',
  stderr: 'inherit',
})

process.exit(await proc.exited)
