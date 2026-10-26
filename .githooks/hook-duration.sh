# Sourced after repository discovery. Never consume hook stdin for telemetry.
hook_timing_state=""
hook_timing_helper="$repo_root/scripts/hook-duration.ts"
if [ "${ACP_HOOK_TIMING_ACTIVE:-}" != "$hook_name" ] && command -v bun >/dev/null 2>&1; then
  hook_timing_state="$(bun "$hook_timing_helper" --start "$hook_name" </dev/null 2>/dev/null)" || hook_timing_state=""
  if [ -n "$hook_timing_state" ]; then
    ACP_HOOK_TIMING_ACTIVE="$hook_name"
    export ACP_HOOK_TIMING_ACTIVE
  fi
fi
hook_settled() {
  hook_exit_code=$?
  trap - 0
  if [ -n "$hook_timing_state" ]; then
    bun "$hook_timing_helper" --finish "$hook_timing_state" "$hook_exit_code" </dev/null >/dev/null 2>&1 || :
  fi
  if [ -n "${refs_file:-}" ]; then rm -f "$refs_file" || :; fi
  exit "$hook_exit_code"
}
trap hook_settled 0
