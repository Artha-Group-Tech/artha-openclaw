import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from upgrade import prepare, runtime, version


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True, stderr=subprocess.PIPE).strip()


class UpgradeTests(unittest.TestCase):
    def fixture(self, directory):
        root = Path(directory) / 'repo'; root.mkdir()
        git(root, 'init', '-b', 'main')
        git(root, 'config', 'user.name', 'Fixture')
        git(root, 'config', 'user.email', 'fixture@example.invalid')
        (root / '.github').mkdir()
        (root / '.github/owned.yml').write_text('fork automation\n')
        (root / 'scripts/artha').mkdir(parents=True)
        (root / 'scripts/artha/runtime.json').write_text(json.dumps({'ref': 'a'*40, 'version': '1.0.0'}))
        (root / 'package.json').write_text(json.dumps({'name': 'openclaw', 'version': '1.0.0'}))
        (root / 'transport.txt').write_text('upstream transport\n')
        git(root, 'add', '.'); git(root, 'commit', '-m', 'base')
        # A reviewed customization patch is data; preparing an upgrade never executes source.
        (root / 'signer.txt').write_text('reviewed signer\n')
        git(root, 'add', 'signer.txt')
        patch = Path(directory) / 'customization.patch'
        patch.write_text(git(root, 'diff', '--cached', '--binary') + '\n')
        git(root, 'reset', '--hard', 'HEAD')
        git(root, 'checkout', '-b', 'upstream')
        (root / 'package.json').write_text(json.dumps({'name': 'openclaw', 'version': '1.0.1'}))
        (root / '.github/owned.yml').write_text('unrelated upstream automation\n')
        git(root, 'add', '.'); git(root, 'commit', '-m', 'upstream release')
        upstream = git(root, 'rev-parse', 'HEAD')
        git(root, 'checkout', 'main')
        return root, upstream, patch

    def test_merges_selected_source_keeps_fork_automation_and_applies_customization(self):
        with tempfile.TemporaryDirectory() as d:
            root, upstream, patch = self.fixture(d)
            result = prepare(root, 'v1.0.1', upstream, patch)
            self.assertEqual(result['upstream_commit'], upstream)
            self.assertEqual(json.loads((root / 'package.json').read_text())['version'], '1.0.1')
            self.assertEqual((root / '.github/owned.yml').read_text(), 'fork automation\n')
            self.assertEqual((root / 'signer.txt').read_text(), 'reviewed signer\n')
            self.assertEqual(json.loads((root / 'scripts/artha/runtime.json').read_text()),
                             {'ref': 'self', 'version': '1.0.1'})

    def test_rejects_dirty_checkout_wrong_tag_and_patch_conflicts(self):
        for failure in ('dirty', 'wrong-tag', 'patch-conflict'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as d:
                root, upstream, patch = self.fixture(d)
                tag = 'v1.0.1'
                if failure == 'dirty':
                    (root / 'untracked').write_text('user work')
                elif failure == 'wrong-tag':
                    tag = 'v1.0.2'
                else:
                    (root / 'signer.txt').write_text('different customization\n')
                    git(root, 'add', '.'); git(root, 'commit', '-m', 'divergent customization')
                with self.assertRaises((ValueError, subprocess.CalledProcessError)):
                    prepare(root, tag, upstream, patch)
                self.assertNotEqual(json.loads((root / 'scripts/artha/runtime.json').read_text())['ref'], 'self')

    def test_input_and_runtime_identity_validation(self):
        for tag in ('latest', '../v1.0.1', 'v1.0.1;id', 'v1.0.1-rc.1', '--help'):
            with self.subTest(tag=tag), self.assertRaises(ValueError):
                version(tag)
        with tempfile.TemporaryDirectory() as d:
            root, _, _ = self.fixture(d)
            self.assertEqual(runtime(root)['ref'], 'a'*40)
            (root / 'scripts/artha/runtime.json').write_text(json.dumps({'ref': 'self', 'version': '1.0.0'}))
            self.assertEqual(runtime(root)['ref'], git(root, 'rev-parse', 'HEAD'))


if __name__ == '__main__':
    unittest.main()
