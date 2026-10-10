// `in-ctrl review merge [--apply]`: approving a branch means "merge it". The
// branches are stacked, so the base branch moves forward to the last branch of
// the unbroken run of approved branches right after it (a fast-forward;
// nothing is rewritten). A later approval waits until the branches before it
// are approved too. With review.publicRemote, --apply also pushes the base
// branch there.

import { execFileSync } from "node:child_process";
import { readComments } from "../comments.mjs";

/** What would be merged (and with `apply`, merge it); returns the lines to print. */
export function mergeApproved(project, { apply = false } = {}) {
  const config = project.review;
  const base = config.baseBranch;
  const git = (...args) => execFileSync("git", args, { cwd: config.repo, encoding: "utf8" }).trim();
  const isAncestor = (a, b) => {
    try {
      execFileSync("git", ["merge-base", "--is-ancestor", a, b], { cwd: config.repo });
      return true;
    } catch {
      return false;
    }
  };

  const reviews = readComments(project.comments).reviews;
  const merged = (b) => [base, ...(config.mergedRefs ?? [])].some((ref) => isAncestor(b, ref));
  const pending = git("branch", "--list", `${config.branchPrefix}*`, "--format=%(refname:short)")
    .split("\n")
    .filter(Boolean)
    .sort()
    .filter((b) => !merged(b));
  let target = null;
  for (const branch of pending) {
    if (reviews[branch]?.verdict !== "approve") break;
    target = branch;
  }
  if (!target) {
    const blocked = pending.find((b) => reviews[b]?.verdict === "approve");
    return [blocked ? `Nothing to merge: ${blocked} is approved, but ${pending[0]} before it isn't yet.` : "Nothing approved to merge."];
  }
  const waiting = pending.filter((b) => reviews[b]?.verdict === "approve" && b > target);
  const out = [`Merge ${pending.indexOf(target) + 1} branch(es) into ${base}: up to ${target}.${waiting.length ? ` Waiting: ${waiting.join(", ")}.` : ""}`];
  if (!apply) return out;

  const worktree = git("worktree", "list", "--porcelain")
    .split("\n\n")
    .find((entry) => entry.includes(`branch refs/heads/${base}\n`) || entry.endsWith(`branch refs/heads/${base}`))
    ?.match(/^worktree (.*)$/m)?.[1];
  if (!worktree) throw new Error(`${base} isn't checked out anywhere`);
  if (execFileSync("git", ["status", "--porcelain"], { cwd: worktree, encoding: "utf8" }).trim()) {
    throw new Error(`${worktree} has uncommitted changes; not merging`);
  }
  execFileSync("git", ["merge", "--ff-only", "--quiet", target], { cwd: worktree, stdio: "inherit" });
  out.push(`${base} is now at ${target} (${git("rev-parse", "--short", base)}).`);
  if (config.publicRemote) {
    execFileSync("git", ["push", "--quiet", config.publicRemote, `${base}:${base}`], { cwd: worktree, stdio: "inherit" });
    out.push(`Pushed ${base} to ${config.publicRemote}.`);
  }
  return out;
}
