'use client';

import { useRef, useState } from 'react';
import { FolderOpen } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useConfigStore } from '@/stores/config-store';
import { pickDirectory } from '@/lib/config-api';

interface AddProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Derive the project name from the directory.
 *
 * The filesystem root has no basename; falling back to the path itself keeps
 * the name non-empty, which the gateway requires.
 */
function deriveName(path: string): string {
  const segments = path.split('/').filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

export function AddProjectDialog({ open, onOpenChange }: AddProjectDialogProps) {
  const addProject = useConfigStore((s) => s.addProject);
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [saving, setSaving] = useState(false);

  // The dialog stays mounted while hidden (see Sidebar), and a pick in flight
  // has no cancellation hook on the server side — the native dialog keeps
  // running regardless of what the client does. So an abandoned attempt
  // (closed via 取消 / ESC / overlay click, or superseded by a fresh pick)
  // can still resolve later. Bumping this on every attempt and closing lets
  // the resolution handler recognise it no longer belongs to the current
  // attempt and skip writing stale state into a possibly-reopened dialog.
  const attemptRef = useRef(0);

  const close = () => {
    attemptRef.current += 1;
    // Reset so reopening the dialog does not show the previous selection.
    setPath(null);
    setError(null);
    onOpenChange(false);
  };

  const choose = async () => {
    const attempt = ++attemptRef.current;
    setPicking(true);
    setError(null);
    try {
      const result = await pickDirectory();
      if (attempt !== attemptRef.current) return; // abandoned — ignore
      // A cancelled dialog is an ordinary outcome, not something to report.
      if (result.path) setPath(result.path);
    } catch (err) {
      if (attempt !== attemptRef.current) return; // abandoned — ignore
      setError(err instanceof Error ? err.message : '无法打开目录选择器');
    } finally {
      if (attempt === attemptRef.current) setPicking(false);
    }
  };

  const submit = async () => {
    if (!path) return;
    setSaving(true);
    setError(null);
    try {
      await addProject({ name: deriveName(path), path });
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>添加项目</DialogTitle>
          <DialogDescription>
            选择一个本地目录，会话将在该目录下运行。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Button
            variant="outline"
            className="w-full justify-start gap-2"
            onClick={choose}
            disabled={picking || saving}
          >
            <FolderOpen className="h-4 w-4" />
            {picking ? '正在选择…' : '选择目录'}
          </Button>

          {path && (
            <div className="rounded-md border px-3 py-2 text-sm">
              <div className="font-medium">{deriveName(path)}</div>
              <div className="mt-0.5 break-all font-mono text-xs text-gray-500">{path}</div>
            </div>
          )}

          {error && <p className="text-xs text-red-600">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={close} disabled={saving}>
            取消
          </Button>
          <Button onClick={submit} disabled={!path || saving || picking}>
            {saving ? '添加中…' : '添加'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
