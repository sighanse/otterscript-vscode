# Security Policy

## Supported Versions

This project is under active development.
Only the latest published version of the extension is supported for security fixes.

## Reporting a Vulnerability

If you believe you have discovered a **security vulnerability** in this extension:

- Please use **GitHub’s Private Vulnerability Reporting** feature (via the **Security** tab).
- Do **not** disclose security issues publicly until they have been reviewed and addressed.

If private reporting is not available for any reason, you may contact the maintainer directly if private contact information is available.

Please include:

- A clear description of the issue
- Steps to reproduce the problem (if applicable)
- Any relevant configuration or environment details

We will respond as quickly as reasonably possible and work to address verified issues.

## Scope

This extension:

- Runs entirely within the VS Code extension host
- Does not execute user‑provided scripts
- Does not transmit data externally on its own
- Does not access network resources, credentials, or system APIs beyond those provided by VS Code

Security reports should focus on issues such as:

- Unintended execution of code
- Data exposure or leakage
- Privilege escalation within the VS Code environment

General bugs, feature requests, and usability issues should be reported using standard GitHub issues.
