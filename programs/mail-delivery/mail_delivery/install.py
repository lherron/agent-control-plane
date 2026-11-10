"""Local-node source install; no daemon commands or remote activation."""
import argparse
import json
from pathlib import Path
import shutil
import tempfile


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--uninstall', action='store_true')
    args = parser.parse_args()
    parent = Path.home() / '.local/lib/praesidium-kernel/programs'
    target = parent / 'mail-delivery'
    if target.is_symlink():
        raise ValueError('program target must not be a symlink')
    if args.uninstall:
        if target.exists():
            shutil.rmtree(target)
        print(target)
        return
    source = Path(__file__).absolute().parent.parent
    manifest = source / 'program.json'
    if manifest.is_symlink() or source.is_symlink() or (source / 'mail_delivery').is_symlink():
        raise ValueError('source symlinks are refused')
    if json.loads(manifest.read_text()) != dict(name='mail-delivery', module='mail_delivery.shadow', project='agent-control-plane'):
        raise ValueError('unexpected program manifest')
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
    print(target)


if __name__ == '__main__':
    main()
