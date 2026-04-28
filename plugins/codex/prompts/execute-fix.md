<task>
Run all tests (unit, contract, behavioral) and make them pass.

Test files (read-only, do not modify):
{{TEST_FILES_LIST}}

Implementation files (may modify):
{{IMPL_FILES_LIST}}

Working directory: {{REPO_PATH}}
</task>

<default_follow_through_policy>
If tests fail, fix the implementation code to make them pass. The tests are correct — adapt the implementation to match.
If you believe a test itself is wrong (unreasonable assertion), stop and explain why instead of modifying it.
</default_follow_through_policy>

<completeness_contract>
Resolve the task fully. All tests must pass before stopping.
</completeness_contract>

<pre_coding_preparation>
Before fixing implementation code:
1. Follow the common-skills:review-checklist skill standards. Your fixes must not introduce violations the review agent will flag.
2. Find the project's lint configuration files. Read them so your fixes also pass lint.
</pre_coding_preparation>

<action_safety>
Do not modify test files.
Do not execute git commit or git push.
Do not add transparent fallbacks, graceful degradation, or backwards-compatibility shims to make tests pass. Fix the actual logic.
</action_safety>
