# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |

## Automated Dependency Updates

Dependabot monitors npm dependencies and GitHub Actions. Routine version-update PRs are disabled for both ecosystems with `open-pull-requests-limit: 0` in [`.github/dependabot.yml`](.github/dependabot.yml). The required weekly schedule does not enable routine PRs or delay security updates.

| Alert | Handling |
| --- | --- |
| Critical / High | Automatically request a security-fix PR when a patch is available, unless GitHub's low-impact preset has already dismissed the alert. Review each fix separately and merge after impact review and CI. |
| Medium (`moderate`) / Low | Keep the alert visible for review without automatically requesting a PR. |
| Low-impact development dependencies | Keep GitHub's **Dismiss low-impact alerts for development-scoped dependencies** preset enabled. It applies to selected alerts, not all development dependencies. |

Configure severity separately in [Dependabot rules](https://github.com/hndrr/capture-relay/settings/dependabot_rules):

- Enable **Security PRs for Critical and High**, targeting `severity:critical severity:high`. Repeating `severity:` means OR; do not use comma-separated values.
- Select **Open a pull request to resolve alerts** and leave **Dismiss alerts** unchecked. Keep security fixes in individual PRs rather than grouping them.
- Keep the low-impact development-dependency preset enabled and **Dismiss package malware alerts** disabled.

In [Advanced Security settings](https://github.com/hndrr/capture-relay/settings/security_analysis), keep **Dependabot alerts** enabled and **Grouped security updates** disabled. Leave the repository-wide **Dependabot security updates** toggle disabled: it requests PRs for all severities and overrides the selective rule. This toggle does not disable alerts or security-fix PRs requested by the rule. See [GitHub's auto-triage documentation](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/manage-your-dependency-security/auto-triage-dependabot-alerts).

Inspect existing Critical / High alerts individually and request a security update if necessary; do not assume a newly created rule will generate PRs for existing alerts. CodeQL continues to scan pushes and PRs to `main` and runs weekly, independently of this dependency PR policy.

## Reporting a Vulnerability

If you discover a security vulnerability in this repository, please report it privately via GitHub Security Advisories instead of opening a public issue.

1. Open the **Security** tab of this repository.
2. Select **Advisories** -> **Report a vulnerability**.
3. Provide details and reproduction steps so the issue can be investigated and addressed.
