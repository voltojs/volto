'use client';

/**
 * Fetches the gateway's capability facts once, when the app boots.
 *
 * `useAddProject` reads `capabilities.nativeDialogs` to decide between the
 * native directory dialog and a typed path, so the fetch has to start at
 * mount rather than when that flow is first opened. It renders nothing: a
 * capability lookup must never block or break the shell.
 */
import { useEffect } from 'react';
import { loadCapabilities } from '@/lib/capabilities';

export function CapabilitiesBoot() {
  useEffect(() => {
    void loadCapabilities();
  }, []);
  return null;
}
