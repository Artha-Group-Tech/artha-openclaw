#!/usr/bin/env python3
"""Prepare an upstream upgrade in a clean, disposable checkout; never deploy it."""
import argparse
import json
from pathlib import Path
import re
import subprocess

SHA = re.compile(r'[a-f0-9]{40}\Z')
TAG = re.compile(r'v(\d+\.\d+\.\d+)\Z')


def version(tag):
    match = TAG.fullmatch(tag)
    if not match:
        raise ValueError('Use an exact stable upstream tag, for example v2026.10.5')
    return match[1]


def git(root, *args):
    return subprocess.check_output(['git', '-C', str(root), *args], text=True).strip()


def runtime(root):
    c = json.loads((Path(root) / 'scripts/artha/runtime.json').read_text())
    ref = git(root, 'rev-parse', 'HEAD') if c['ref'] == 'self' else c['ref']
    if not SHA.fullmatch(ref) or not re.fullmatch(r'\d+\.\d+\.\d+', c['version']):
        raise ValueError('Runtime source must be self or an immutable SHA with an exact version')
    return {'ref': ref, 'version': c['version']}


def prepare(root, tag, upstream, patch):
    root = Path(root)
    wanted = version(tag)
    if not SHA.fullmatch(upstream):
        raise ValueError('Upstream must resolve to an immutable commit')
    if git(root, 'status', '--porcelain'):
        raise ValueError('Upgrade preparation requires a clean disposable checkout')
    base = git(root, 'rev-parse', 'HEAD')
    package = json.loads(git(root, 'show', upstream + ':package.json'))
    if package.get('name') != 'openclaw' or package.get('version') != wanted:
        raise ValueError('Upstream tag does not match the requested OpenClaw package version')
    current = json.loads((root / 'package.json').read_text())['version']
    if tuple(map(int, wanted.split('.'))) < tuple(map(int, current.split('.'))):
        raise ValueError('Automatic upgrades cannot downgrade the fork source')
    # Merge failures and patch conflicts stop the job before any remote push.
    git(root, 'merge', '--no-commit', '--no-ff', upstream)
    # Keep fork automation; importing upstream workflows would enable unrelated jobs.
    git(root, 'restore', '--source=' + base, '--staged', '--worktree', '--', '.github', 'scripts/artha')
    if json.loads((root / 'package.json').read_text()).get('version') != wanted:
        raise ValueError('Merged source does not match the requested version')
    applied = subprocess.run(['git', '-C', str(root), 'apply', '--reverse', '--check', str(patch)],
                             stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    if not applied:
        git(root, 'apply', '--check', str(patch))
        git(root, 'apply', str(patch))
    (root / 'scripts/artha/runtime.json').write_text(json.dumps({'ref': 'self', 'version': wanted}, indent=2) + '\n')
    return {'upstream_tag': tag, 'upstream_commit': upstream, 'version': wanted}


if __name__ == '__main__':
    p = argparse.ArgumentParser()
    p.add_argument('command', choices=['validate', 'runtime', 'prepare'])
    p.add_argument('--version')
    p.add_argument('--upstream')
    a = p.parse_args()
    root = Path(__file__).resolve().parents[2]
    if a.command == 'validate':
        print(version(a.version or ''))
    elif a.command == 'runtime':
        for k, v in runtime(root).items():
            print(k + '=' + v)
    else:
        print(json.dumps(prepare(root, a.version or '', a.upstream or '', Path(__file__).with_name('office365.patch'))))
