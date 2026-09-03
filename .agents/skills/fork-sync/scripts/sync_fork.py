#!/usr/bin/env python3

import argparse
import subprocess
import sys


def run(cmd, cwd, check=True, capture=True):
    result = subprocess.run(
        cmd,
        cwd=cwd,
        text=True,
        stdout=subprocess.PIPE if capture else None,
        stderr=subprocess.PIPE if capture else None,
        check=False,
    )
    if check and result.returncode != 0:
        stderr = result.stderr.strip() if result.stderr else ""
        stdout = result.stdout.strip() if result.stdout else ""
        message = stderr or stdout or f"command failed: {' '.join(cmd)}"
        raise SystemExit(message)
    return result


def git(cwd, *args, check=True, capture=True):
    return run(["git", *args], cwd=cwd, check=check, capture=capture)


def ensure_remote(cwd, remote):
    remotes = git(cwd, "remote").stdout.splitlines()
    if remote not in remotes:
        raise SystemExit(f"missing git remote: {remote}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Sync a fork with upstream and push to origin.")
    parser.add_argument("--repo", default=".", help="Path to the git repository")
    parser.add_argument("--branch", default=None, help="Branch to sync; defaults to the current branch")
    parser.add_argument("--remote-upstream", default="upstream", help="Upstream remote name")
    parser.add_argument("--remote-origin", default="origin", help="Origin remote name")
    parser.add_argument("--push", action="store_true", help="Push the final branch to origin")
    parser.add_argument("--allow-dirty", action="store_true", help="Allow uncommitted changes in the worktree")
    parser.add_argument("--dry-run", action="store_true", help="Print the planned actions without changing the repo")
    args = parser.parse_args()

    repo = args.repo

    branch = args.branch
    if branch is None:
        branch = git(repo, "branch", "--show-current").stdout.strip()
        if not branch:
            raise SystemExit("unable to determine current branch; pass --branch")

    status = git(repo, "status", "--short").stdout.strip()
    if status and not args.allow_dirty:
        raise SystemExit("working tree is dirty; commit or stash changes first, or pass --allow-dirty")

    print(f"branch: {branch}")
    print(f"origin: {args.remote_origin}")
    print(f"upstream: {args.remote_upstream}")

    ensure_remote(repo, args.remote_origin)
    ensure_remote(repo, args.remote_upstream)

    print("fetching remotes...")
    git(repo, "fetch", args.remote_origin)
    git(repo, "fetch", args.remote_upstream)

    ahead_behind = git(repo, "rev-list", "--left-right", "--count", f"{branch}...{args.remote_upstream}/master").stdout.strip()
    ahead, behind = (int(part) for part in ahead_behind.split())
    print(f"divergence vs {args.remote_upstream}/master: ahead {ahead}, behind {behind}")

    if ahead > 0:
        print(f"local-only commits ahead of {args.remote_upstream}/master:")
        print(git(repo, "log", "--oneline", f"{args.remote_upstream}/master..{branch}").stdout.rstrip())
    if behind > 0:
        print(f"upstream-only commits ahead of {branch}:")
        print(git(repo, "log", "--oneline", f"{branch}..{args.remote_upstream}/master").stdout.rstrip())

    if args.dry_run:
        print("dry run: no merge or push performed")
        return 0

    if behind > 0:
        print(f"merging {args.remote_upstream}/master into {branch}...")
        git(repo, "merge", f"{args.remote_upstream}/master", check=True, capture=False)
    else:
        print(f"{branch} is not behind upstream; skipping merge")

    post_status = git(repo, "status", "--short").stdout.strip()
    if post_status:
        print("warning: worktree is not clean after merge:")
        print(post_status)

    origin_divergence = git(repo, "rev-list", "--left-right", "--count", f"{branch}...{args.remote_origin}/master").stdout.strip()
    local_ahead, local_behind = (int(part) for part in origin_divergence.split())
    print(f"divergence vs {args.remote_origin}/master: ahead {local_ahead}, behind {local_behind}")

    if not args.push:
        print("push skipped; pass --push to publish to origin")
        return 0

    print(f"pushing {branch} to {args.remote_origin}...")
    git(repo, "push", args.remote_origin, branch, check=True, capture=False)
    print("push complete")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
