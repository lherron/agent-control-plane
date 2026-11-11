"""Injector policy capability contracts (policy/contracts.ts).

Methods are snake_case; DTO and option dictionaries retain the TypeScript wire
keys. Store methods/records follow store.py's snake_case keyword/dataclass API.
"""
from __future__ import annotations
from typing import Any, Callable, Literal, Protocol, TypedDict, NotRequired

KickerLogLevel = Literal['DEBUG', 'INFO', 'WARN', 'ERROR']
Wire = dict[str, Any]


class HrcErrorCode:
    MALFORMED_REQUEST = 'malformed_request'
    UNKNOWN_FIELD = 'unknown_field'
    EXECUTION_FORMAT_UNSUPPORTED_DOOR = 'execution_format_unsupported_door'
    MALFORMED_REGISTRATION = 'malformed'
    INVALID_SELECTOR = 'invalid_selector'
    INVALID_FENCE = 'invalid_fence'
    CURSOR_INVALID = 'cursor_invalid'
    UNKNOWN_SESSION = 'unknown_session'
    UNKNOWN_HOST_SESSION = 'unknown_host_session'
    UNKNOWN_RUNTIME = 'unknown_runtime'
    UNKNOWN_INPUT = 'unknown_input'
    UNKNOWN_REGISTRATION_CLASS = 'unknown_class'
    UNKNOWN_SURFACE = 'unknown_surface'
    UNKNOWN_BRIDGE = 'unknown_bridge'
    CONFLICT = 'stale_context'
    STALE_CONTEXT = 'stale_context'
    RUNTIME_BUSY = 'runtime_busy'
    SEAT_UNOBSERVABLE = 'seat_unobservable'
    RUN_MISMATCH = 'run_mismatch'
    MISSING_RUNTIME_INTENT = 'missing_runtime_intent'
    PROVIDER_MISMATCH = 'provider_mismatch'
    INFLIGHT_UNSUPPORTED = 'inflight_unsupported'
    URGENT_DELIVERY_UNSUPPORTED = 'urgent_delivery_unsupported'
    URGENT_DELIVERY_RACE_LOST = 'urgent_delivery_race_lost'
    URGENT_DELIVERY_AMBIGUOUS = 'urgent_delivery_ambiguous'
    URGENT_DELIVERY_UNROUTABLE = 'urgent_delivery_unroutable'
    BROKER_DESCRIPTOR_ABSENT = 'broker_descriptor_absent'
    ASK_CLIENT_UNSUPPORTED = 'ask_client_unsupported'
    SERVER_DRAINING = 'server_draining'
    SERVER_LIFECYCLE_REFUSED = 'server_lifecycle_refused'
    SERVER_LIFECYCLE_IN_FLIGHT = 'server_lifecycle_in_flight'
    SELF_RESTART_REFUSED = 'self_restart_refused'
    RUNTIME_UNAVAILABLE = 'runtime_unavailable'
    RUN_ZOMBIE_TIMEOUT = 'run_zombie_timeout'
    RUNTIME_TERMINATED_WITH_ACTIVE_RUN = 'runtime_terminated_with_active_run'
    RUNTIME_DEAD_WITH_ACTIVE_RUN = 'runtime_dead_with_active_run'
    RUNTIME_READY_WITH_ACTIVE_RUN = 'runtime_ready_with_active_run'
    RUNTIME_PROCESS_EXITED_WITH_ACTIVE_RUN = 'runtime_process_exited_with_active_run'
    RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN = 'runtime_unavailable_with_active_run'
    RUNTIME_BUSY_TIMEOUT_WITH_ACTIVE_RUN = 'runtime_busy_timeout_with_active_run'
    RUN_ABANDONED_BY_RUNTIME = 'run_abandoned_by_runtime'
    RUN_ACCEPTED_NEVER_STARTED = 'accepted_run_never_started'
    INTERNAL_ERROR = 'internal_error'
    UNKNOWN_APP_SESSION = 'unknown_app_session'
    APP_SESSION_REMOVED = 'app_session_removed'
    SESSION_KIND_MISMATCH = 'session_kind_mismatch'
    UNSUPPORTED_CAPABILITY = 'unsupported_capability'
    DECLARATION_INVALID = 'declaration_invalid'
    MISSING_SESSION_SPEC = 'missing_session_spec'
    REPLY_TO_SCOPE_MISMATCH = 'reply_to_scope_mismatch'
    NO_RESUMABLE_CONTINUATION = 'no_resumable_continuation'
    RESUME_RUNTIME_LIVE = 'resume_runtime_live'
    RUNTIME_RETAINED_EVIDENCE_PROJECTED = 'runtime_retained_evidence_projected'
    PRESENTATION_CONFLICT = 'presentation_conflict'
    PRESENTATION_OPERATOR_UNSUPPORTED = 'presentation_operator_unsupported'
    SESSION_ROSTER_EXHAUSTED = 'session_roster_exhausted'
    ROSTER_CLAIM_SUPERSEDED = 'roster_claim_superseded'
    SESSION_SCOPE_OCCUPIED = 'session_scope_occupied'
    IDEMPOTENCY_KEY_CONFLICT = 'idempotency_key_conflict'
    REGISTRATION_INSTANCES_EXHAUSTED = 'instances_exhausted'
    FIRST_TURN_MISSING = 'first_turn_missing'
    INVALID_PROVISION_SHAPE = 'invalid_provision_shape'
    DENIED_PROVISION_KEY = 'denied_provision_key'
    INVALID_PROVISION_VALUE = 'invalid_provision_value'
    PLACEMENT_DIRECTIVE_CONFLICT = 'placement_directive_conflict'
    UNKNOWN_NODE = 'unknown_node'
    COLD_INPUT_CONTINUATION_LOST = 'cold_input_continuation_lost'
    COLD_INPUT_CONTINUATION_FAILED = 'cold_input_continuation_failed'
    SESSION_HOME_UNREACHABLE = 'session_home_unreachable'
    SESSION_HOME_PENDING = 'session_home_pending'
    SESSION_HOME_UNKNOWN = 'session_home_unknown'
    SESSION_HOME_MALFORMED = 'session_home_malformed'



