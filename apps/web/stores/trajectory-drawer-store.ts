import { create } from 'zustand';
import type { TrajectoryRow } from '@voltojs/sdk/sse';

/**
 * 轨迹行详情抽屉的全局状态：主轨迹面板（TrajectoryPanel 渲染抽屉）与
 * 子代理详情的轨迹子视图（RightPane 内）打开同一个抽屉。行快照随打开
 * 写入、随关闭清空——抽屉换行即换内容，不做栈式回退。
 */
interface TrajectoryDrawerState {
  /** 当前抽屉展示的行快照；null = 关闭。 */
  row: TrajectoryRow | null;
  /**
   * Project the row's content belongs to, stamped at open time. File refs
   * in the drawer resolve against it, not whichever session is current.
   */
  projectId: string | null | undefined;
  /** Session owning the row's attachments (screenshots). */
  sessionId: string | null | undefined;
  open: (row: TrajectoryRow, projectId?: string | null, sessionId?: string | null) => void;
  close: () => void;
}

export const useTrajectoryDrawerStore = create<TrajectoryDrawerState>((set) => ({
  row: null,
  projectId: undefined,
  sessionId: undefined,
  open: (row, projectId, sessionId) => set({ row, projectId, sessionId }),
  close: () => set({ row: null, projectId: undefined, sessionId: undefined }),
}));
