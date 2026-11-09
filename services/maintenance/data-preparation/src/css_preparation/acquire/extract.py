"""Confined archive extraction for ZIP and tar originals.

Paths stay inside the destination; links, devices and encrypted members are refused;
member count, sizes and compression ratio are bounded and counted on the actual bytes.
Nothing inside an archive is executed.
"""
from __future__ import annotations

from dataclasses import dataclass
import hashlib
from pathlib import Path
import stat
import tarfile
import zipfile

CHUNK = 1 << 16


class ExtractionError(ValueError):
    """The archive is unsafe or exceeds its limits; nothing is kept."""


@dataclass(frozen=True)
class Limits:
    max_members: int = 5000
    max_member_bytes: int = 200_000_000
    max_total_bytes: int = 1_000_000_000
    max_ratio: int = 200


def safe_member(name: str) -> str:
    """Relative POSIX path without empty, `.`, `..`, drive or control parts."""
    if (not name or '\\' in name or '\x00' in name or name.startswith('/') or ':' in name
            or any(part in ('', '.', '..') for part in name.split('/'))
            or any(ord(char) < 32 for char in name)):
        raise ExtractionError(f'Unsafe member path {name[:60]!r}')
    return name


def _copy(source, target: Path, limit: int, budget: list[int]) -> tuple[int, str]:
    digest, size = hashlib.sha256(), 0
    with target.open('xb') as handle:
        while chunk := source.read(CHUNK):
            size += len(chunk)
            budget[0] -= len(chunk)
            if size > limit or budget[0] < 0:
                raise ExtractionError('Archive member exceeds its size limit')
            digest.update(chunk)
            handle.write(chunk)
    return size, digest.hexdigest()


def _members(archive: Path, limits: Limits):
    if zipfile.is_zipfile(archive):
        with zipfile.ZipFile(archive) as package:
            infos = package.infolist()
            if len(infos) > limits.max_members:
                raise ExtractionError('Too many archive members')
            for info in infos:
                kind = stat.S_IFMT(info.external_attr >> 16)
                if info.flag_bits & 1 or kind not in (0, stat.S_IFREG, stat.S_IFDIR):
                    raise ExtractionError(f'Encrypted or special member {info.filename[:60]!r}')
                if info.is_dir():
                    safe_member(info.filename.rstrip('/'))
                    continue
                if info.compress_size and info.file_size / info.compress_size > limits.max_ratio:
                    raise ExtractionError('Suspicious compression ratio')
                with package.open(info) as source:
                    yield safe_member(info.filename), source
        return
    try:
        package = tarfile.open(archive, mode='r:*')
    except tarfile.TarError:
        raise ExtractionError('Not a supported archive') from None
    with package:
        count = 0
        for info in package:
            count += 1
            if count > limits.max_members:
                raise ExtractionError('Too many archive members')
            if info.isdir():
                safe_member(info.name.rstrip('/'))
                continue
            if not info.isreg():
                raise ExtractionError(f'Link or special member {info.name[:60]!r}')
            source = package.extractfile(info)
            if source is None:
                raise ExtractionError('Unreadable member')
            with source:
                yield safe_member(info.name), source


def extract(archive: Path, destination: Path, limits: Limits = Limits()) -> list[dict[str, object]]:
    """Extract into an empty destination; on any problem remove what was written and raise."""
    destination = Path(destination)
    destination.mkdir(parents=True, exist_ok=True)
    if any(destination.iterdir()):
        raise ExtractionError('Destination must be empty')
    root = destination.resolve()
    written: list[Path] = []
    files: list[dict[str, object]] = []
    budget = [limits.max_total_bytes]
    try:
        for name, source in _members(Path(archive), limits):
            target = (root / name).resolve()
            if not target.is_relative_to(root):
                raise ExtractionError(f'Member leaves the destination {name[:60]!r}')
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                raise ExtractionError(f'Duplicate member {name[:60]!r}')
            written.append(target)
            size, sha256 = _copy(source, target, limits.max_member_bytes, budget)
            files.append({'path': name, 'bytes': size, 'sha256': sha256})
    except (ExtractionError, zipfile.BadZipFile, tarfile.TarError, OSError) as error:
        for path in written:
            path.unlink(missing_ok=True)
        if isinstance(error, ExtractionError):
            raise
        raise ExtractionError('Archive could not be read safely') from None
    return files
