import { create } from 'zustand';
import type { TrajectoryRow } from '@volto/sdk/sse';

/**
 * 轨迹行详情抽屉的全局状态：主轨迹面板（TrajectoryPanel 渲染抽屉）与
 * 子代理详情的轨迹子视图（RightPane 内）打开同一个抽屉。行快照随打开
 * 写入、随关闭清空——抽屉换行即换内容，不做栈式回退。
 */
interface TrajectoryDrawerState {
  /** 当前抽屉展示的行快照；null = 关闭。 */
  row: TrajectoryRow | null;
  open: (row: TrajectoryRow) => void;
  close: () => void;
}

export const useTrajectoryDrawerStore = create<TrajectoryDrawerState>((set) => ({
  row: null,
  open: (row) => set({ row }),
  close: () => set({ row: null }),
}));
