"""Python port of the injector's writable SQLite store.

A line-for-line port of `packages/hrc-injector-core/src`:
`injector-state-store.ts` (open, schema, drive diagnostics, launch failures),
`mail/delivery-repository.ts`, `mail/delivery-row-mappers.ts` and
`wrkq/ledger-cursor-repository.ts`. Same tables, columns, values and
transactions; SQL text is copied. Method names are the TypeScript names in
snake_case; object inputs become keyword arguments.

The connection is in autocommit mode. Each single-statement write commits on
its own, as `bun:sqlite` does; the two multi-statement writes the TypeScript
runs under `.transaction(...).immediate()` run under `BEGIN IMMEDIATE` here.

Clock reads match the TypeScript's `new Date()` calls one for one, in the same
argument-evaluation order, so an injected ticking clock yields the same
timestamps. Timestamps have `Date.prototype.toISOString()` form.

The one-time import from the old private kicker store is not ported: this
store opens a database the injector already imported.
"""

from __future__ import annotations

import json
import math
import os
import sqlite3
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, Callable

Clock = Callable[[], datetime]

WRKQ_ENVELOPE_STREAM = 'envelope'
_MAX_SAFE_INTEGER = 2 ** 53 - 1


def system_clock() -> datetime:
    return datetime.now(timezone.utc)


def iso_timestamp(moment: datetime) -> str:
    """`Date.prototype.toISOString()`: UTC, milliseconds (truncated), `Z`."""
    if moment.tzinfo is None:
        raise ValueError('clock must return a timezone-aware datetime')
    utc = moment.astimezone(timezone.utc)
    return (f'{utc.year:04d}-{utc.month:02d}-{utc.day:02d}T{utc.hour:02d}:{utc.minute:02d}:'
            f'{utc.second:02d}.{utc.microsecond // 1000:03d}Z')


def normalize_target(target_session_ref: str) -> str:
    """`normalizeTarget` from delivery-row-mappers.ts."""
    target = target_session_ref.strip(_JS_WHITESPACE)
    if len(target) == 0:
        raise ValueError('targetSessionRef must be a non-empty string')
    return target


# String.prototype.trim() strips WhiteSpace and LineTerminator code points.
_JS_WHITESPACE = ('\u0009\u000a\u000b\u000c\u000d       '
                  '           　﻿')


# ── Records ──────────────────────────────────────────────────────────────────
# None means the TypeScript mapper omitted the key (SQL NULL).

@dataclass(frozen=True)
class DeliveryIntent:
    envelope_id: str
    target_session_ref: str
    door: str
    form: str
    presentation_id: str
    submitted_hrc_seq: int
    submitted_at: str
    updated_at: str
    runtime_id: str | None = None
    submission_id: str | None = None
    host_session_id: str | None = None
    generation: int | None = None
    delivery_outcome: str | None = None
    invocation_id: str | None = None
    broker_after_seq: int | None = None
    uncertain_cause: str | None = None
    uncertain_at: str | None = None
    last_evidence_kind: str | None = None
    last_evidence_at: str | None = None
    terminal_envelope_cause: str | None = None
    terminal_envelope_at: str | None = None
    cleanup_outcome: str | None = None
    cleanup_at: str | None = None


@dataclass(frozen=True)
class PresentationRecord:
    envelope_id: str
    runtime_id: str
    target_session_ref: str
    presentation_id: str
    delivery_outcome: str
    landing_hrc_seq: int
    landed_at: str
    generation: int | None = None
    input_id: str | None = None
    receipt_committed_at: str | None = None
    turn_ended_at: str | None = None
    reminder_armed_at: str | None = None
    reminder_due_at: str | None = None
    reminder_landing_hrc_seq: int | None = None
    reminder_landed_at: str | None = None
    disposed_at: str | None = None
    disposition: str | None = None


@dataclass(frozen=True)
class PresentationWrite:
    recorded: bool
    presentation: PresentationRecord


@dataclass(frozen=True)
class RuntimeBoundTarget:
    target_session_ref: str
    runtime_id: str


@dataclass(frozen=True)
class BirthRefusal:
    target_session_ref: str
    scope_ref: str
    refusals: int
    created_at: str
    updated_at: str
    last_reason: str | None = None
    resolved_at: str | None = None


@dataclass(frozen=True)
class FailureNotice:
    envelope_id: str
    target_session_ref: str
    notice: str
    created_at: str
    delivered_at: str | None = None


@dataclass(frozen=True)
class DriveDiagnostic:
    """Every field is present; None is the TypeScript's explicit null."""
    envelope_id: str
    drive_attempt_id: str
    target_session_ref: str
    wake_reason: str
    outcome: str
    observed_seat_state: str | None
    runtime_id: str | None
    invocation_id: str | None
    diagnostic: Any
    prior_drive_attempt_id: str | None
    recovered_at: str | None
    created_at: str


@dataclass(frozen=True)
class LaunchFailure:
    attempts: int
    last_error: str
    participant_host_since_ms: int | None = None


# ── Row mappers ──────────────────────────────────────────────────────────────

