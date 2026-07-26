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

Override the port with an environment variable:

```powershell
$env:A_SHARE_REVIEW_PORT = "18766"
npm start
```

## Source Checks

```powershell
npm test
```

The checks verify that:

- Every JavaScript file passes `node --check`
- No private key is present in the repository
- Common secret and token patterns are absent
- Required pages, route mappings, and runtime assets are intact

## Windows Single-File Launcher

`windows-launcher/single-file-launcher.cs` is the source for the current self-extracting launcher. A complete runtime payload ZIP and its SHA256 must be embedded at build time.

The public repository does not contain production private keys, access tokens, or production data-service credentials. Self-built editions should use their own runtime payloads and legally authorized data.