class HrcDomainError(Exception):
    def __init__(self, code: str, message: str, detail: Wire | None = None):
        super().__init__(message)
        self.name = 'HrcDomainError'
        self.code = code
        self.message = message
        self.detail = {} if detail is None else detail
        self.status = _HRC_STATUS.get(code, 500)


class WrkqLedgerUnavailableError(Exception):
    def __init__(self, message: str, method: str):
        super().__init__(message)
        self.name = 'WrkqLedgerUnavailableError'
        self.message = message
        self.method = method


class WrkqLedgerRequestError(Exception):
    def __init__(self, message: str, method: str, code: int, data: Any = None):
        super().__init__(message)
        self.name = 'WrkqLedgerRequestError'
        self.message = message
        self.method = method
        self.code = code
        self.data = data


class ForeignHome(TypedDict):
    homeNodeId: str
    source: Literal['placement-ledger', 'registry', 'federated-runtime']


class FederatedScopeRuntimes(TypedDict):
    localNodeId: str
    liveNodeIds: list[str]
    unansweredNodeIds: list[str]


class KickerRegistryClient(Protocol):
    async def consult(self, scope_ref: str) -> Wire: ...
    async def list_unborn_designations(self, node_id: str) -> list[Wire]: ...


class KickerBrokerPort(Protocol):
    async def seat_probe(self, runtime_id: str) -> Wire: ...
    async def withdraw(self, input: Wire) -> Wire: ...


class KickerDispatchOptions(TypedDict):
    ttlMs: int
    submissionOrigin: Wire
    idempotencyKey: NotRequired[str]
    waitForCompletion: NotRequired[bool]
    submissionDoor: NotRequired[Literal['steer', 'enqueue', 'invoke', 'preempt']]
    turnPolicy: NotRequired[Literal['guarded']]
    launchPromptOnColdBirth: NotRequired[bool]


KickerDispatchResult = Wire
KickerRegistryConsultResult = Wire
KickerRpcResult = Wire