INTENT_COLUMNS = """
  envelope_id, target_session_ref, door, form, presentation_id, runtime_id,
  submission_id, host_session_id, generation, delivery_outcome,
  submitted_hrc_seq, submitted_at, updated_at, invocation_id, broker_after_seq,
  uncertain_cause, uncertain_at, last_evidence_kind, last_evidence_at,
  terminal_envelope_cause, terminal_envelope_at, cleanup_outcome, cleanup_at
"""

PRESENTATION_COLUMNS = """
  envelope_id, runtime_id, target_session_ref, generation, presentation_id,
  input_id, delivery_outcome, landing_hrc_seq, landed_at, receipt_committed_at, turn_ended_at,
  reminder_armed_at, reminder_due_at, reminder_landing_hrc_seq,
  reminder_landed_at, disposed_at, disposition
"""


def _map(cls, row):
    return cls(**{key: row[key] for key in row.keys()})


def map_intent(row) -> DeliveryIntent:
    return _map(DeliveryIntent, row)


def map_presentation(row) -> PresentationRecord:
    return _map(PresentationRecord, row)


def map_birth_refusal(row) -> BirthRefusal:
    return _map(BirthRefusal, row)


def map_failure_notice(row) -> FailureNotice:
    return _map(FailureNotice, row)


def _nullish(value, fallback):
    """JavaScript `value ?? fallback`."""
    return fallback if value is None else value


class _Db:
    def __init__(self, connection: sqlite3.Connection, clock: Clock):
        self.connection = connection
        self._clock = clock

    def now(self) -> str:
        return iso_timestamp(self._clock())

    def all(self, sql, params=()):
        return self.connection.execute(sql, params).fetchall()

    def get(self, sql, params=()):
        rows = self.all(sql, params)
        return rows[0] if rows else None

    def run(self, sql, params=()) -> int:
        """Run one statement to completion and return its change count."""
        cursor = self.connection.execute(sql, params)
        cursor.fetchall()
        return cursor.rowcount

    def immediate(self, operation):
        """`db.transaction(operation).immediate()`."""
        self.connection.execute('BEGIN IMMEDIATE')
        try:
            result = operation()
        except BaseException:
            self.connection.execute('ROLLBACK')
            raise
        self.connection.execute('COMMIT')
        return result


# ── Delivery repository ──────────────────────────────────────────────────────

