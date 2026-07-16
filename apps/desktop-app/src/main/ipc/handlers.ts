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

/**
 * IpcChannel 数组的存在性类型 —— 用于注册流程，丢弃个体泛型参数。
 * IpcChannel 在 args 上是逆变的，因此 `IpcChannel<SpecificArgs, R>` 不能直接
 * 赋给 `IpcChannel<void, unknown>[]`。注册仅需调用 handler，运行时类型由
 * ipcMain 负责派发，编译期把它视作 `unknown` 即可。
 */
export type AnyIpcChannel = IpcChannel<any, unknown>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** 已注册的通道名集合，便于 unregisterAllIpcHandlers 精确卸载 */
const registeredChannels = new Set<string>();

/** 注册单个 IPC 处理器 */
export function registerIpcHandler<TArgs, TResult>(
  channel: IpcChannel<TArgs, TResult>,
): void {
  ipcMain.handle(channel.name, channel.handler as IpcHandler<unknown, unknown>);
  registeredChannels.add(channel.name);
}

/** 批量注册 IPC 处理器 */
export function registerIpcHandlers(channels: readonly AnyIpcChannel[]): void {
  for (const channel of channels) {
    registerIpcHandler(channel);
  }
}

/** 注销所有 IPC 处理器 */
export function unregisterAllIpcHandlers(): void {
  for (const name of registeredChannels) {
    ipcMain.removeHandler(name);
  }
  registeredChannels.clear();
}

/** 创建 IPC 通道 */
export function createIpcChannel<TArgs = void, TResult = unknown>(
  name: string,
  handler: IpcHandler<TArgs, TResult>,
): IpcChannel<TArgs, TResult> {
  return { name, handler };
}
