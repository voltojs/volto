import type { Session } from '@/stores/session-store';

/** A minimal server-summary-shaped session for store/hook tests. */
export function summary(id: string): Session {
  return {
    id,
    title: '',
    messages: [],
    messageCount: 0,
    detailLoaded: false,
    createdAt: 0,
    updatedAt: 0,
    projectId: null,
    providerId: null,
    modelId: null,
    permissionMode: 'ask',
  };
}
