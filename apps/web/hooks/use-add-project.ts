'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { pickDirectory, ApiError } from '@/lib/config-api';
import { deriveProjectName } from '@/lib/project-name';
import { useConfigStore, type Project } from '@/stores/config-store';

/**
 * Opens the native directory dialog and, on a real selection, immediately
 * creates the workspace — no intermediate confirmation dialog. Shared by
 * every "add workspace" entry point (the sidebar button, the project
 * picker's own menu item, the welcome screen's empty-state prompt) so they
 * all get the same cancellation- and race-safe behaviour instead of three
 * separate copies of it.
 *
 * Resolves to the created project, or `null` if the user cancelled the
 * dialog or the attempt was superseded by a later call — both are silent,
 * not errors. A real failure is reported via a toast, since there is no
 * dialog left to show it in.
 */
export function useAddProject() {
  const t = useTranslations('chat');
  const addProject = useConfigStore((s) => s.addProject);
  const [pending, setPending] = useState(false);
  // The gateway has no cancel hook for an already-open native dialog, so an
  // abandoned attempt (superseded by a second call before the first
  // resolves) can still resolve later. This guards against acting on it.
  const attemptRef = useRef(0);

  const run = useCallback(async (): Promise<Project | null> => {
    const attempt = ++attemptRef.current;
    setPending(true);
    try {
      const result = await pickDirectory();
      if (attempt !== attemptRef.current) return null;
      if (!result.path) return null; // user cancelled — not an error

      const project = await addProject({
        name: deriveProjectName(result.path),
        path: result.path,
      });
      toast.success(t('workspace.added', { name: project.name }));
      return project;
    } catch (err) {
      if (attempt !== attemptRef.current) return null;
      const message =
        err instanceof ApiError && err.status === 409
          ? t('workspace.dialogBusy')
          : err instanceof Error
            ? err.message
            : t('workspace.addFailed');
      toast.error(message);
      return null;
    } finally {
      if (attempt === attemptRef.current) setPending(false);
    }
  }, [addProject]);

  return { run, pending };
}
