"""Confined extraction against hostile synthetic archives."""
import io
from pathlib import Path
import stat
import tarfile
import tempfile
import unittest
import zipfile

from css_preparation.acquire.extract import ExtractionError, Limits, extract


class ExtractTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)

    def tearDown(self):
        self.directory.cleanup()

    def zip(self, members, name='a.zip'):
        path = self.root / name
        with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as package:
            for member, data in members:
                if isinstance(member, zipfile.ZipInfo):
                    package.writestr(member, data)
                else:
                    package.writestr(member, data)
        return path

    def tar(self, add, name='a.tar'):
        path = self.root / name
        with tarfile.open(path, 'w') as package:
            add(package)
        return path

    def out(self):
        target = self.root / f'out-{len(list(self.root.iterdir()))}'
        return target

    def test_safe_zip_and_tar_extract_with_digests(self):
        files = extract(self.zip([('text/GEN.txt', 'In the beginning'), ('LICENSE', 'terms')]), self.out())
        self.assertEqual(sorted(f['path'] for f in files), ['LICENSE', 'text/GEN.txt'])

        def add(package):
            data = b'text'
            info = tarfile.TarInfo('dir/file.txt')
            info.size = len(data)
            package.addfile(info, io.BytesIO(data))
        self.assertEqual(extract(self.tar(add), self.out())[0]['bytes'], 4)

    def test_hostile_zip_members_are_refused_and_nothing_is_kept(self):
        link = zipfile.ZipInfo('link')
        link.external_attr = (stat.S_IFLNK | 0o777) << 16
        for members in ([('../escape.txt', 'x')], [('/abs.txt', 'x')], [('C:/x.txt', 'x')], [('a\\b.txt', 'x')],
                        [(link, 'target')], [('ok.txt', 'fine'), ('a/../../x', 'x')]):
            target = self.out()
            with self.assertRaises(ExtractionError, msg=str(members)):
                extract(self.zip(members, name=f'z{len(list(self.root.iterdir()))}.zip'), target)
            self.assertEqual([p for p in target.rglob('*') if p.is_file()], [])

    def test_limits_are_counted_on_actual_bytes(self):
        bomb = self.zip([('zeros.bin', b'\0' * 2_000_000)])
        with self.assertRaises(ExtractionError):
            extract(bomb, self.out())
        with self.assertRaises(ExtractionError):
            extract(self.zip([('a.txt', 'abc'), ('b.txt', 'def')], 'b.zip'), self.out(), Limits(max_members=1))
        with self.assertRaises(ExtractionError):
            extract(self.zip([('a.txt', 'x' * 100)], 'c.zip'), self.out(), Limits(max_member_bytes=50, max_ratio=10_000))
        with self.assertRaises(ExtractionError):
            extract(self.zip([('a.txt', 'x' * 60), ('b.txt', 'y' * 60)], 'd.zip'), self.out(), Limits(max_total_bytes=100, max_ratio=10_000))

    def test_tar_links_devices_and_traversal_are_refused(self):
        def symlink(package):
            info = tarfile.TarInfo('evil')
            info.type, info.linkname = tarfile.SYMTYPE, '/etc/passwd'
            package.addfile(info)

        def hardlink(package):
            info = tarfile.TarInfo('evil')
            info.type, info.linkname = tarfile.LNKTYPE, '../../x'
            package.addfile(info)

        def device(package):
            info = tarfile.TarInfo('dev')
            info.type = tarfile.CHRTYPE
            package.addfile(info)

        def traversal(package):
            info = tarfile.TarInfo('../x.txt')
            info.size = 1
            package.addfile(info, io.BytesIO(b'x'))
        for index, add in enumerate((symlink, hardlink, device, traversal)):
            with self.assertRaises(ExtractionError):
                extract(self.tar(add, f't{index}.tar'), self.out())

    def test_non_archive_and_non_empty_destination(self):
        plain = self.root / 'plain.txt'
        plain.write_text('not an archive')
        with self.assertRaises(ExtractionError):
            extract(plain, self.out())
        busy = self.root / 'busy'
        busy.mkdir()
        (busy / 'x').write_text('x')
        with self.assertRaises(ExtractionError):
            extract(self.zip([('a.txt', 'a')], 'e.zip'), busy)


if __name__ == '__main__':
    unittest.main()
