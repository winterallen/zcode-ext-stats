import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("patcher", Path(__file__).parents[1] / "scripts/zcode_ext_stats.py")
p = importlib.util.module_from_spec(spec)
spec.loader.exec_module(p)


def archive(path, files):
    header = {"files": {}}
    offset = 0
    for name, data in files.items():
        node = header
        parts = name.split("/")
        for part in parts[:-1]:
            node = node["files"].setdefault(part, {"files": {}})
        node["files"][parts[-1]] = {"size": len(data), "offset": str(offset), "integrity": p._asar_integrity(data)}
        offset += len(data)
    header["files"]["external.node"] = {"size": 12, "unpacked": True}
    raw = json.dumps(header, separators=(",", ":")).encode()
    pad = -len(raw) % 4
    path.write_bytes(struct.pack("<4I", 4, 8 + len(raw) + pad, 4 + len(raw) + pad, len(raw)) + raw + b"\0" * pad + b"".join(files.values()))


def read(path):
    raw, tree, base = p._asar_header_raw(path)
    return {name: p._asar_entry_bytes(raw, base, ent) for name, ent in p._asar_walk_entries(tree)}


class PatcherTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.path = Path(self.tmp.name) / "app.asar"
        self.files = {p.TPS_INDEX_PATH: b"<html><body>app</body></html>",
                      p.TPS_MAIN_PATH: b"export const main=1;", p.TPS_PRELOAD_PATH: b'const electron=require("electron");',
                      "out/renderer/assets/other.js": bytes(range(256)) * 20}
        archive(self.path, self.files)

    def test_apply_idempotent_upgrade_and_revert(self):
        original = self.path.read_bytes()
        p.process_tps_footer(self.path, True, False, None)
        self.assertEqual(self.path.read_bytes(), original)
        p.process_tps_footer(self.path, False, False, None)
        installed = self.path.read_bytes()
        for name, data in self.files.items():
            if name not in (p.TPS_INDEX_PATH, p.TPS_MAIN_PATH, p.TPS_PRELOAD_PATH):
                self.assertEqual(read(self.path)[name], data)
        p.process_tps_footer(self.path, False, False, None)
        self.assertEqual(self.path.read_bytes(), installed)
        update = Path(self.tmp.name) / "new.js"
        update.write_bytes(b"/* new renderer */")
        p.process_tps_footer(self.path, False, False, update)
        self.assertEqual(read(self.path)[p.TPS_SCRIPT_PATH], update.read_bytes())
        self.assertEqual(read(self.path)[p.TPS_MAIN_PATH].count(p.TPS_MAIN_BLOCK), 1)
        p.process_tps_footer(self.path, False, True, None)
        self.assertEqual(read(self.path), self.files)
        self.assertFalse(self.path.with_name("app.asar.tps.bak").exists())

    def test_legacy_upgrade_and_revert(self):
        old = dict(self.files)
        old[p.TPS_INDEX_PATH] = old[p.TPS_INDEX_PATH].replace(b"</body>", p.TPS_TAG.encode() + b"</body>")
        old[p.TPS_SCRIPT_PATH] = b"/* v1 */"
        archive(self.path, old)
        p.process_tps_footer(self.path, False, False, None)
        self.assertIn(p.TPS_BACKEND_PATH, read(self.path))
        p.process_tps_footer(self.path, False, True, None)
        self.assertEqual(read(self.path), self.files)

    def test_damaged_hook_is_rejected_without_mutation(self):
        self.files[p.TPS_MAIN_PATH] += b"/* zcode-tps-v2:begin */"
        archive(self.path, self.files)
        original = self.path.read_bytes()
        with self.assertRaises(ValueError):
            p.process_tps_footer(self.path, False, False, None)
        self.assertEqual(self.path.read_bytes(), original)

    def test_revert_removes_orphan_renderer(self):
        orphan = dict(self.files)
        orphan[p.TPS_SCRIPT_PATH] = b"/* orphan */"
        archive(self.path, orphan)
        p.process_tps_footer(self.path, False, True, None)
        self.assertEqual(read(self.path), self.files)



class LaunchFlowTest(unittest.TestCase):
    def test_launch_only_after_success(self):
        from unittest.mock import patch
        target = Path('example/resources/app.asar')
        cases = [([], None, True), (['--check'], None, False),
                 (['--revert'], None, False), ([], PermissionError('locked'), False)]
        for flags, error, should_launch in cases:
            with self.subTest(flags=flags, error=error), \
                 patch.object(p.sys, 'argv', ['patcher', '--tps-footer', *flags]), \
                 patch.object(p, '_resolve_asars', return_value=[target]), \
                 patch.object(p, 'process_tps_footer', side_effect=error), \
                 patch.object(p, 'launch_zcode') as launch:
                if error:
                    with self.assertRaises(SystemExit) as raised:
                        p.main()
                    self.assertEqual(raised.exception.code, 1)
                else:
                    p.main()
                self.assertEqual(launch.called, should_launch)

    def test_launch_failure_does_not_modify_patch(self):
        from unittest.mock import patch
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'ZCode.exe').touch()
            with patch.object(p.sys, 'platform', 'win32'), \
                 patch.object(p.subprocess, 'Popen', side_effect=OSError('cannot launch')) as start:
                p.launch_zcode(root / 'resources' / 'app.asar')
                self.assertEqual(start.call_args.args[0], [str(root / 'ZCode.exe')])

class StatisticsOnlyTest(unittest.TestCase):
    def test_target_needs_only_asar(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            archive_path = root / 'resources' / 'app.asar'
            archive_path.parent.mkdir()
            archive_path.touch()
            self.assertEqual(p.resolve_target(str(root)), [archive_path])
            self.assertEqual(p.resolve_target(str(archive_path)), [archive_path])

    def test_default_command_installs_statistics(self):
        from unittest.mock import patch
        target = Path('example/resources/app.asar')
        with patch.object(p.sys, 'argv', ['patcher']), \
             patch.object(p, '_resolve_asars', return_value=[target]), \
             patch.object(p, 'process_tps_footer') as apply, \
             patch.object(p, 'launch_zcode') as launch:
            p.main()
            apply.assert_called_once_with(target, False, False, None)
            launch.assert_called_once_with(target)


if __name__ == '__main__':
    unittest.main()
