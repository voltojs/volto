'use client';

import { Folder, FolderPlus, Loader2 } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConfigStore } from '@/stores/config-store';
import { useAddProject } from '@/hooks/use-add-project';

interface ProjectPickerProps {
  value: string | null;
  onChange: (projectId: string) => void;
}

/** Sentinel for the inline "add a workspace" action — never a real project id. */
const ADD_PROJECT_VALUE = '__add_project__';

export function ProjectPicker({ value, onChange }: ProjectPickerProps) {
  const projects = useConfigStore((s) => s.projects);
  const { run: addProjectViaPicker, pending } = useAddProject();
  const items = projects.map((p) => ({ value: p.id, label: p.name }));

  const handleValueChange = (next: unknown) => {
    if (next === ADD_PROJECT_VALUE) {
      // Selecting this item never becomes the picker's actual value — only a
      // project created via the flow below does, through `onChange`.
      void addProjectViaPicker().then((project) => {
        if (project) onChange(project.id);
      });
      return;
    }
    onChange(next as string);
  };

  return (
    <Select items={items} value={value} onValueChange={handleValueChange}>
      <SelectTrigger size="sm" className="font-mono">
        <Folder className="text-primary/80 h-3.5 w-3.5" />
        <SelectValue placeholder="选择工作区" />
      </SelectTrigger>
      <SelectContent alignItemWithTrigger={false}>
        <SelectGroup>
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id}>
              {project.name}
            </SelectItem>
          ))}
          {projects.length > 0 && <SelectSeparator />}
          <SelectItem value={ADD_PROJECT_VALUE} disabled={pending}>
            {pending ? (
              <Loader2 className="text-muted-foreground h-3.5 w-3.5 animate-spin" />
            ) : (
              <FolderPlus className="text-muted-foreground h-3.5 w-3.5" />
            )}
            {pending ? '正在等待系统对话框…' : '添加工作区'}
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
