/**
 * The glyph a tool gets in the trace gutter.
 *
 * A lookup rather than something derived from the tool's schema: the icon is a
 * scanning aid ("that line was a shell command"), so the mapping is chosen for
 * recognition, not for semantic completeness. Unknown tools fall back to a
 * neutral wrench — never to no icon, which would make their rows look like
 * reasoning.
 */

import {
  Bot,
  FilePlus2,
  FileText,
  FolderSearch,
  Globe,
  ListChecks,
  Pencil,
  Search,
  Terminal,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  bash: Terminal,
  bash_output: Terminal,
  read_file: FileText,
  write_file: FilePlus2,
  edit_file: Pencil,
  glob: FolderSearch,
  grep: Search,
  web_fetch: Globe,
  web_search: Globe,
  task: Bot,
  todo_write: ListChecks,
};

/** Icon for a tool name; `undefined` names get the neutral glyph. */
export function toolIcon(name: string): LucideIcon {
  return ICONS[name] ?? Wrench;
}
