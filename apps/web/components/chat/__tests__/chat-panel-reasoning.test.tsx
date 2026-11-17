/**
 * Welcome-screen reasoning default: the global `lastReasoningEffort`
 * preference is only a candidate when the selected model still declares that
 * tier. A tier deleted from the model's table must never survive in the
 * request — the picker would not show it while the gateway rejects it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ChatPanel } from '../ChatPanel';
import { useSessionStore } from '@/stores/session-store';
import { useChatStore } from '@/stores/chat-store';
import { usePaneStore } from '@/stores/pane-store';
import { useConfigStore } from '@/stores/config-store';
import { usePreferencesStore } from '@/stores/preferences-store';
import type { Preferences } from '@/lib/preferences';

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
}));

vi.mock('@/hooks/use-chat-agent', () => ({
  useChatAgent: () => ({
    sendMessage: mocks.sendMessage,
    stopGeneration: vi.fn(),
    connectionState: 'connected',
    getApprovalToken: () => null,
  }),
}));

vi.mock('@/hooks/use-conversation', () => ({
  useConversation: () => ({ entries: [], usage: null, messages: [] }),
}));

vi.mock('@/hooks/use-auto-open-tasks-tab', () => ({
  useAutoOpenTasksTab: () => {},
}));

vi.mock('@/hooks/use-add-project', () => ({
  useAddProject: () => ({ run: vi.fn(async () => null), pending: false }),
}));

vi.mock('@/hooks/use-server-sessions', () => ({
  ensureSessionDetail: vi.fn(async () => {}),
  needsQueueResync: vi.fn(() => false),
  refreshServerSessions: vi.fn(async () => {}),
}));

vi.mock('@/lib/sessions-api', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  fetchPlan: vi.fn(async () => null),
  fetchServerTrajectory: vi.fn().mockResolvedValue(null),
}));

vi.mock('@/components/pane/RightPane', () => ({
  RightPane: () => null,
}));

vi.mock('@/components/chat/InputBar', () => ({
  InputBar: (props: {
    onSend?: (payload: { text: string; attachments: string[] }) => void;
  }) => (
    <button
      type="button"
      data-testid="stub-send"
      onClick={() => props.onSend?.({ text: 'hi', attachments: [] })}
    >
      stub-send
    </button>
  ),
}));

const EFFORTS = [
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
];

/** The welcome screen with a model that only still declares low/high. */
function seedWelcome(preferences: Preferences) {
  useSessionStore.setState({
    currentSessionId: null,
    pendingProjectId: 'proj-1',
    planPreviousMode: null,
    sessions: [],
  });
  useConfigStore.setState({
    projects: [{ id: 'proj-1', name: 'P', path: '/tmp/p', createdAt: 0 }],
    providers: [
      {
        id: 'prov-1',
        name: 'P',
        models: [
          {
            id: 'm1',
            code: 'model-1',
            reasoning: { efforts: EFFORTS, defaultEffort: 'low' },
          },
        ],
      },
    ] as never,
    catalogProviders: [],
  });
  usePreferencesStore.setState({
    loaded: true,
    preferences: {
      lastProviderId: 'prov-1',
      lastModelId: 'm1',
      ...preferences,
    },
  });
  useChatStore.getState().clear();
  usePaneStore.setState({
    tabs: [],
    activeTabId: null,
    open: false,
    hidden: false,
    snapshots: {},
    activeSessionKey: null,
  });
}

/** Sends on the welcome screen and returns the effort the draft recorded. */
async function welcomeEffort(): Promise<string | undefined> {
  render(<ChatPanel />);
  fireEvent.click(screen.getByTestId('stub-send'));
  await waitFor(() =>
    expect(useSessionStore.getState().sessions).toHaveLength(1),
  );
  return useSessionStore.getState().sessions[0]?.reasoningEffort;
}

describe('ChatPanel welcome-screen reasoning default', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.localStorage.clear();
  });

  it('does not adopt a global preference the model no longer declares', async () => {
    // The preference still says `medium`, but the model only offers low/high.
    seedWelcome({ lastReasoningEffort: 'medium' });
    expect(await welcomeEffort()).toBe('low');
  });

  it('still adopts a global preference the model declares', async () => {
    seedWelcome({ lastReasoningEffort: 'high' });
    expect(await welcomeEffort()).toBe('high');
  });
});
