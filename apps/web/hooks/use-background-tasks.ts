'use client';

import { useMemo } from 'react';
import { useConversation } from '@/hooks/use-conversation';
import {
  collectBackgroundTasks,
  type BackgroundTaskItem,
} from '@/lib/background-tasks';

/** Current session's background sub-agent tasks, derived from the chat feed. */
export function useBackgroundTasks(): BackgroundTaskItem[] {
  const { messages } = useConversation();
  return useMemo(
    () => collectBackgroundTasks({ messages }),
    [messages],
  );
}
