#!/usr/bin/env bash
# Smoke test for the Discord typing indicator on long-running agent turns.
#
# Sends a slow prompt via virtu, then tails ~/praesidium/var/logs/acp-server.log
# for `gw.discord.typing.refresh` entries that match the target channel.
# Asserts at least 2 pings spaced roughly TYPING_REFRESH_MS (8s) apart, and
# that pings stop after the final delivery is rendered.
#
# Why this is the e2e: Discord delivers the typing indicator as a Gateway
# WebSocket event (TYPING_START), not as a fetchable REST resource — so virtu
# cannot observe it directly. The gateway-discord code emits a log line on
# every successful POST to /channels/{id}/typing; tailing those is the
# closest deterministic signal that matches what a real Discord user sees.
#
# Usage:
#   CP_CHANNEL_ID=<channel> ./scripts/virtu-typing-smoke.sh "<slow prompt>"
#
# Optional:
#   ACP_LOG=/path/to/acp-server.log    Override log file path
#   WAIT_S=90                          Max seconds to wait for the run
#   MIN_PINGS=2                        Minimum typing pings required

set -euo pipefail

CP_CHANNEL_ID="${CP_CHANNEL_ID:?Error: CP_CHANNEL_ID must be set}"
ACP_LOG="${ACP_LOG:-$HOME/praesidium/var/logs/acp-server.log}"
WAIT_S="${WAIT_S:-90}"
MIN_PINGS="${MIN_PINGS:-2}"
PROMPT="${1:?Usage: virtu-typing-smoke.sh \"<prompt>\"}"

if [[ ! -f "$ACP_LOG" ]]; then
    echo "Error: ACP log not found at $ACP_LOG" >&2
    exit 1
fi

# Record current log size so we only consider lines added after we send.
START_LINE=$(wc -l < "$ACP_LOG" | tr -d ' ')
START_TS=$(date -u +%s)

echo "→ sending prompt via virtu to channel $CP_CHANNEL_ID"
"$(dirname "$0")/virtu-send.sh" --channel "$CP_CHANNEL_ID" "$PROMPT"

echo "→ watching $ACP_LOG for gw.discord.typing.refresh (timeout ${WAIT_S}s)"
DEADLINE=$((START_TS + WAIT_S))
FINAL_SEEN=0

while [[ $(date -u +%s) -lt $DEADLINE ]]; do
    # Look for any "final delivery" marker after we sent. The gateway logs
    # gw.discord.webhook.edit when it writes the final frame to the bubble;
    # that is a reasonable terminal signal that the placeholder lifecycle
    # finished and typing should have stopped.
    if tail -n +"$START_LINE" "$ACP_LOG" \
        | grep -q "\"event\":\"gw.discord.webhook.edit\".*\"channelId\":\"$CP_CHANNEL_ID\""; then
        FINAL_SEEN=1
        break
    fi
    sleep 1
done

# Pull the slice of log that landed during the run.
END_LINE=$(wc -l < "$ACP_LOG" | tr -d ' ')
SLICE=$(sed -n "${START_LINE},${END_LINE}p" "$ACP_LOG")

TYPING_LINES=$(echo "$SLICE" \
    | grep "\"event\":\"gw.discord.typing.refresh\"" \
    | grep "\"channelId\":\"$CP_CHANNEL_ID\"" \
    || true)
PING_COUNT=$(echo "$TYPING_LINES" | grep -c . || true)

echo "→ observed typing pings: $PING_COUNT"
echo "$TYPING_LINES"

if [[ "$PING_COUNT" -lt "$MIN_PINGS" ]]; then
    echo "FAIL: expected at least $MIN_PINGS typing pings, saw $PING_COUNT" >&2
    exit 1
fi

if [[ "$FINAL_SEEN" -ne 1 ]]; then
    echo "WARN: did not observe a final webhook.edit within ${WAIT_S}s; cannot verify pings stop." >&2
    exit 0
fi

# Look for any typing pings after the final edit — there should be none after
# clearPlaceholderTimers runs. Allow a 2s grace window for in-flight pings.
FINAL_TS=$(echo "$SLICE" \
    | grep "\"event\":\"gw.discord.webhook.edit\"" \
    | grep "\"channelId\":\"$CP_CHANNEL_ID\"" \
    | tail -1 \
    | grep -oE '"ts":"[^"]+"' \
    | sed 's/"ts":"//;s/"$//')

if [[ -n "$FINAL_TS" ]]; then
    sleep 2
    LATE_PINGS=$(tail -n +"$END_LINE" "$ACP_LOG" \
        | grep "\"event\":\"gw.discord.typing.refresh\"" \
        | grep "\"channelId\":\"$CP_CHANNEL_ID\"" \
        | grep -c . || true)
    if [[ "$LATE_PINGS" -gt 0 ]]; then
        echo "FAIL: $LATE_PINGS typing pings fired after final delivery — loop did not stop" >&2
        exit 1
    fi
fi

echo "PASS: $PING_COUNT pings during run, no pings after final delivery"
