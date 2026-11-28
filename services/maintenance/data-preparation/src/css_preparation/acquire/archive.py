"""Inspect bounded ZIP entries without extracting them to the filesystem."""

from io import BytesIO
import stat
from zipfile import ZIP_DEFLATED, ZIP_STORED, BadZipFile, ZipFile, ZipInfo
import zlib

from ..prepare.records import RecordError

MAX_ORIGINAL_BYTES = 64_000_000
MAX_FILES = 512
ZIP_ERRORS = (BadZipFile, zlib.error, NotImplementedError, RuntimeError, OSError)


class ArchiveError(RecordError):
    """The original exceeds archive limits or is not safely readable."""


def _safe_entry(info: ZipInfo) -> bool:
    name = info.orig_filename
    parts = name.rstrip("/").split("/")
    mode = stat.S_IFMT(info.external_attr >> 16)
    return (
        0 < len(name) <= 240
        and all(part not in ("", ".", "..") for part in parts)
        and not any(char in name for char in "\\:")
        and name.isprintable()
        and mode in (0, stat.S_IFREG, stat.S_IFDIR)
        and info.compress_type in (ZIP_STORED, ZIP_DEFLATED)
        and not info.flag_bits & 1
    )


def archive_members(data: bytes, *, only: str | None = None):
    if len(data) > MAX_ORIGINAL_BYTES:
        raise ArchiveError("Original exceeds the archive byte limit")
    with ZipFile(BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) > MAX_FILES or not all(map(_safe_entry, entries)):
            raise ArchiveError("ZIP has too many entries or an unsafe entry")
        files = [entry for entry in entries if not entry.is_dir()]
        if len({entry.filename for entry in files}) != len(files):
            raise ArchiveError("ZIP contains duplicate file paths")
        if sum(entry.file_size for entry in files) > MAX_ORIGINAL_BYTES:
            raise ArchiveError("ZIP exceeds the unpacked byte limit")
        for entry in sorted(files, key=lambda item: item.filename):
            if only is not None and entry.filename != only:
                continue
            with archive.open(entry) as member:
                content = member.read(entry.file_size + 1)
            if len(content) != entry.file_size:
                raise ArchiveError("ZIP entry size does not match its declaration")
            yield entry.filename, content


def archive_member(data: bytes, path: str) -> bytes:
    try:
        for _, contents in archive_members(data, only=path):
            return contents
    except ZIP_ERRORS:
        raise ArchiveError("ZIP cannot be read in a supported format") from None
    raise ArchiveError("The reviewed ZIP member is missing")
