# Security policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately to the repository maintainers through the configured private security channel. Include a concise impact description, affected version or commit, reproduction steps that do not contain real secrets, and any suggested mitigation. Do not open a public issue for an undisclosed vulnerability.

Immediately revoke and regenerate any GitHub App private key, webhook secret, provider credential, or admin token that may have been exposed. Remove secrets from shell history, CI logs, issue comments, screenshots, and uploaded artifacts where possible.

## Scope and expectations

PatchPaw is self-hosted and executes repository commands. It is not an OS sandbox. Operators are responsible for HTTPS/TLS, reverse-proxy configuration, service-account permissions, runtime-home ACLs, GitHub App installation scope, provider data policies, and stronger isolation for untrusted repositories.

The admin API uses same-origin write protection and short-lived HttpOnly sessions. `GET /api/setup` is intentionally unauthenticated but returns only public deployment status; it must never be extended with credentials, local paths, repository allowlists, or private GitHub metadata.

See [docs/SECURITY-MODEL.md](docs/SECURITY-MODEL.md) for the threat model and [README.md](README.md) for deployment guidance.
