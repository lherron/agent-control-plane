"""Source install on the node that runs it; no daemon commands.

The kernel hosts a module from `modules/<name>/module.json` and reads no other
layout. An install also removes the pre-rename `programs/mail-delivery` tree.

A node without a git checkout gets the sources staged beside it (the
`install-mail-delivery-on` recipe) and is told the commit with `--commit`.
"""
import argparse
import json
from pathlib import Path
import shutil
import tempfile
import subprocess

try:
    from .gen_wrkq_pin import write_pin, PROTOCOL_JS
except ImportError:  # direct recipe invocation
    from gen_wrkq_pin import write_pin, PROTOCOL_JS


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--uninstall', action='store_true')
    parser.add_argument('--commit', help='ACP revision of staged sources; read from git when omitted')
    args = parser.parse_args(argv)
    lib = Path.home() / '.local/lib/praesidium-kernel'
    target = lib / 'modules/mail-delivery'
    legacy = lib / 'programs/mail-delivery'
    if target.is_symlink() or legacy.is_symlink() or legacy.parent.is_symlink():
        raise ValueError('module target must not be a symlink')
    if args.uninstall:
        if target.exists():
            shutil.rmtree(target)
        remove_legacy(legacy)
        print(target)
        return
    source = Path(__file__).absolute().parent.parent
    install(source, target, source.parent.parent, commit=args.commit)
    remove_legacy(legacy)
    print(target)


def remove_legacy(legacy):
    """Remove the pre-rename tree, and its directory once nothing else is in it."""
    if legacy.exists():
        shutil.rmtree(legacy)
    try:
        legacy.parent.rmdir()
    except OSError:  # absent, or another program still lives there
        pass


def install(source, target, checkout, *, commit=None):
    source, target, checkout = Path(source), Path(target), Path(checkout)
    parent = target.parent
    if target.is_symlink():
        raise ValueError('module target must not be a symlink')
    if commit is None:
        commit = subprocess.check_output(['git', '-C', str(checkout), 'rev-parse', 'HEAD'], text=True).strip()
    manifest = source / 'module.json'
    if manifest.is_symlink() or source.is_symlink() or (source / 'mail_delivery').is_symlink():
        raise ValueError('source symlinks are refused')
    if json.loads(manifest.read_text()) != dict(name='mail-delivery', entry='mail_delivery.main', project='agent-control-plane'):
        raise ValueError('unexpected module manifest')
    files = [manifest, *sorted((source / 'mail_delivery').glob('*.py'))]
    if any(path.is_symlink() or not path.is_file() for path in files):
        raise ValueError('source symlinks and non-files are refused')
    parent.mkdir(parents=True, exist_ok=True)
    staged = Path(tempfile.mkdtemp(prefix='.mail-delivery-', dir=parent))
    backup = staged.with_name(staged.name + '-previous')
    try:
        (staged / 'mail_delivery').mkdir()
        for path in files:
            destination = staged / path.relative_to(source)
            shutil.copyfile(path, destination)
        write_pin(checkout / PROTOCOL_JS, staged / 'mail_delivery/wrkq_pin.py')
        (staged / 'mail_delivery/build_info.py').write_text(
            f'"""Installed ACP source revision."""\nACP_COMMIT = {commit!r}\n')
        # The complete tree enters the scanner in one rename. The old tree
        # moves out of the scanner's visible names before replacement.
        if target.exists():
            target.rename(backup)
        try:
            staged.rename(target)
        except BaseException:
            if backup.exists():
                backup.rename(target)
            raise
    finally:
        if staged.exists():
            shutil.rmtree(staged)
        if backup.exists():
            shutil.rmtree(backup)


if __name__ == '__main__':
    main()
