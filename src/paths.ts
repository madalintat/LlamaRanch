// Shared path-string helpers used by the chat composer chips/mentions and the
// Settings file-access chips, so a path renders the same everywhere. These are
// purely lexical (they never touch the filesystem) and handle both `/` and `\`.

/** Last path segment (the file or folder name), trailing slashes ignored. */
export function basename(p: string): string {
  const parts = p.replace(/[/\\]+$/, "").split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}

/** The directory portion (everything before the basename), forward-slashed and
 *  truncated from the left with an ellipsis once it exceeds `max`. */
export function shortenPath(p: string, max = 38): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  parts.pop(); // drop the basename
  const dir = parts.join("/");
  if (dir.length <= max) return dir;
  return "…" + dir.slice(dir.length - (max - 1));
}
