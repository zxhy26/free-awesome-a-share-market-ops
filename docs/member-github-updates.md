# Member Edition GitHub Updates

Starting with `2.18.0`, the distributed `大a后勤部.exe` can update itself from this repository.

## User Flow

1. The application checks `updates/member.json` after startup and every 30 minutes.
2. When a newer semantic version is available, the toolbar button changes to `更新至 x.y.z`.
3. The user clicks the button. The local service downloads the release asset from GitHub.
4. The downloaded executable must match the manifest size and SHA-256 and must contain a Windows PE header.
5. A hidden helper replaces the launcher, restarts the application, and removes the rollback copy after the new local service reports the expected version.
6. The stable runtime keeps local review history; the first updater-enabled launch also imports history from the newest legacy Member runtime.

The update button is not membership-gated.

## Release Contract

The stable manifest is:

```text
https://raw.githubusercontent.com/zxhy26/free-awesome-a-share-market-ops/main/updates/member.json
```

The release asset name is:

```text
Da-A-Hou-Qin-Bu-v<version>.exe
```

For each release:

1. Update the source, launcher version, runtime tag policy, changelog, and tests.
2. Build and test the Member executable.
3. Calculate the exact executable byte size and SHA-256.
4. Create the GitHub release and upload the executable asset.
5. Update `updates/member.json` only after the release asset is available.
6. Verify the raw manifest, direct download, hash, and an old-to-new upgrade simulation.

Do not publish an update manifest that points to an unavailable or unverified asset.
