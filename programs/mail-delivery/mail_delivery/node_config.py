"""The node's injector plist is the single source of delivery settings."""
import os
from pathlib import Path
import plistlib


def plist_path():
    return Path(os.environ.get('MAIL_DELIVERY_INJECTOR_PLIST',
        Path.home() / 'Library/LaunchAgents/com.praesidium.hrc-mail-injector.plist'))


def read_settings(path=None):
    try:
        with Path(path or plist_path()).open('rb') as stream:
            document = plistlib.load(stream)
        settings = document.get('EnvironmentVariables', {})
        if not isinstance(settings, dict) or not isinstance(settings.get('HRC_WRKQ_DB'), str) or not settings['HRC_WRKQ_DB'].strip():
            return None
        return {key: value for key, value in settings.items()
                if (key.startswith('HRC_') or key == 'PATH') and isinstance(value, str)}
    except (OSError, ValueError, plistlib.InvalidFileException, AttributeError):
        return None


def load_node_config(path=None):
    settings = read_settings(path)
    if settings is None:
        return False
    os.environ.update(settings)
    return True


def state_path(path=None):
    settings = read_settings(path)
    if settings is None:
        raise ValueError('injector plist missing or has no HRC_WRKQ_DB')
    return Path(settings.get('HRC_MAIL_INJECTOR_STATE_PATH') or
                Path.home() / 'praesidium/var/state/acp/hrc-mail-injector.sqlite')