class HrcInjectionPort(Protocol):
    async def runtime(self, runtime_id: str) -> Wire | None: ...
    async def runtimes_by_host_session(self, host_session_id: str) -> list[Wire]: ...
    async def live_runtimes(self, scope_ref: str) -> list[Wire]: ...
    async def live_session_refs(self) -> list[str]: ...
    async def seat(self, runtime_id: str) -> Wire: ...
    async def withdraw(self, input: Wire) -> Wire: ...
    async def resolve_foreign_home(self, scope_ref: str) -> ForeignHome | None: ...
    async def federated_live_runtimes(self, scope_ref: str) -> FederatedScopeRuntimes: ...
    async def resolve_runtime_intent(self, scope_ref: str, materialization_intent: str | None) -> Wire | None: ...
    async def target_by_session_ref(self, target_session_ref: str) -> Wire | None: ...
    async def ensure_target_session(self, target_session_ref: str, intent: Wire, options: Wire) -> Wire: ...
    async def events_head(self) -> Wire: ...
    async def lifecycle_events(self, input: Wire) -> list[Wire]: ...
    async def broker_events_query(self, op: Wire) -> Wire: ...
    async def local_placement_bindings(self) -> Wire: ...
    async def locate(self, scope_ref: str) -> ForeignHome | None: ...
    async def unborn_designations(self) -> Wire: ...
    async def subscribe_lifecycle(self, input: Wire) -> Callable: ...
    async def subscribe_broker(self, input: Wire) -> Callable: ...
    async def steer(self, session: Wire, intent: Wire, prompt: str, options: KickerDispatchOptions) -> KickerDispatchResult: ...
    async def enqueue(self, session: Wire, intent: Wire, prompt: str, options: KickerDispatchOptions) -> KickerDispatchResult: ...
    async def invoke(self, session: Wire, intent: Wire, prompt: str, options: KickerDispatchOptions) -> KickerDispatchResult: ...
    async def preempt(self, session: Wire, intent: Wire, prompt: str, options: KickerDispatchOptions) -> KickerDispatchResult: ...
    async def preempt_admission(self, session: Wire, request: Wire) -> Wire: ...


class LaunchFailures(Protocol):
    def get(self, envelope_id: str) -> Any: ...
    def record(self, envelope_id: str, presentation_id: str, error: str, participant_host_at_ms: int | None = None) -> int: ...


class KickerStateStore(Protocol):
    mail_delivery: Any
    launch_failures: LaunchFailures
    wrkq_ledger_cursors: Any
    drive_diagnostics: Any
    def close(self) -> None: ...


KickerProbeDiagnostic = Wire
KickerDriveDiagnostic = Wire


class KickerDriveDiagnostics(Protocol):
    def latest(self, envelope_id: str) -> Any: ...
    def record(self, **input: Any) -> Any: ...


class MailKickerDependencies(TypedDict):
    store: KickerStateStore
    port: HrcInjectionPort
    ledger: Any
    node_id: str
    foreign_home_memo: dict[str, ForeignHome]
    log: Callable[[KickerLogLevel, str, Wire], None]


class MailKickerOptions(TypedDict):
    enabled: bool
    sweep_interval_ms: int


MailKickerLifecycleObserver = Callable[[Wire], None]
MailKickerBrokerObserver = Callable[[Wire], None]

