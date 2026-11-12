'use client';

import { useCallback, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { pickDirectory, ApiError } from '@/lib/config-api';
import {
  capabilityUnavailableMessage,
  nativeDialogsWithdrawn,
  useCapabilitiesStore,
} from '@/lib/capabilities';
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
 * The dialog runs on the GATEWAY's machine, so a remote instance withdraws it
 * (`capabilities.nativeDialogs === false`, `501 capability_unavailable`). In
 * that case the flow asks for a typed absolute path instead of opening a
 * dialog nobody can see, and a `501` that still slips through is reported as
 * such instead of as `capability_unavailable`.
 *
 * Resolves to the created project, or `null` if the user cancelled (dialog or
 * typed path), or the attempt was superseded by a later call — all silent, not
 * errors. A real failure is reported via a toast, since there is no dialog
 * left to show it in.
 */
export function useAddProject() {
  const t = useTranslations('chat');
  const addProject = useConfigStore((s) => s.addProject);
  // Only a stated `false` switches to the typed path; UNKNOWN keeps the
  // native picker, which is what every gateway did before the contract.
  const withdrawsDialogs = useCapabilitiesStore((s) =>
    nativeDialogsWithdrawn(s.capabilities),
  );
  const [pending, setPending] = useState(false);
  // Add workspace by typing an absolute path: open while `manual` is true.
  const [manual, setManual] = useState(false);
  const closeManual = useCallback(() => setManual(false), []);
  // The gateway has no cancel hook for an already-open native dialog, so an
  // abandoned attempt (superseded by a second call before the first
  // resolves) can still resolve later. This guards against acting on it.
  const attemptRef = useRef(0);

  /** One classification for every failure of the add flow. */
  const reportFailure = useCallback(
    (err: unknown): void => {
      const unavailable = capabilityUnavailableMessage(err, {
        picker: t('workspace.nativeDialogUnavailable'),
        reveal: t('workspace.nativeDialogUnavailable'),
      });
      if (unavailable !== undefined) {
        // A gateway that withdrew the dialog between boot and now: switch the
        // flow to the path it CAN serve instead of leaving the user with an
        // error toast alone.
        toast.error(unavailable);
        setManual(true);
        return;
      }
      const message =
        err instanceof ApiError && err.status === 409
          ? t('workspace.dialogBusy')
          : err instanceof Error
            ? err.message
            : t('workspace.addFailed');
      toast.error(message);
    },
    [t],
  );

  /** Create the workspace for `path`. Shared by both entry points. */
  const create = useCallback(
    async (rawPath: string, attempt: number): Promise<Project | null> => {
      const path = rawPath.trim();
      if (path === '') return null; // not a choice
      const project = await addProject({
        name: deriveProjectName(path),
        path,
      });
      if (attempt !== attemptRef.current) return null;
      toast.success(t('workspace.added', { name: project.name }));
      return project;
    },
    [addProject, t],
  );

  const run = useCallback(async (): Promise<Project | null> => {
    if (withdrawsDialogs) {
      // Nothing to open remotely: collect the path on the gateway's own
      // filesystem, which is the only path that means anything there.
      setManual(true);
      return null;
    }
    const attempt = ++attemptRef.current;
    setPending(true);
    try {
      const result = await pickDirectory();
      if (attempt !== attemptRef.current) return null;
      if (!result.path) return null; // user cancelled — not an error
      return await create(result.path, attempt);
    } catch (err) {
      if (attempt !== attemptRef.current) return null;
      reportFailure(err);
      return null;
    } finally {
      if (attempt === attemptRef.current) setPending(false);
    }
  }, [create, reportFailure, withdrawsDialogs]);

  /** Submit a typed absolute path (the remote-mode entry point). */
  const addByPath = useCallback(
    async (path: string): Promise<Project | null> => {
      const attempt = ++attemptRef.current;
      setPending(true);
      try {
        const project = await create(path, attempt);
        if (project !== null) setManual(false);
        return project;
      } catch (err) {
        if (attempt !== attemptRef.current) return null;
        reportFailure(err);
        return null;
      } finally {
        if (attempt === attemptRef.current) setPending(false);
      }
    },
    [create, reportFailure],
  );

  return { run, addByPath, manual, closeManual, pending };
}
