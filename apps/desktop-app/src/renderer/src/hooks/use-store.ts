/**
 * use-store.ts
 * 提供类型安全的 store 访问 hook
 */

import { useState, useEffect, useCallback } from "react";

/** Electron API 类型声明 */
interface ElectronAPI {
  store: {
    get: (key: string) => Promise<unknown>;
    set: (key: string, value: unknown) => Promise<void>;
    delete: (key: string) => Promise<void>;
    clear: () => Promise<void>;
  };
  app: {
    platform: string;
  };
}

/** 扩展 Window 接口 */
declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

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
 * useStoreValue hook
 * 获取 store 中的单个值，并提供更新方法
 */
export function useStoreValue<T = unknown>(key: string, defaultValue: T) {
  const [value, setValue] = useState<T>(defaultValue);
  const [loading, setLoading] = useState(true);
  const { get, set } = useStore();

  /** 加载初始值 */
  useEffect(() => {
    const loadValue = async () => {
      try {
        const stored = await get<T>(key);
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

  /** 更新值 */
  const updateValue = useCallback(
    async (newValue: T) => {
      try {
        await set(key, newValue);
        setValue(newValue);
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
