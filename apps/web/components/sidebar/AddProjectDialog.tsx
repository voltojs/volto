'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useConfigStore } from '@/stores/config-store';

interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddProjectDialog({ open, onOpenChange }: AddProjectDialogProps) {
  const addProject = useConfigStore((s) => s.addProject);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      // The gateway validates that the path exists and is a directory;
      // surfacing its message is more useful than guessing client-side.
      await addProject({ name: name.trim(), path: path.trim() });
      setName('');
      setPath('');
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加项目</DialogTitle>
          <DialogDescription>指定一个本地目录，会话将在该目录下运行。</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Input
            placeholder="项目名称"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            placeholder="绝对路径，如 /Users/me/code/demo"
            value={path}
            onChange={(e) => setPath(e.target.value)}
          />
          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={!name.trim() || !path.trim() || saving}>
            {saving ? '添加中…' : '添加'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