class HrcMailDeliveryRepository:
    def __init__(self, db: _Db):
        self._db = db

    # Write-ahead delivery intents

    def open_intent(self, *, envelope_id: str, target_session_ref: str, door: str, form: str,
                    presentation_id: str, submitted_hrc_seq: int, runtime_id: str | None = None,
                    host_session_id: str | None = None, generation: int | None = None,
                    delivery_outcome: str | None = None, invocation_id: str | None = None,
                    broker_after_seq: int | None = None) -> DeliveryIntent | None:
        now = self._db.now()
        changes = self._db.run(
            """INSERT OR IGNORE INTO hrcmail_delivery_intents (
           envelope_id, target_session_ref, door, form, presentation_id, runtime_id,
           submission_id, host_session_id, generation, delivery_outcome,
           submitted_hrc_seq, submitted_at, updated_at, invocation_id, broker_after_seq
         ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)""",
            (envelope_id, normalize_target(target_session_ref), door, form, presentation_id,
             runtime_id, host_session_id, generation, delivery_outcome, submitted_hrc_seq,
             now, now, invocation_id, broker_after_seq))
        return self.get_intent(envelope_id) if changes > 0 else None

    def get_intent(self, envelope_id: str) -> DeliveryIntent | None:
        row = self._db.get(
            f'SELECT {INTENT_COLUMNS} FROM hrcmail_delivery_intents WHERE envelope_id = ?',
            (envelope_id,))
        return None if row is None else map_intent(row)

    def attach_admission(self, envelope_id: str, *, door: str | None = None,
                         submission_id: str | None = None, runtime_id: str | None = None,
                         host_session_id: str | None = None, generation: int | None = None,
                         delivery_outcome: str | None = None) -> DeliveryIntent | None:
        existing = self.get_intent(envelope_id)
        if existing is None:
            return None
        self._db.run(
            """UPDATE hrcmail_delivery_intents
            SET door = ?, submission_id = ?, runtime_id = ?, host_session_id = ?,
                generation = ?, delivery_outcome = ?, updated_at = ?
          WHERE envelope_id = ?""",
            (_nullish(door, existing.door),
             _nullish(submission_id, existing.submission_id),
             _nullish(runtime_id, existing.runtime_id),
             _nullish(host_session_id, existing.host_session_id),
             _nullish(generation, existing.generation),
             _nullish(delivery_outcome, existing.delivery_outcome),
             self._db.now(),
             envelope_id))
        return self.get_intent(envelope_id)

    def clear_intent(self, envelope_id: str) -> bool:
        return self._db.run('DELETE FROM hrcmail_delivery_intents WHERE envelope_id = ?',
                            (envelope_id,)) > 0

    def list_open_intents(self, target_session_ref: str | None = None) -> list[DeliveryIntent]:
        if target_session_ref is None:
            rows = self._db.all(
                f"""SELECT {INTENT_COLUMNS} FROM hrcmail_delivery_intents
                ORDER BY submitted_at ASC, envelope_id ASC""")
        else:
            rows = self._db.all(
                f"""SELECT {INTENT_COLUMNS} FROM hrcmail_delivery_intents
                WHERE target_session_ref = ?
                ORDER BY submitted_at ASC, envelope_id ASC""",
                (normalize_target(target_session_ref),))
        return [map_intent(row) for row in rows]

    def list_active_open_intents(self, target_session_ref: str | None = None) -> list[DeliveryIntent]:
        return [intent for intent in self.list_open_intents(target_session_ref)
                if intent.terminal_envelope_at is None]

    def mark_uncertain(self, envelope_id: str, cause: str,
                       evidence_kind: str | None = None) -> DeliveryIntent | None:
        self._db.run(
            'UPDATE hrcmail_delivery_intents SET uncertain_cause = ?, uncertain_at = COALESCE(uncertain_at, ?), last_evidence_kind = COALESCE(?, last_evidence_kind), last_evidence_at = ?, updated_at = ? WHERE envelope_id = ?',
            (cause, self._db.now(), evidence_kind, self._db.now(), self._db.now(), envelope_id))
        return self.get_intent(envelope_id)

    def mark_terminal_envelope(self, envelope_id: str, cause: str) -> DeliveryIntent | None:
        now = self._db.now()
        self._db.run(
            'UPDATE hrcmail_delivery_intents SET terminal_envelope_cause = ?, terminal_envelope_at = COALESCE(terminal_envelope_at, ?), updated_at = ? WHERE envelope_id = ?',
            (cause, now, now, envelope_id))
        return self.get_intent(envelope_id)

    def record_terminal_cleanup(self, envelope_id: str, outcome: str) -> DeliveryIntent | None:
        now = self._db.now()
        self._db.run(
            'UPDATE hrcmail_delivery_intents SET cleanup_outcome = COALESCE(cleanup_outcome, ?), cleanup_at = COALESCE(cleanup_at, ?), updated_at = ? WHERE envelope_id = ?',
            (outcome, now, now, envelope_id))
        return self.get_intent(envelope_id)

    def get_intent_by_submission_id(self, submission_id: str) -> DeliveryIntent | None:
        row = self._db.get(
            f'SELECT {INTENT_COLUMNS} FROM hrcmail_delivery_intents WHERE submission_id = ?',
            (submission_id,))
        return None if row is None else map_intent(row)

    def list_launch_intents_for_runtime(self, runtime_id: str) -> list[DeliveryIntent]:
        return [map_intent(row) for row in self._db.all(
            f"""SELECT {INTENT_COLUMNS} FROM hrcmail_delivery_intents
          WHERE runtime_id = ? AND door = 'launch'
          ORDER BY submitted_at ASC, envelope_id ASC""", (runtime_id,))]

    def list_intent_targets(self) -> list[str]:
        return [row['target_session_ref'] for row in self._db.all(
            """SELECT DISTINCT target_session_ref FROM hrcmail_delivery_intents
          WHERE terminal_envelope_at IS NULL
          ORDER BY target_session_ref ASC""")]

    def list_expired_intents(self, before: str) -> list[DeliveryIntent]:
        return [map_intent(row) for row in self._db.all(
            f"""SELECT {INTENT_COLUMNS} FROM hrcmail_delivery_intents
          WHERE submitted_at <= ? AND terminal_envelope_at IS NULL
          ORDER BY submitted_at ASC, envelope_id ASC""", (before,))]

    # Presentation records

    def record_presentation(self, *, envelope_id: str, runtime_id: str, target_session_ref: str,
                            presentation_id: str, delivery_outcome: str, landing_hrc_seq: int,
                            generation: int | None = None,
                            input_id: str | None = None) -> PresentationWrite:
        def operation():
            existing = self.get_presentation(envelope_id, runtime_id)
            if existing is not None and existing.landing_hrc_seq >= landing_hrc_seq:
                return PresentationWrite(recorded=False, presentation=existing)
            now = self._db.now()
            self._db.run(
                """INSERT INTO hrcmail_presentations (
               envelope_id, runtime_id, target_session_ref, generation, presentation_id,
               input_id, delivery_outcome, landing_hrc_seq, landed_at, receipt_committed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
             ON CONFLICT(envelope_id, runtime_id) DO UPDATE SET
               target_session_ref = excluded.target_session_ref,
               generation = excluded.generation,
               presentation_id = excluded.presentation_id,
               input_id = excluded.input_id,
               delivery_outcome = excluded.delivery_outcome,
               landing_hrc_seq = excluded.landing_hrc_seq,
               landed_at = excluded.landed_at,
               receipt_committed_at = NULL,
               turn_ended_at = NULL,
               reminder_armed_at = NULL,
               reminder_due_at = NULL,
               reminder_landing_hrc_seq = NULL,
               reminder_landed_at = NULL,
               disposed_at = NULL,
               disposition = NULL""",
                (envelope_id, runtime_id, normalize_target(target_session_ref), generation,
                 presentation_id, input_id, delivery_outcome, landing_hrc_seq, now))
            presentation = self.get_presentation(envelope_id, runtime_id)
            if presentation is None:
                raise RuntimeError(f'failed to reload presentation {envelope_id}')
            return PresentationWrite(recorded=True, presentation=presentation)

        return self._db.immediate(operation)

    def get_presentation(self, envelope_id: str, runtime_id: str) -> PresentationRecord | None:
        row = self._db.get(
            f"""SELECT {PRESENTATION_COLUMNS} FROM hrcmail_presentations
          WHERE envelope_id = ? AND runtime_id = ?""", (envelope_id, runtime_id))
        return None if row is None else map_presentation(row)

    def mark_receipt_committed(self, envelope_id: str, runtime_id: str) -> bool:
        return self._db.run(
            'UPDATE hrcmail_presentations SET receipt_committed_at = COALESCE(receipt_committed_at, ?) WHERE envelope_id = ? AND runtime_id = ?',
            (self._db.now(), envelope_id, runtime_id)) > 0

    def presentations_for_envelope(self, envelope_id: str) -> list[PresentationRecord]:
        return [map_presentation(row) for row in self._db.all(
            f"""SELECT {PRESENTATION_COLUMNS} FROM hrcmail_presentations
          WHERE envelope_id = ?
          ORDER BY landed_at ASC, runtime_id ASC""", (envelope_id,))]

    def presentations_for_runtime(self, runtime_id: str) -> list[PresentationRecord]:
        return [map_presentation(row) for row in self._db.all(
            f"""SELECT {PRESENTATION_COLUMNS} FROM hrcmail_presentations
          WHERE runtime_id = ?
          ORDER BY landed_at ASC, envelope_id ASC""", (runtime_id,))]

    def presentations_for_target(self, target_session_ref: str,
                                 limit: int = 50) -> list[PresentationRecord]:
        return [map_presentation(row) for row in self._db.all(
            f"""SELECT {PRESENTATION_COLUMNS} FROM hrcmail_presentations
          WHERE target_session_ref = ?
          ORDER BY landed_at DESC, envelope_id ASC
          LIMIT ?""", (normalize_target(target_session_ref), limit))]

    def list_undisposed_for_runtime(self, runtime_id: str) -> list[PresentationRecord]:
        return [map_presentation(row) for row in self._db.all(
            f"""SELECT {PRESENTATION_COLUMNS} FROM hrcmail_presentations
          WHERE runtime_id = ? AND disposed_at IS NULL AND receipt_committed_at IS NOT NULL
          ORDER BY landing_hrc_seq ASC, envelope_id ASC""", (runtime_id,))]

    def list_undisposed_presentations(self, limit: int = 500) -> list[PresentationRecord]:
        return [map_presentation(row) for row in self._db.all(
            f"""SELECT {PRESENTATION_COLUMNS} FROM hrcmail_presentations
          WHERE disposed_at IS NULL AND receipt_committed_at IS NOT NULL
          ORDER BY landed_at ASC, envelope_id ASC
          LIMIT ?""", (limit,))]

    def list_runtime_bound_targets(self, since: str) -> list[RuntimeBoundTarget]:
        return [RuntimeBoundTarget(row['target_session_ref'], row['runtime_id'])
                for row in self._db.all(
                    """SELECT DISTINCT target_session_ref, runtime_id
           FROM hrcmail_presentations
          WHERE landed_at >= ?
          ORDER BY target_session_ref ASC, runtime_id ASC""", (since,))]

    def arm_reminder(self, *, envelope_id: str, runtime_id: str, turn_ended_at: str,
                     remind_at: str) -> bool:
        return self._db.run(
            """UPDATE hrcmail_presentations
              SET reminder_armed_at = ?, reminder_due_at = ?, turn_ended_at = ?
            WHERE envelope_id = ? AND runtime_id = ?
              AND disposed_at IS NULL AND receipt_committed_at IS NOT NULL AND reminder_armed_at IS NULL""",
            (self._db.now(), remind_at, turn_ended_at, envelope_id, runtime_id)) > 0

    def list_due_reminders(self, target_session_ref: str, now: str) -> list[PresentationRecord]:
        return [map_presentation(row) for row in self._db.all(
            f"""SELECT {PRESENTATION_COLUMNS} FROM hrcmail_presentations
          WHERE target_session_ref = ?
            AND disposed_at IS NULL AND receipt_committed_at IS NOT NULL
            AND reminder_due_at IS NOT NULL
            AND reminder_due_at <= ?
            AND reminder_landing_hrc_seq IS NULL
          ORDER BY reminder_due_at ASC, envelope_id ASC""",
            (normalize_target(target_session_ref), now))]

    def list_due_reminder_targets(self, now: str) -> list[str]:
        return [row['target_session_ref'] for row in self._db.all(
            """SELECT DISTINCT target_session_ref FROM hrcmail_presentations
          WHERE disposed_at IS NULL AND receipt_committed_at IS NOT NULL
            AND reminder_due_at IS NOT NULL
            AND reminder_due_at <= ?
            AND reminder_landing_hrc_seq IS NULL
          ORDER BY target_session_ref ASC""", (now,))]

    def record_reminder_landing(self, envelope_id: str, runtime_id: str,
                                landing_hrc_seq: int) -> bool:
        return self._db.run(
            """UPDATE hrcmail_presentations
              SET reminder_landing_hrc_seq = ?, reminder_landed_at = ?
            WHERE envelope_id = ? AND runtime_id = ?
              AND reminder_landing_hrc_seq IS NULL""",
            (landing_hrc_seq, self._db.now(), envelope_id, runtime_id)) > 0

    def retire_reminder(self, envelope_id: str, runtime_id: str) -> bool:
        return self._db.run(
            """UPDATE hrcmail_presentations
              SET reminder_due_at = NULL
            WHERE envelope_id = ? AND runtime_id = ?
              AND reminder_due_at IS NOT NULL AND reminder_landing_hrc_seq IS NULL""",
            (envelope_id, runtime_id)) > 0

    def record_disposition(self, envelope_id: str, runtime_id: str, disposition: str) -> bool:
        return self._db.run(
            """UPDATE hrcmail_presentations
              SET disposed_at = ?, disposition = ?
            WHERE envelope_id = ? AND runtime_id = ? AND disposed_at IS NULL""",
            (self._db.now(), disposition, envelope_id, runtime_id)) > 0

    def count_pre_migration_unknown_presentations(self) -> int:
        row = self._db.get(
            """SELECT COUNT(*) AS count FROM hrcmail_presentations
            WHERE disposition = 'pre_migration_unknown'""")
        return 0 if row is None else _nullish(row['count'], 0)

    # Non-landing accounting

    def record_non_landing_strike(self, envelope_id: str, runtime_id: str) -> int:
        now = self._db.now()
        self._db.run(
            """INSERT INTO hrcmail_delivery_expiries (
           envelope_id, runtime_id, expiries, first_expired_at, last_expired_at
         ) VALUES (?, ?, 1, ?, ?)
         ON CONFLICT(envelope_id, runtime_id) DO UPDATE SET
           expiries = hrcmail_delivery_expiries.expiries + 1,
           last_expired_at = excluded.last_expired_at""",
            (envelope_id, runtime_id, now, now))
        return self.non_landing_strikes(envelope_id, runtime_id)

    def clear_non_landing_strikes(self, envelope_id: str) -> None:
        self._db.run('DELETE FROM hrcmail_delivery_expiries WHERE envelope_id = ?', (envelope_id,))

    def non_landing_strikes(self, envelope_id: str, runtime_id: str) -> int:
        row = self._db.get(
            """SELECT expiries FROM hrcmail_delivery_expiries
            WHERE envelope_id = ? AND runtime_id = ?""", (envelope_id, runtime_id))
        return 0 if row is None else _nullish(row['expiries'], 0)

    def open_refusal_window(self, envelope_id: str, runtime_id: str, at: str | None = None) -> str:
        if at is None:
            at = self._db.now()
        self._db.run(
            """INSERT INTO hrcmail_delivery_expiries (
           envelope_id, runtime_id, expiries, first_expired_at, last_expired_at,
           refusal_window_opened_at
         ) VALUES (?, ?, 0, ?, ?, ?)
         ON CONFLICT(envelope_id, runtime_id) DO UPDATE SET
           refusal_window_opened_at =
             COALESCE(hrcmail_delivery_expiries.refusal_window_opened_at, excluded.refusal_window_opened_at)""",
            (envelope_id, runtime_id, at, at, at))
        return _nullish(self.refusal_window_opened_at(envelope_id, runtime_id), at)

    def refusal_window_opened_at(self, envelope_id: str, runtime_id: str) -> str | None:
        row = self._db.get(
            """SELECT refusal_window_opened_at FROM hrcmail_delivery_expiries
            WHERE envelope_id = ? AND runtime_id = ?""", (envelope_id, runtime_id))
        return None if row is None else row['refusal_window_opened_at']

    def close_refusal_window(self, envelope_id: str, runtime_id: str) -> None:
        self._db.run(
            """UPDATE hrcmail_delivery_expiries SET refusal_window_opened_at = NULL
          WHERE envelope_id = ? AND runtime_id = ?""", (envelope_id, runtime_id))

    # Birth refusals

    def record_birth_refusal(self, *, target_session_ref: str, scope_ref: str,
                             reason: str) -> BirthRefusal | None:
        now = self._db.now()
        self._db.run(
            """INSERT INTO hrcmail_birth_refusals (
           target_session_ref, scope_ref, refusals, last_reason, resolved_at,
           created_at, updated_at
         ) VALUES (?, ?, 1, ?, NULL, ?, ?)
         ON CONFLICT(target_session_ref) DO UPDATE SET
           scope_ref = excluded.scope_ref,
           refusals = hrcmail_birth_refusals.refusals + 1,
           last_reason = excluded.last_reason,
           resolved_at = NULL,
           updated_at = excluded.updated_at""",
            (normalize_target(target_session_ref), scope_ref, reason, now, now))
        return self.get_birth_refusal(target_session_ref)

    def get_birth_refusal(self, target_session_ref: str) -> BirthRefusal | None:
        row = self._db.get(
            """SELECT target_session_ref, scope_ref, refusals, last_reason, resolved_at,
                created_at, updated_at
           FROM hrcmail_birth_refusals WHERE target_session_ref = ?""",
            (normalize_target(target_session_ref),))
        return None if row is None else map_birth_refusal(row)

    def list_refused_birth_targets(self) -> list[str]:
        return [row['target_session_ref'] for row in self._db.all(
            """SELECT target_session_ref FROM hrcmail_birth_refusals
          WHERE resolved_at IS NULL
          ORDER BY target_session_ref ASC""")]

    def resolve_birth_refusal(self, target_session_ref: str, reason: str) -> bool:
        resolved_at = self._db.now()
        updated_at = self._db.now()
        return self._db.run(
            """UPDATE hrcmail_birth_refusals
              SET resolved_at = ?, last_reason = ?, updated_at = ?
            WHERE target_session_ref = ? AND resolved_at IS NULL""",
            (resolved_at, reason, updated_at, normalize_target(target_session_ref))) > 0

    # §5 sender-side failure notices

    def record_failure_notice(self, *, envelope_id: str, target_session_ref: str,
                              notice: str) -> bool:
        target = normalize_target(target_session_ref)
        return self._db.run(
            """INSERT OR IGNORE INTO hrcmail_failure_notices (
             envelope_id, target_session_ref, notice, created_at
           ) VALUES (?, ?, ?, ?)""",
            (envelope_id, target, notice, self._db.now())) > 0

    def list_undelivered_failure_notices(self, target_session_ref: str) -> list[FailureNotice]:
        return [map_failure_notice(row) for row in self._db.all(
            """SELECT envelope_id, target_session_ref, notice, created_at, delivered_at
           FROM hrcmail_failure_notices
          WHERE target_session_ref = ? AND delivered_at IS NULL
          ORDER BY created_at ASC, envelope_id ASC""", (normalize_target(target_session_ref),))]

    def list_failure_notice_targets(self) -> list[str]:
        return [row['target_session_ref'] for row in self._db.all(
            """SELECT DISTINCT target_session_ref FROM hrcmail_failure_notices
          WHERE delivered_at IS NULL
          ORDER BY target_session_ref ASC""")]

    def mark_failure_notices_delivered(self, target_session_ref: str,
                                       envelope_ids: list[str]) -> None:
        if len(envelope_ids) == 0:
            return None
        now = self._db.now()
        target = normalize_target(target_session_ref)

        def operation():
            for envelope_id in envelope_ids:
                self._db.run(
                    """UPDATE hrcmail_failure_notices
                  SET delivered_at = ?
                WHERE envelope_id = ? AND target_session_ref = ? AND delivered_at IS NULL""",
                    (now, envelope_id, target))

        self._db.immediate(operation)
        return None

    def failure_notices_for_envelope(self, envelope_id: str) -> list[FailureNotice]:
        return [map_failure_notice(row) for row in self._db.all(
            """SELECT envelope_id, target_session_ref, notice, created_at, delivered_at
           FROM hrcmail_failure_notices
          WHERE envelope_id = ?
          ORDER BY created_at ASC, target_session_ref ASC""", (envelope_id,))]


