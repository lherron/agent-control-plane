#!/bin/bash

set -euo pipefail

readonly DEFAULT_MAX_BYTES=67108864
readonly DEFAULT_KEEP=7
readonly DEFAULT_LOG_DIR=/Users/lherron/praesidium/var/logs
readonly DEFAULT_LOCK_FILE=/Users/lherron/praesidium/var/run/praesidium-log-rotation.lock

usage() {
  cat <<'EOF'
Usage: rotate-praesidium-logs.sh [options] [log ...]

Copy-truncate launchd-managed logs without replacing their active inodes.

Options:
  --max-bytes N   Rotate files at or above N bytes (default: 67108864)
  --keep N        Retain N compressed archives per log (default: 7)
  --lock-file P   Kernel-backed lock file (default: var/run path)
  -h, --help      Show this help

With no log arguments, rotates ACP/HRC server stdout and stderr logs.
EOF
}

die() {
  printf 'rotate-praesidium-logs: %s\n' "$*" >&2
  exit 2
}

is_positive_integer() {
  [[ "$1" =~ ^[1-9][0-9]*$ ]]
}

file_size() {
  /usr/bin/stat -f '%z' "$1" 2>/dev/null || /usr/bin/stat -c '%s' "$1"
}

file_inode() {
  /usr/bin/stat -f '%i' "$1" 2>/dev/null || /usr/bin/stat -c '%i' "$1"
}

max_bytes="${PRAESIDIUM_LOG_ROTATION_MAX_BYTES:-$DEFAULT_MAX_BYTES}"
keep="${PRAESIDIUM_LOG_ROTATION_KEEP:-$DEFAULT_KEEP}"
lock_file="${PRAESIDIUM_LOG_ROTATION_LOCK_FILE:-$DEFAULT_LOCK_FILE}"
logs=()

while (($# > 0)); do
  case "$1" in
    --max-bytes)
      (($# >= 2)) || die '--max-bytes requires a value'
      max_bytes="$2"
      shift 2
      ;;
    --keep)
      (($# >= 2)) || die '--keep requires a value'
      keep="$2"
      shift 2
      ;;
    --lock-file)
      (($# >= 2)) || die '--lock-file requires a value'
      lock_file="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      logs+=("$@")
      break
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      logs+=("$1")
      shift
      ;;
  esac
done

is_positive_integer "$max_bytes" || die '--max-bytes must be a positive integer'
is_positive_integer "$keep" || die '--keep must be a positive integer'
[[ -n "$lock_file" ]] || die '--lock-file must not be empty'

if ((${#logs[@]} == 0)); then
  logs=(
    "$DEFAULT_LOG_DIR/hrc-server.log"
    "$DEFAULT_LOG_DIR/hrc-server.err.log"
    "$DEFAULT_LOG_DIR/acp-server.log"
    "$DEFAULT_LOG_DIR/acp-server.err.log"
  )
fi

# lockf owns a BSD advisory lock, not a presence-based lock. Keeping the inode
# avoids lock-order churn, while kernel ownership is released even on SIGKILL
# or host loss. A concurrent timer firing is an expected no-op, not an error.
if [[ "${PRAESIDIUM_LOG_ROTATION_LOCK_HELD:-0}" != 1 ]]; then
  /bin/mkdir -p "$(/usr/bin/dirname "$lock_file")"
  script_dir="$(cd "$(/usr/bin/dirname "$0")" && pwd -P)"
  script_path="$script_dir/$(/usr/bin/basename "$0")"
  set +e
  /usr/bin/lockf -s -t 0 -k "$lock_file" \
    /usr/bin/env PRAESIDIUM_LOG_ROTATION_LOCK_HELD=1 \
    /bin/bash "$script_path" \
    --max-bytes "$max_bytes" \
    --keep "$keep" \
    --lock-file "$lock_file" \
    -- "${logs[@]}"
  status=$?
  set -e
  [[ $status -eq 75 ]] && exit 0
  exit "$status"
fi

umask 077

prune_archives() {
  local path="$1"
  local archives=()
  local candidate
  local index=0

  archives=("$path".*.gz)
  [[ -e "${archives[0]}" ]] || return 0

  while IFS= read -r candidate; do
    archives[$index]="$candidate"
    index=$((index + 1))
  done < <(/usr/bin/printf '%s\n' "${archives[@]}" | LC_ALL=C /usr/bin/sort -r)

  for ((index = keep; index < ${#archives[@]}; index++)); do
    /bin/rm -f -- "${archives[$index]}"
  done
}

rotate_log() {
  local path="$1"
  local size
  local before_inode
  local after_inode
  local timestamp
  local staging
  local archive

  [[ -e "$path" ]] || return 0
  [[ -f "$path" && ! -L "$path" ]] || die "refusing non-regular log: $path"

  size="$(file_size "$path")"
  ((size >= max_bytes)) || return 0

  before_inode="$(file_inode "$path")"
  timestamp="$(/bin/date -u '+%Y%m%dT%H%M%SZ')"
  staging="$path.$timestamp.$$.staging"
  archive="$path.$timestamp.$$.gz"

  /bin/cp -p "$path" "$staging"
  if ! /usr/bin/truncate -s 0 "$path"; then
    /bin/rm -f -- "$staging"
    die "failed to truncate active log: $path"
  fi

  after_inode="$(file_inode "$path")"
  if [[ "$before_inode" != "$after_inode" ]]; then
    die "active inode changed during rotation: $path"
  fi

  if ! /usr/bin/gzip -9 "$staging"; then
    /bin/mv "$staging" "$path.$timestamp.$$.uncompressed"
    die "compression failed; preserved uncompressed archive for $path"
  fi
  /bin/mv "$staging.gz" "$archive"
  prune_archives "$path"

  printf 'rotated path=%s bytes=%s inode=%s archive=%s\n' \
    "$path" "$size" "$after_inode" "$archive"
}

for log in "${logs[@]}"; do
  rotate_log "$log"
done
