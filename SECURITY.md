# Security policy

## Supported versions

Security fixes are provided for the latest version published to npm.

| Release | Supported |
| --- | --- |
| Latest npm release | Yes |
| Older releases | No |
| Unreleased forks or modified builds | No |

Users should upgrade both this package and its MCP runtime before reporting a problem:

```bash
pi update npm:pi-agent-plugins
pi update npm:pi-mcp-adapter
```

## Reporting a vulnerability

**Do not open a public issue for a suspected vulnerability.**

Report vulnerabilities privately through the repository's [GitHub security advisory form](https://github.com/BlockedPath/pi-agent-plugins/security/advisories/new). If private reporting is unavailable, contact the maintainer through the [BlockedPath GitHub profile](https://github.com/BlockedPath) and request a private channel without including vulnerability details in the initial public message.

Include as much of the following as is safe and relevant:

- affected `pi-agent-plugins`, Pi, Node.js, and `pi-mcp-adapter` versions
- operating system and architecture
- vulnerability type and potential impact
- minimal reproduction steps or proof of concept
- whether exploitation requires plugin installation, project trust, or MCP trust
- affected files, commands, paths, transports, or configuration fields
- known mitigations or workarounds
- any planned disclosure timeline

Remove unrelated credentials, access tokens, private URLs, and personal data.

## Response process

The maintainer will make a best effort to:

1. acknowledge a complete report within three business days
2. validate the issue and assess its severity
3. keep the reporter informed at least once every seven days while remediation is active
4. develop and test a fix without exposing report details
5. publish an npm patch and GitHub security advisory when appropriate
6. credit the reporter unless they request anonymity

These targets are goals rather than a service-level agreement. Incomplete reports, unavailable maintainers, or complex upstream dependencies may require more time.

## Security scope

Reports are especially useful when they involve:

- command or argument injection
- unintended shell or secret-expression evaluation
- path traversal, symlink escape, or containment bypass
- trust transfer between plugin instances or scopes
- MCP configuration ownership or deletion of user-authored entries
- reserved environment-variable override
- cross-origin credential or header disclosure
- activation of an untrusted MCP server
- unsafe plugin installation or archive extraction
- a manifest-validation bypass with a concrete security impact

The following are generally outside this project's direct security scope:

- malicious behavior that occurs only after a user knowingly reviews, installs, and trusts a third-party plugin
- vulnerabilities exclusively in Pi, Node.js, npm, `pi-mcp-adapter`, or an MCP server, unless this project creates or materially increases the impact
- social engineering without a technical vulnerability
- denial of service requiring control of the local user account
- reports based only on unsupported versions

Upstream issues may be redirected to the affected project. The maintainer will help coordinate when the boundary is unclear.

## Disclosure policy

Please allow reasonable time to investigate and release a fix before public disclosure. Do not publish proof-of-concept code, exploit details, or identifying information while a report is under active remediation.

After a fix is available, the project may publish:

- a patched npm release
- a GitHub security advisory and CVE, when appropriate
- upgrade or mitigation instructions
- acknowledgment of the reporter

The project will not intentionally disclose a reporter's identity without permission.

## Security model

Agent Skills can influence model behavior, and trusted MCP servers execute with the user's permissions. Agent Plugins 1.0.0 does not define signatures, sandboxing, portable permissions, portable secrets, or plugin provenance. Review third-party plugin source before installation and grant MCP trust only to plugins you understand.

See [CONFORMANCE.md](./CONFORMANCE.md) and the README's security section for the implemented containment and trust boundaries.
