# Artha OpenClaw image promotion

`.github/workflows/artha-image.yml` builds the ARM64 image and verifies the exported package, runtime CLI and sender-verification markers. Pull-request steps do not assume AWS roles. Main-branch builds publish immutable ECR image tags and build attestations.

The workflow builds reviewed runtime source `1090ebf9619d683e3a667add7de9b40bdde7a694`
from `artha/2026.9.1-office365`, independently of the workflow's main-branch commit.
That source matches NemoClaw's `2026.9.1` dependency graph and includes the signer.
Its earlier GHCR build was AMD64; this workflow rebuilds natively for ARM64 and
checks architecture, exported version and signer before publishing. Image labels,
tags and the NemoClaw promotion record use the runtime source SHA. Updating this
pin requires a reviewed workflow change and matching NemoClaw compatibility checks.

Configure `ARTHA_BUILD_ROLE_ARN` from the Terraform NemoClaw module. The workflow reads the ECR target from `/artha/prod/nemoclaw/deployment`.

The promotion job uses a GitHub App scoped to `artha-nemoclaw`. Configure its ID as `ARTHA_PROMOTION_APP_ID` and private key as `ARTHA_PROMOTION_APP_PRIVATE_KEY`. Its only repository permissions are Contents and Pull requests read/write.

Automation owns `automation/openclaw-image`. It opens or updates one PR changing `deploy/release.json`; it never merges or deploys that PR. The NemoClaw gate rejects an export version that differs from its reviewed dependency graph. An OpenClaw version bump must include the corresponding reviewed NemoClaw compatibility changes.

See `artha-nemoclaw/deploy/README.md` for deployment, bootstrap, production approval and recovery.

Checks:

```bash
python3 -m unittest discover -s scripts/artha -p 'test_*.py' -v
node --test scripts/artha/verify-export.test.mjs
```
