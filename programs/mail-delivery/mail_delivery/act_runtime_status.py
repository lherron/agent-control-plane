"""Runtime status classification; translation of policy/terminal/runtime-status.ts."""
from .act_hrc_port import is_terminal_runtime_status


def is_runtime_terminal(status):
    """Is this runtime, by its own status column, no longer live?"""
    return is_terminal_runtime_status(status)
