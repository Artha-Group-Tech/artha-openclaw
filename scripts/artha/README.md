# Artha OpenClaw image promotion

`.github/workflows/artha-image.yml` builds the ARM64 image and verifies the exported package, runtime CLI and sender-verification markers. Pull-request steps do not assume AWS roles. Main-branch builds publish immutable ECR image tags and build attestations.

`scripts/artha/runtime.json` selects the reviewed runtime source. Its bootstrap
pin is `1090ebf9619d683e3a667add7de9b40bdde7a694` (`2026.9.1` with the signer).
After an upstream upgrade PR, `ref: self` builds the candidate checkout in CI
and the actual merged source commit on main. Image labels, release IDs and
NemoClaw promotion metadata always identify that runtime source commit.

## Request an upstream version

In **Actions → Artha OpenClaw image → Run workflow**, select **main** and enter
an exact stable tag such as `v2026.10.5` in **upstream_version**. The request:

1. Fetches that exact tag from `openclaw/openclaw` and checks its package version.
2. Merges the source in a disposable checkout, retaining the fork's `.github`
   automation and `scripts/artha` tooling.
3. Applies the reviewed Office365 customization patch, or confirms it is already
   applied. The patch comes from source commit `fe5bfd4ef3cad99f3db07688a57aa236994b647e`.
4. Opens a draft PR or updates `automation/openclaw-upgrade` for human review and explicitly
   dispatches its ARM64 validation workflow. It does not publish or deploy.

Merge or customization conflicts stop the request before it pushes a branch.
Resolve such upgrades manually; the workflow does not guess how to port security
controls. Automatic requests reject downgrades and prerelease tags. A new version
may also require NemoClaw dependency/runtime compatibility changes.

Enable **Settings → Actions → General → Allow GitHub Actions to create and
approve pull requests** in this fork for manual requests. The job uses the
repository's built-in token to create PRs and dispatch checks; it never approves
or merges a PR. No additional secret is needed for the manual input.

Leave **upstream_version** blank to build the committed source selection. A
successful published build displays its release ID (`sourceSHA-runID-attempt`)
in the job summary and `artha-openclaw-release` artifact. Copy that ID into
NemoClaw's **openclaw_release** input to request its pin-update PR.

Configure `ARTHA_BUILD_ROLE_ARN` from the Terraform NemoClaw module. The workflow reads the ECR target from `/artha/prod/nemoclaw/deployment`.

The automatic cross-repository promotion job uses a GitHub App scoped to
`artha-nemoclaw`. Configure its ID as `ARTHA_PROMOTION_APP_ID` and private key
as `ARTHA_PROMOTION_APP_PRIVATE_KEY`. Its only repository permissions are
Contents and Pull requests read/write. Manual release selection in NemoClaw
provides a same-repository alternative while that App is unconfigured.

Automation owns `automation/openclaw-image`. It opens or updates one PR changing `deploy/release.json`; it never merges or deploys that PR. The NemoClaw gate rejects an export version that differs from its reviewed dependency graph. An OpenClaw version bump must include the corresponding reviewed NemoClaw compatibility changes.

See `artha-nemoclaw/deploy/README.md` for deployment, bootstrap, production approval and recovery.

Checks:

```bash
python3 -m unittest discover -s scripts/artha -p 'test_*.py' -v
node --test scripts/artha/verify-export.test.mjs
```
