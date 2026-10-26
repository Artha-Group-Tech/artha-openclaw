import json
from pathlib import Path
import tempfile
import unittest
from promote import update

class PromotionTests(unittest.TestCase):
    def test_updates_only_the_reviewed_openclaw_pin(self):
        with tempfile.TemporaryDirectory() as temp:
            p = Path(temp) / 'deploy'; p.mkdir()
            (p / 'release.json').write_text(json.dumps({'base_image': 'unchanged', 'openclaw': {}}))
            image = '123456789012.dkr.ecr.ap-south-1.amazonaws.com/openclaw@sha256:' + 'a'*64
            update(temp, image, 'b'*40, '2026.9.1')
            result = json.loads((p / 'release.json').read_text())
            self.assertEqual(result['base_image'], 'unchanged')
            self.assertEqual(result['openclaw']['image'], image)
            self.assertEqual(result['openclaw']['commit'], 'b'*40)
    def test_rejects_mutable_or_injected_identity_before_writing(self):
        for image in ('latest', 'image;id'):
            with self.subTest(image=image), self.assertRaises(ValueError):
                update('/does/not/exist', image, 'b'*40, '2026.9.1')
