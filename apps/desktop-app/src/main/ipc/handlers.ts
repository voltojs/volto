/**
 * IPC 处理器框架
 * 提供类型安全的 IPC 通道注册和处理
 */

import { ipcMain, type IpcMainInvokeEvent } from "electron";

/** IPC 处理器函数类型 */
export type IpcHandler<TArgs = void, TResult = unknown> = (
  event: IpcMainInvokeEvent,
  args: TArgs,
) => TResult | Promise<TResult>;

/** IPC 通道定义 */
export interface IpcChannel<TArgs = void, TResult = unknown> {
  /** 通道名称 */
  name: string;
  /** 处理器函数 */
  handler: IpcHandler<TArgs, TResult>;
}

/** 注册单个 IPC 处理器 */
export function registerIpcHandler<TArgs = void, TResult = unknown>(
  channel: IpcChannel<TArgs, TResult>,
): void {
  ipcMain.handle(channel.name, channel.handler);
}

/** 批量注册 IPC 处理器 */
export function registerIpcHandlers(channels: IpcChannel[]): void {
  for (const channel of channels) {
    registerIpcHandler(channel);
  }
}

/** 注销所有 IPC 处理器 */
export function unregisterAllIpcHandlers(): void {
  ipcMain.removeHandler("store:get");
  ipcMain.removeHandler("store:set");
  ipcMain.removeHandler("store:delete");
  ipcMain.removeHandler("store:clear");
  // 添加更多通道...
}

/** 创建 IPC 通道 */
export function createIpcChannel<TArgs = void, TResult = unknown>(
  name: string,
  handler: IpcHandler<TArgs, TResult>,
): IpcChannel<TArgs, TResult> {
  return { name, handler };
}
