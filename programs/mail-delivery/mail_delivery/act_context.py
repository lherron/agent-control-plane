"""Shared mutable context, translated from policy/context.ts.

The controller supplies clock/id sources and the out-of-scope wake/terminal
operations. Maps and sets retain the injector's keys and value shapes.
"""
from __future__ import annotations
from typing import Any, Protocol, TypedDict, NotRequired
from .act_contracts import HrcInjectionPort, KickerStateStore, ForeignHome
from .act_client import MailKickerLedger


class FailureNoticeBackoff(TypedDict):
    key: str
    parkedRuntimeId: NotRequired[str]
    exhausted: bool
    attempts: int
    nextAtMs: int


class QuietTarget(TypedDict):
    fingerprint: str
    quietSinceMs: int
    confirmed: bool


class SteerHold(TypedDict):
    reason: str
    invocationId: str | None
    brokerSeq: int
    since: int
    announced: bool


class BirthSweepBackoff(TypedDict):
    attempts: int
    nextAtMs: int
    dueWoken: NotRequired[bool]
    participantHost: NotRequired[bool]


class MailKickerContext(Protocol):
    recipient_hints: Any
    store: KickerStateStore
    port: HrcInjectionPort
    ledger: MailKickerLedger
    node_id: str
    foreign_home_memo: dict[str, ForeignHome]
    enabled: bool
    sweep_interval_ms: int
    stopping: bool
    mail_kicker_sweep_in_flight: Any
    wrkq_ledger_tail_in_flight: Any
    mail_kicker_deferral_wake_in_flight: Any
    mail_kicker_cold_start_catchup_pending: bool
    mail_kicker_pending_targets: dict[str, str]
    mail_kicker_target_operations: dict[str, Any]
    mail_kicker_foreign_home_announced: dict[str, str]
    mail_kicker_birth_deferred_announced: dict[str, str]
    mail_kicker_birth_sweep_backoff: dict[str, BirthSweepBackoff]
    mail_kicker_failure_notice_backoff: dict[str, FailureNoticeBackoff]
    mail_kicker_lapsed_runtimes: set[str]
    mail_kicker_disposals_pending: set[Any]
    mail_kicker_boot_reconcile_pending: bool
    mail_kicker_stalled_delivery_announced: set[str]
    mail_kicker_steer_refused: set[str]
    mail_kicker_steer_fallback: set[str]
    mail_kicker_delivery_backoff: dict[str, int]
    mail_kicker_steer_hold: dict[str, SteerHold]
    mail_kicker_quiet_targets: dict[str, QuietTarget]
    mail_kicker_reconcile_examined_at: dict[str, int]
    mail_kicker_live_runtime_seen_at: dict[str, int]

    def now_ms(self) -> int: ...
    def new_uuid(self) -> str: ...
    def log(self, level: str, event: str, detail: dict) -> None: ...
    def wake(self, target_session_ref: str, reason: str) -> None: ...
    async def drain_target(self, target_session_ref: str) -> None: ...
    async def run_sweep_once(self) -> None: ...
    async def run_tail_once(self) -> None: ...
    def observe_lifecycle_event(self, event: dict) -> None: ...
    def observe_broker_event(self, event: dict) -> None: ...
    async def fail_envelope_with_audit(self, input: dict) -> Any: ...
    async def deliver_failure_notices(self, target_session_ref: str, seat_session: dict) -> Any: ...
    async def fail_undeliverable_mail(self, target_session_ref: str, options: dict) -> Any: ...
    def schedule_participant_host_retry(self, target_session_ref: str, reason: str) -> None: ...
