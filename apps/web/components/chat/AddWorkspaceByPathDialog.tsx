'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

interface AddWorkspaceByPathDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Create the workspace for a typed path; resolves to it, or null on failure. */
  onSubmit: (path: string) => Promise<unknown>;
  pending: boolean;
}

/**
 * The "add workspace" fallback for a gateway that cannot show a native dialog
 * (`capabilities.nativeDialogs === false`: `--serve-remote`). The dialog would
 * open on the GATEWAY's screen, so the path is typed instead — and it is a
 * path on the gateway's machine, which is what the form says.
 *
 * One field, two buttons: this is the fallback, not a second workflow.
 */
export function AddWorkspaceByPathDialog({
  open,
  onOpenChange,
  onSubmit,
  pending,
}: AddWorkspaceByPathDialogProps) {
  const t = useTranslations('chat');
  const [path, setPath] = useState('');

  const submit = () => {
    const value = path.trim();
    if (value === '' || pending) return;
    void onSubmit(value).then((result) => {
      if (result) setPath('');
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('workspace.pathTitle')}</DialogTitle>
          <DialogDescription>
            {t('workspace.pathDescription')}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-3"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label className="text-sm font-medium" htmlFor="workspace-path">
            {t('workspace.pathLabel')}
          </label>
          <Input
            id="workspace-path"
            autoFocus
            className="font-mono"
            placeholder={t('workspace.pathPlaceholder')}
            value={path}
            onChange={(event) => setPath(event.target.value)}
          />
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onOpenChange(false)}
            >
              {t('workspace.pathCancel')}
            </Button>
            <Button type="submit" disabled={pending || path.trim() === ''}>
              {pending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t('workspace.pathAdd')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