# ── wrkq ledger cursors ──────────────────────────────────────────────────────

def _is_safe_integer(value) -> bool:
    """JavaScript `Number.isSafeInteger`."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    if isinstance(value, float) and (not math.isfinite(value) or not value.is_integer()):
        return False
    return abs(value) <= _MAX_SAFE_INTEGER


class WrkqLedgerCursorRepository:
    def __init__(self, db: _Db):
        self._db = db

    def get(self, stream: str = WRKQ_ENVELOPE_STREAM) -> int | None:
        row = self._db.get('SELECT high_water FROM wrkq_ledger_cursors WHERE stream = ?', (stream,))
        return None if row is None else row['high_water']

    def advance(self, high_water: int, stream: str = WRKQ_ENVELOPE_STREAM) -> int:
        if not _is_safe_integer(high_water) or high_water < 0:
            raise ValueError('wrkq ledger high water must be a non-negative integer')
        high_water = int(high_water)
        now = self._db.now()
        self._db.run(
            """INSERT INTO wrkq_ledger_cursors (stream, high_water, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(stream) DO UPDATE SET
           high_water = MAX(wrkq_ledger_cursors.high_water, excluded.high_water),
           updated_at = excluded.updated_at""", (stream, high_water, now))
        return _nullish(self.get(stream), high_water)


# ── Drive diagnostics ────────────────────────────────────────────────────────

def _js_json_parse(text):
    """`JSON.parse`, which refuses the NaN/Infinity literals Python accepts."""
    def refuse(name):
        raise ValueError(f'invalid JSON literal {name}')
    return json.loads(text, parse_constant=refuse)


def _js_json_stringify(value) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), allow_nan=False)


class DriveDiagnostics:
    def __init__(self, db: _Db):
        self._db = db

    def latest(self, envelope_id: str) -> DriveDiagnostic | None:
        row = self._db.get('SELECT * FROM hrcmail_drive_diagnostics WHERE envelope_id = ?',
                           (envelope_id,))
        if row is None:
            return None
        diagnostic = None
        try:
            if row['diagnostic_json'] is not None:
                diagnostic = _js_json_parse(row['diagnostic_json'])
        except (ValueError, TypeError):
            # A legacy/corrupt evidence row is not delivery authority; expose it as absent.
            pass
        return DriveDiagnostic(
            envelope_id=row['envelope_id'], drive_attempt_id=row['drive_attempt_id'],
            target_session_ref=row['target_session_ref'], wake_reason=row['wake_reason'],
            outcome=row['outcome'], observed_seat_state=row['observed_seat_state'],
            runtime_id=row['runtime_id'], invocation_id=row['invocation_id'],
            diagnostic=diagnostic, prior_drive_attempt_id=row['prior_drive_attempt_id'],
            recovered_at=row['recovered_at'], created_at=row['created_at'])

    def record(self, *, envelope_id: str, drive_attempt_id: str, target_session_ref: str,
               wake_reason: str, outcome: str, observed_seat_state: str | None,
               runtime_id: str | None, invocation_id: str | None, diagnostic: Any,
               prior_drive_attempt_id: str | None, recovered_at: str | None) -> DriveDiagnostic:
        record = DriveDiagnostic(
            envelope_id=envelope_id, drive_attempt_id=drive_attempt_id,
            target_session_ref=target_session_ref, wake_reason=wake_reason, outcome=outcome,
            observed_seat_state=observed_seat_state, runtime_id=runtime_id,
            invocation_id=invocation_id, diagnostic=diagnostic,
            prior_drive_attempt_id=prior_drive_attempt_id, recovered_at=recovered_at,
            created_at=self._db.now())
        self._db.run(
            """INSERT INTO hrcmail_drive_diagnostics (
          envelope_id, drive_attempt_id, target_session_ref, wake_reason, outcome,
          observed_seat_state, runtime_id, invocation_id, diagnostic_json,
          prior_drive_attempt_id, recovered_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(envelope_id) DO UPDATE SET
          drive_attempt_id = excluded.drive_attempt_id, target_session_ref = excluded.target_session_ref,
          wake_reason = excluded.wake_reason, outcome = excluded.outcome,
          observed_seat_state = excluded.observed_seat_state, runtime_id = excluded.runtime_id,
          invocation_id = excluded.invocation_id, diagnostic_json = excluded.diagnostic_json,
          prior_drive_attempt_id = excluded.prior_drive_attempt_id, recovered_at = excluded.recovered_at,
          created_at = excluded.created_at""",
            (record.envelope_id, record.drive_attempt_id, record.target_session_ref,
             record.wake_reason, record.outcome, record.observed_seat_state, record.runtime_id,
             record.invocation_id,
             None if record.diagnostic is None else _js_json_stringify(record.diagnostic),
             record.prior_drive_attempt_id, record.recovered_at, record.created_at))
        return record


# ── Launch failures ──────────────────────────────────────────────────────────

class LaunchFailures:
    def __init__(self, db: _Db):
        self._db = db
        db.connection.execute("""CREATE TABLE IF NOT EXISTS hrcmail_launch_failures (
    envelope_id TEXT PRIMARY KEY, presentation_id TEXT NOT NULL,
    attempts INTEGER NOT NULL, last_error TEXT NOT NULL
  )""")
        # T-13151: when a run of participant-host refusals began. NULL for every
        # other refusal class, which keeps the attempt-count bound.
        columns = db.all('PRAGMA table_info(hrcmail_launch_failures)')
        if not any(column['name'] == 'participant_host_since_ms' for column in columns):
            db.connection.execute(
                'ALTER TABLE hrcmail_launch_failures ADD COLUMN participant_host_since_ms INTEGER')

    def get(self, envelope_id: str) -> LaunchFailure | None:
        row = self._db.get(
            'SELECT attempts, last_error AS lastError, participant_host_since_ms AS participantHostSinceMs FROM hrcmail_launch_failures WHERE envelope_id = ?',
            (envelope_id,))
        if row is None:
            return None
        return LaunchFailure(attempts=row['attempts'], last_error=row['lastError'],
                             participant_host_since_ms=row['participantHostSinceMs'])

    def record(self, envelope_id: str, presentation_id: str, error: str,
               participant_host_at_ms: int | None = None) -> int:
        # A participant-host refusal keeps the first one's time; any other
        # refusal clears it, returning the envelope to the attempt bound.
        row = self._db.get("""
            INSERT INTO hrcmail_launch_failures
              (envelope_id, presentation_id, attempts, last_error, participant_host_since_ms)
            VALUES (?, ?, 1, ?, ?)
            ON CONFLICT(envelope_id) DO UPDATE SET
              attempts = attempts + CASE WHEN presentation_id = excluded.presentation_id THEN 0 ELSE 1 END,
              presentation_id = excluded.presentation_id, last_error = excluded.last_error,
              participant_host_since_ms = CASE
                WHEN excluded.participant_host_since_ms IS NULL THEN NULL
                ELSE COALESCE(participant_host_since_ms, excluded.participant_host_since_ms)
              END
            RETURNING attempts
          """, (envelope_id, presentation_id, error, participant_host_at_ms))
        if row is None:
            raise RuntimeError('launch failure was not recorded')
        return row['attempts']


# ── Open ─────────────────────────────────────────────────────────────────────

_PRAGMAS = 'PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;'

_SCHEMA = """
    CREATE TABLE IF NOT EXISTS injector_store_imports (
      source_path TEXT PRIMARY KEY,
      imported_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hrcmail_delivery_intents (
      envelope_id TEXT PRIMARY KEY, target_session_ref TEXT NOT NULL,
      door TEXT NOT NULL CHECK (door IN ('steer', 'enqueue', 'preempt', 'invoke', 'launch')),
      form TEXT NOT NULL CHECK (form IN ('full', 'defer-retry', 'reminder')),
      presentation_id TEXT NOT NULL,
      runtime_id TEXT, submission_id TEXT, host_session_id TEXT,
      generation INTEGER CHECK (generation IS NULL OR generation >= 1),
      delivery_outcome TEXT, submitted_hrc_seq INTEGER NOT NULL, submitted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL, invocation_id TEXT, broker_after_seq INTEGER,
      uncertain_cause TEXT, uncertain_at TEXT, last_evidence_kind TEXT, last_evidence_at TEXT,
      terminal_envelope_cause TEXT, terminal_envelope_at TEXT, cleanup_outcome TEXT, cleanup_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_injector_intents_target ON hrcmail_delivery_intents(target_session_ref);
    CREATE INDEX IF NOT EXISTS idx_injector_intents_submission ON hrcmail_delivery_intents(submission_id);
    CREATE INDEX IF NOT EXISTS idx_injector_intents_runtime ON hrcmail_delivery_intents(runtime_id);
    CREATE TABLE IF NOT EXISTS hrcmail_presentations (
      envelope_id TEXT NOT NULL, runtime_id TEXT NOT NULL, target_session_ref TEXT NOT NULL,
      generation INTEGER CHECK (generation IS NULL OR generation >= 1),
      presentation_id TEXT NOT NULL, input_id TEXT, delivery_outcome TEXT NOT NULL,
      landing_hrc_seq INTEGER NOT NULL, landed_at TEXT NOT NULL, receipt_committed_at TEXT,
      turn_ended_at TEXT, reminder_armed_at TEXT, reminder_due_at TEXT,
      reminder_landing_hrc_seq INTEGER, reminder_landed_at TEXT, disposed_at TEXT, disposition TEXT,
      PRIMARY KEY (envelope_id, runtime_id)
    );
    CREATE INDEX IF NOT EXISTS idx_injector_presentations_runtime ON hrcmail_presentations(runtime_id) WHERE disposed_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_injector_presentations_target ON hrcmail_presentations(target_session_ref);
    CREATE INDEX IF NOT EXISTS idx_injector_presentations_reminder_due
      ON hrcmail_presentations(target_session_ref, reminder_due_at)
      WHERE reminder_due_at IS NOT NULL AND reminder_landing_hrc_seq IS NULL AND disposed_at IS NULL;
    CREATE TABLE IF NOT EXISTS hrcmail_birth_refusals (
      target_session_ref TEXT PRIMARY KEY, scope_ref TEXT NOT NULL,
      refusals INTEGER NOT NULL DEFAULT 0 CHECK (refusals >= 0),
      last_reason TEXT, resolved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_injector_birth_refusals_open ON hrcmail_birth_refusals(resolved_at);
    CREATE TABLE IF NOT EXISTS hrcmail_delivery_expiries (
      envelope_id TEXT NOT NULL, runtime_id TEXT NOT NULL, expiries INTEGER NOT NULL,
      first_expired_at TEXT NOT NULL, last_expired_at TEXT NOT NULL, refusal_window_opened_at TEXT,
      PRIMARY KEY (envelope_id, runtime_id)
    );
    CREATE TABLE IF NOT EXISTS hrcmail_failure_notices (
      envelope_id TEXT NOT NULL, target_session_ref TEXT NOT NULL, notice TEXT NOT NULL,
      created_at TEXT NOT NULL, delivered_at TEXT,
      PRIMARY KEY (envelope_id, target_session_ref)
    );
    CREATE INDEX IF NOT EXISTS idx_injector_failure_notices_undelivered
      ON hrcmail_failure_notices(delivered_at, target_session_ref);
    CREATE TABLE IF NOT EXISTS wrkq_ledger_cursors (
      stream TEXT PRIMARY KEY, high_water INTEGER NOT NULL CHECK (high_water >= 0), updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS hrcmail_drive_diagnostics (
      envelope_id TEXT PRIMARY KEY, drive_attempt_id TEXT NOT NULL,
      target_session_ref TEXT NOT NULL, wake_reason TEXT NOT NULL, outcome TEXT NOT NULL,
      observed_seat_state TEXT, runtime_id TEXT, invocation_id TEXT,
      diagnostic_json TEXT, prior_drive_attempt_id TEXT, recovered_at TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_injector_drive_diagnostics_target
      ON hrcmail_drive_diagnostics(target_session_ref);
  """


class InjectorStateStore:
    def __init__(self, connection: sqlite3.Connection, clock: Clock):
        db = _Db(connection, clock)
        self.connection = connection
        self.mail_delivery = HrcMailDeliveryRepository(db)
        self.wrkq_ledger_cursors = WrkqLedgerCursorRepository(db)
        self.drive_diagnostics = DriveDiagnostics(db)
        self.launch_failures = LaunchFailures(db)

    def close(self) -> None:
        self.connection.close()

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        self.close()


def open_store(path, clock: Clock = system_clock) -> InjectorStateStore:
    """`openInjectorStateStore(path)` without an import source."""
    path = os.fspath(path)
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    connection = sqlite3.connect(path, autocommit=True)
    connection.row_factory = sqlite3.Row
    # busy_timeout first: journal_mode takes a lock (see acp-admin-store open-store).
    connection.executescript(_PRAGMAS)
    try:
        connection.executescript(_SCHEMA)
        return InjectorStateStore(connection, clock)
    except BaseException:
        connection.close()
        raise
