# Desktop Edition GitHub Updates

The distributed Member, Basic, and Custom Windows launchers can update themselves from this repository. Basic edition support starts with `2.21.10`; users must replace an older Basic launcher once before future updates can be installed in the application.

## User Flow

1. The application checks its edition-specific manifest after startup and every 30 minutes.
2. When a newer semantic version is available, the toolbar button changes to `更新至 x.y.z`.
3. The user clicks the button. The local service downloads the release asset from GitHub.
4. The downloaded executable must match the manifest size and SHA-256 and must contain a Windows PE header.
5. A hidden helper replaces the launcher, restarts the application, and removes the rollback copy after the new local service reports the expected version.
6. The stable runtime keeps local review history and removes only obsolete launcher files from the same edition.

The update button is not membership-gated.

## Release Contract

The stable manifests and release asset names are:

| Edition | Manifest | Release asset |
| --- | --- | --- |
| Member | `updates/member.json` | `Da-A-Hou-Qin-Bu-v<version>.exe` |
| Basic | `updates/basic.json` | `A-Share-Review-Basic-v<version>.exe` |
| Custom | `updates/custom.json` | `A-Share-Review-Custom-Shortline-v<version>.exe` |

For each release:

1. Update the source, launcher version, runtime tag policy, changelog, and tests.
2. Build and test the target edition executable.
3. Calculate the exact executable byte size and SHA-256.
4. Create the GitHub release and upload the executable asset.
5. Update the matching edition manifest only after the release asset is available.
6. Verify the raw manifest, direct download, hash, and an old-to-new upgrade simulation.

Do not publish an update manifest that points to an unavailable or unverified asset.