_HRC_STATUS = {
    HrcErrorCode.MALFORMED_REQUEST: 400,
    HrcErrorCode.UNKNOWN_FIELD: 422,
    HrcErrorCode.EXECUTION_FORMAT_UNSUPPORTED_DOOR: 422,
    HrcErrorCode.MALFORMED_REGISTRATION: 400,
    HrcErrorCode.INVALID_SELECTOR: 400,
    HrcErrorCode.INVALID_FENCE: 400,
    HrcErrorCode.CURSOR_INVALID: 409,
    HrcErrorCode.UNKNOWN_SESSION: 404,
    HrcErrorCode.UNKNOWN_HOST_SESSION: 404,
    HrcErrorCode.UNKNOWN_RUNTIME: 404,
    HrcErrorCode.UNKNOWN_INPUT: 404,
    HrcErrorCode.UNKNOWN_REGISTRATION_CLASS: 404,
    HrcErrorCode.UNKNOWN_SURFACE: 404,
    HrcErrorCode.UNKNOWN_BRIDGE: 404,
    HrcErrorCode.STALE_CONTEXT: 409,
    HrcErrorCode.RUNTIME_BUSY: 409,
    HrcErrorCode.SEAT_UNOBSERVABLE: 409,
    HrcErrorCode.RUN_MISMATCH: 409,
    HrcErrorCode.MISSING_RUNTIME_INTENT: 422,
    HrcErrorCode.PROVIDER_MISMATCH: 422,
    HrcErrorCode.INFLIGHT_UNSUPPORTED: 422,
    HrcErrorCode.URGENT_DELIVERY_UNSUPPORTED: 422,
    HrcErrorCode.URGENT_DELIVERY_RACE_LOST: 409,
    HrcErrorCode.URGENT_DELIVERY_AMBIGUOUS: 503,
    HrcErrorCode.URGENT_DELIVERY_UNROUTABLE: 409,
    HrcErrorCode.BROKER_DESCRIPTOR_ABSENT: 422,
    HrcErrorCode.ASK_CLIENT_UNSUPPORTED: 422,
    HrcErrorCode.SERVER_DRAINING: 503,
    HrcErrorCode.SERVER_LIFECYCLE_REFUSED: 403,
    HrcErrorCode.SERVER_LIFECYCLE_IN_FLIGHT: 409,
    HrcErrorCode.SELF_RESTART_REFUSED: 403,
    HrcErrorCode.RUNTIME_UNAVAILABLE: 503,
    HrcErrorCode.RUN_ZOMBIE_TIMEOUT: 500,
    HrcErrorCode.RUNTIME_TERMINATED_WITH_ACTIVE_RUN: 500,
    HrcErrorCode.RUNTIME_DEAD_WITH_ACTIVE_RUN: 500,
    HrcErrorCode.RUNTIME_READY_WITH_ACTIVE_RUN: 500,
    HrcErrorCode.RUNTIME_PROCESS_EXITED_WITH_ACTIVE_RUN: 500,
    HrcErrorCode.RUNTIME_UNAVAILABLE_WITH_ACTIVE_RUN: 500,
    HrcErrorCode.RUNTIME_BUSY_TIMEOUT_WITH_ACTIVE_RUN: 500,
    HrcErrorCode.RUN_ABANDONED_BY_RUNTIME: 500,
    HrcErrorCode.RUN_ACCEPTED_NEVER_STARTED: 500,
    HrcErrorCode.INTERNAL_ERROR: 500,
    HrcErrorCode.UNKNOWN_APP_SESSION: 404,
    HrcErrorCode.APP_SESSION_REMOVED: 409,
    HrcErrorCode.SESSION_KIND_MISMATCH: 422,
    HrcErrorCode.UNSUPPORTED_CAPABILITY: 422,
    HrcErrorCode.DECLARATION_INVALID: 422,
    HrcErrorCode.MISSING_SESSION_SPEC: 422,
    HrcErrorCode.REPLY_TO_SCOPE_MISMATCH: 409,
    HrcErrorCode.NO_RESUMABLE_CONTINUATION: 422,
    HrcErrorCode.RESUME_RUNTIME_LIVE: 409,
    HrcErrorCode.RUNTIME_RETAINED_EVIDENCE_PROJECTED: 409,
    HrcErrorCode.PRESENTATION_CONFLICT: 409,
    HrcErrorCode.PRESENTATION_OPERATOR_UNSUPPORTED: 422,
    HrcErrorCode.SESSION_ROSTER_EXHAUSTED: 409,
    HrcErrorCode.ROSTER_CLAIM_SUPERSEDED: 409,
    HrcErrorCode.SESSION_SCOPE_OCCUPIED: 409,
    HrcErrorCode.IDEMPOTENCY_KEY_CONFLICT: 409,
    HrcErrorCode.REGISTRATION_INSTANCES_EXHAUSTED: 409,
    HrcErrorCode.FIRST_TURN_MISSING: 503,
    HrcErrorCode.INVALID_PROVISION_SHAPE: 400,
    HrcErrorCode.DENIED_PROVISION_KEY: 422,
    HrcErrorCode.INVALID_PROVISION_VALUE: 422,
    HrcErrorCode.PLACEMENT_DIRECTIVE_CONFLICT: 409,
    HrcErrorCode.UNKNOWN_NODE: 422,
    HrcErrorCode.COLD_INPUT_CONTINUATION_LOST: 503,
    HrcErrorCode.COLD_INPUT_CONTINUATION_FAILED: 503,
    HrcErrorCode.SESSION_HOME_UNREACHABLE: 503,
    HrcErrorCode.SESSION_HOME_PENDING: 503,
    HrcErrorCode.SESSION_HOME_UNKNOWN: 503,
    HrcErrorCode.SESSION_HOME_MALFORMED: 502,
}
