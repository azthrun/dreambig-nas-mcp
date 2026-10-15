/**
 * The write lock: one process-wide async mutex that serializes every change
 * the server makes to the Root (write, edit, mkdir, move, delete, Trash purge,
 * temp-file cleanup).
 *
 * Why: each tool resolves Paths (symlinks, Hidden Entry checks, Trash names)
 * and then acts on them across several awaits. Without the lock, two calls can
 * interleave between check and use: e.g. two overwrites pick the same free
 * Trash name, or a move swaps a folder for a symlink while another call is
 * writing into it. Serializing in-process closes those windows for everything
 * this server does. Read-only tools are not serialized.
 *
 * Residual risk: Node has no openat()/O_NOFOLLOW-relative APIs, so a change made
 * on the NAS itself (SMB, File Station, another process) between resolution and
 * use is not covered. Tools re-verify the resolved real parent folder right
 * before renaming (see `Sandbox.recheck`), which narrows but cannot close that
 * window. The Root has a single owner, so this is accepted.
 */
let tail: Promise<unknown> = Promise.resolve();

/** Run `fn` once every earlier `withWriteLock` call has settled. Not re-entrant. */
export function withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = tail.then(() => fn());
  tail = run.catch(() => {});
  return run;
}
