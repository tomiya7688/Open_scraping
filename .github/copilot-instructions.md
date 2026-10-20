# Open_scraping — GitHub Copilot repository instructions

**Repository-wide development rules are maintained exclusively in [AGENTS.md](../AGENTS.md).** Read and apply them before writing, suggesting, or reviewing changes. The [cross-tool handoff guide](../docs/developer/ai-collaboration.md) explains where evidence and progress should be recorded.

In particular: keep Core independent of concrete scraping/browser/model/storage behavior; treat component contracts and permissions as explicit boundaries; GUI/CLI must use the public API; distinguish plans/unmerged PRs from tested `main` functionality; and report real test results, not assumed success. Follow the full AGENTS.md for the actual requirements, PR workflow, and test commands.

Do not create a separate Copilot-only policy that conflicts with AGENTS.md.
