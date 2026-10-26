#!/usr/bin/env python3
"""Update the reviewed NemoClaw dependency pin on a single automation branch."""
import argparse
import json
from pathlib import Path
import re


def update(checkout, image, commit, version):
    if not re.fullmatch(r'\d{12}\.dkr\.ecr\.[a-z0-9-]+\.amazonaws\.com/[a-z0-9/_-]+@sha256:[a-f0-9]{64}', image):
        raise ValueError('Expected immutable ECR image')
    if not re.fullmatch(r'[0-9a-f]{40}', commit) or not re.fullmatch(r'\d+\.\d+\.\d+', version):
        raise ValueError('Invalid OpenClaw export identity')
    path = Path(checkout) / 'deploy/release.json'
    c = json.loads(path.read_text())
    # Always open the review PR. The NemoClaw compatibility gate rejects mismatched versions.
    c['openclaw'] = {'image': image, 'commit': commit, 'version': version}
    path.write_text(json.dumps(c, indent=2) + '\n')

if __name__ == '__main__':
    p = argparse.ArgumentParser()
    for name in ('checkout', 'image', 'commit', 'version'):
        p.add_argument('--' + name, required=True)
    update(**vars(p.parse_args()))
