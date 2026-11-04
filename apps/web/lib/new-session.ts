/**
 * Start a fresh conversation: clearing the current session returns the app
 * to the welcome screen, where the user picks the project to bind to.
 */

import { useChatStore } from '@/stores/chat-store';
import { useSessionStore } from '@/stores/session-store';

export function startNewSession(): void {
  useSessionStore.getState().setCurrentSession(null);
  useChatStore.getState().clear();
}
