/**
 * Derive the project name from the directory path chosen by the native
 * directory picker (see `apps/gateway/src/fs/directory-picker.ts`).
 *
 * The gateway can run on macOS, Linux, or Windows, so the path may use either
 * `/` (POSIX) or `\` (Windows) separators — splitting on `/` alone would turn
 * a Windows path like `C:\Users\leo\code\demo` into a single segment and use
 * the whole path as the name.
 *
 * The filesystem root has no basename; falling back to the path itself keeps
 * the name non-empty, which the gateway requires (`POST /projects` rejects an
 * empty `name`).
 */
export function deriveProjectName(path: string): string {
  const segments = path.split(/[/\\]/).filter(Boolean);
  return segments[segments.length - 1] ?? path;
}
