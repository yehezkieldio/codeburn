---
name: fork-sync
description: Sync a local fork of codeburn with upstream, reconcile local commits, and push the result to origin. Use when the user asks to "sync with upstream", "merge upstream", "update my fork", "account for new commits", or needs a repeatable fork-reconciliation workflow.
---

# Fork Sync

Use this skill to keep the local fork aligned with `upstream/master` and publish the result to `origin/master`.

## Workflow

1. Inspect remotes and branch state.
2. Fetch `upstream` and `origin`.
3. Determine the fork base, local-only commits, and upstream-only commits.
4. Merge `upstream/master` into the current branch if the branch is behind upstream.
5. Resolve conflicts carefully, preserving local fork changes unless the upstream change is clearly authoritative.
6. Verify the working tree is clean and the branch is ahead of `origin/master` by the expected amount.
7. Push the reconciled branch to `origin`.

## Change Handling

- Prefer a merge-based sync for this fork unless the user explicitly requests a rebase.
- Treat new local commits as first-class changes. Do not discard them just because upstream diverged.
- When upstream changes touch the same files as local commits, inspect both sides and keep the minimal correct fix.
- If the sync introduces generated or lockfile churn, verify it is expected before pushing.
- If push authentication fails, stop after verifying the local branch state and report the blocker.

## Script

Use the bundled `scripts/sync_fork.py` for the repeatable sync flow.

Typical use:

```bash
python .agents/skills/fork-sync/scripts/sync_fork.py --repo . --push
```

Useful flags:

- `--remote-upstream` to override the upstream remote name
- `--remote-origin` to override the fork remote name
- `--branch` to sync a branch other than the current branch
- `--dry-run` to inspect planned actions without mutating the repo

## Notes

- This skill assumes the repository already has both `origin` and `upstream` configured.
- If the repo has uncommitted changes, the script reports them and stops unless `--allow-dirty` is supplied.
- If upstream is unavailable, fetch failure is treated as a blocking error instead of guessing.
