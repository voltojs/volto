/**
 * use-store.ts
 * 提供类型安全的 store 访问 hook
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { ElectronAPI } from "@/renderer/src/types/electron";

/** 获取 electron API */
function getElectronAPI(): ElectronAPI {
  return window.electronAPI;
}

/**
 * useStore hook
 * 提供 store 的读写操作
 */
export function useStore() {
  /** 获取 store 值 */
  const get = useCallback(async <T = unknown>(key: string): Promise<T> => {
    const api = getElectronAPI();
    return api.store.get(key) as Promise<T>;
  }, []);

  /** 设置 store 值 */
  const set = useCallback(async (key: string, value: unknown): Promise<void> => {
    const api = getElectronAPI();
    await api.store.set(key, value);
  }, []);

  /** 删除 store 值 */
  const del = useCallback(async (key: string): Promise<void> => {
    const api = getElectronAPI();
    await api.store.delete(key);
  }, []);

  /** 清空 store */
  const clear = useCallback(async (): Promise<void> => {
    const api = getElectronAPI();
    await api.store.clear();
  }, []);

  return { get, set, delete: del, clear };
}

/**
 * 模块级、进程内的按 key 发布订阅。
 * 让监听同一个 key 的多个 useStoreValue(key) 实例保持同步，
 * 无需完整的 IPC 往返或重新挂载 —— 例如在设置里编辑 "providers"，
 * 必须立即反映到同一运行中应用内聊天页的模型选择器上。
 */
const listeners = new Map<string, Set<(value: unknown) => void>>();

function subscribe(key: string, cb: (value: unknown) => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(cb);
  return () => {
    set!.delete(cb);
    if (set!.size === 0) listeners.delete(key);
  };
}

function notify(key: string, value: unknown): void {
  listeners.get(key)?.forEach((cb) => cb(value));
}

/**
 * useStoreValue hook
 * 获取 store 中的单个值，并提供更新方法
 */
export function useStoreValue<T = unknown>(key: string, defaultValue: T) {
  const [value, setValue] = useState<T>(defaultValue);
  const [loading, setLoading] = useState(true);
  const { get, set } = useStore();
  /** 标记本次 key 生命周期内是否已收到过 notify —— 用于丢弃比它更旧的初始加载结果 */
  const receivedNotifyRef = useRef(false);

  /** 加载初始值 */
  useEffect(() => {
    receivedNotifyRef.current = false;

    const loadValue = async () => {
      try {
        const stored = await get<T>(key);
        // 加载期间已经收到过更新的 notify，说明这次 get() 拿到的值已过期，丢弃它避免覆盖更新的值
        if (receivedNotifyRef.current) {
          return;
        }
        if (stored !== undefined && stored !== null) {
          setValue(stored);
        }
      } catch (error) {
        console.error(`Failed to load store value for key "${key}":`, error);
      } finally {
        setLoading(false);
      }
    };

    loadValue();
  }, [key, get]);

  /** 订阅同一 key 的跨实例更新，收到通知后同步刷新本地 state */
  useEffect(() => {
    const unsubscribe = subscribe(key, (newValue) => {
      receivedNotifyRef.current = true;
      setValue(newValue as T);
    });
    return unsubscribe;
  }, [key]);

  /** 更新值 */
  const updateValue = useCallback(
    async (newValue: T) => {
      try {
        await set(key, newValue);
        setValue(newValue);
        notify(key, newValue);
      } catch (error) {
        console.error(`Failed to update store value for key "${key}":`, error);
        throw error;
      }
    },
    [key, set],
  );

  return { value, loading, update: updateValue };
}

/**
 * useSettings hook
 * 获取应用设置
 */
export function useSettings() {
  const { value: settings, loading, update } = useStoreValue("settings", {
    theme: "system" as const,
    locale: "zh-CN" as const,
    fontSize: 14,
    showDevTools: false,
    autoCheckUpdates: true,
  });

  return { settings, loading, update };
}

/**
 * useWindowBounds hook
 * 获取窗口边界
 */
export function useWindowBounds() {
  const { value: bounds, loading, update } = useStoreValue("windowBounds", {
    x: 0,
    y: 0,
    width: 1280,
    height: 800,
  });

  return { bounds, loading, update };
}
