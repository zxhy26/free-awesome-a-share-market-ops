# Build and Run

## Requirements

- Windows 10 or Windows 11
- Node.js 20 or later
- PowerShell 5.1 or later
- Microsoft Edge WebView2 Runtime for desktop packaging

## Start the Local Service

Run from the repository root:

```powershell
npm start
```

The default URL is:

```text
http://127.0.0.1:18765/app/
```

During A-share trading sessions the dashboard reads the live sector-flow endpoint once per second:

```text
GET /api/v1/live/sector-flows
POST /api/v1/live/sector-flows/refresh
```

The GET route publishes secondary-industry and concept-sector rankings atomically only after both official-source responses pass row-count and source-time validation. The POST route powers the manual synchronization control. Lunch and close freeze the last real snapshot; the service does not extrapolate fund amounts.

Override the port with an environment variable:

```powershell
$env:A_SHARE_REVIEW_PORT = "18766"
npm start
```

## Source Checks

```powershell
npm test
```

Run the opt-in real-network live-service integration check when the official sources are reachable:

```powershell
npm run test:live
```

The checks verify that:

- Every JavaScript file passes `node --check`
- No private key is present in the repository
- Common secret and token patterns are absent
- Required pages, route mappings, and runtime assets are intact
- The one-second live-sector-flow route, official amount field, and atomic source-time contract are intact

## Windows Single-File Launcher

`windows-launcher/single-file-launcher.cs` is the source for the current self-extracting launcher. A complete runtime payload ZIP and its SHA256 must be embedded at build time.

Build and validate a launcher from an existing payload:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-single-file-launcher.ps1 `
  -PayloadRoot "D:\path\to\payload" `
  -OutputPath "D:\path\to\release.exe" `
  -Edition Member
```

Use `Basic` or `Self` only with a matching payload. `Basic` requires the quantitative runtime and rejects activation-code administration files or a signing private key. `Self` requires both the quantitative runtime and the private issuer assets. The script compiles to a temporary directory, verifies payload extraction and SHA256, copies the validated executable to the requested output path, and removes its temporary files. Pass `-CertificateThumbprint` only when a trusted code-signing certificate is installed.

The public repository does not contain production private keys, access tokens, or production data-service credentials. Self-built editions should use their own runtime payloads and legally authorized data.
