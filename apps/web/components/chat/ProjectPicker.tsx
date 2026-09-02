'use client';

import { Folder } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useConfigStore } from '@/stores/config-store';

interface ProjectPickerProps {
  value: string | null;
  onChange: (projectId: string) => void;
}

export function ProjectPicker({ value, onChange }: ProjectPickerProps) {
  const projects = useConfigStore((s) => s.projects);
  const items = projects.map((p) => ({ value: p.id, label: p.name }));

  return (
    <Select
      items={items}
      value={value}
      onValueChange={(next) => onChange(next as string)}
    >
      <SelectTrigger size="sm">
        <Folder className="h-3.5 w-3.5 text-gray-500" />
        <SelectValue placeholder="选择项目" />
      </SelectTrigger>
      <SelectContent>
        {projects.map((project) => (
          <SelectItem key={project.id} value={project.id}>
            {project.name}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
