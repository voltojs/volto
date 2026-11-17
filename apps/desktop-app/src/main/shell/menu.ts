/**
 * Native application menu. The Gateway menu mirrors the profile list so the
 * app is still switchable when the management page is not open, and it is the
 * discoverable path to it (Cmd/Ctrl+Shift+G).
 */

import { Menu, type MenuItemConstructorOptions } from "electron";

import type { ShellState } from "@shared/gateway";

export interface ShellMenuActions {
  switchProfile(id: string): void;
  manage(): void;
  restart(): void;
  openInBrowser(): void;
  reload(): void;
  toggleDevTools(): void;
}

export function installAppMenu(options: {
  state: ShellState;
  actions: ShellMenuActions;
}): void {
  const { state, actions } = options;
  const online = state.status.state === "online";

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? ([{ role: "appMenu" }] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: "编辑",
      submenu: [
        { role: "undo", label: "撤销" },
        { role: "redo", label: "重做" },
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "复制" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        { label: "重新加载界面", accelerator: "CmdOrCtrl+R", click: () => actions.reload() },
        { type: "separator" },
        { role: "resetZoom", label: "实际大小" },
        { role: "zoomIn", label: "放大" },
        { role: "zoomOut", label: "缩小" },
        { type: "separator" },
        { label: "开发者工具", accelerator: "Alt+CmdOrCtrl+I", click: () => actions.toggleDevTools() },
      ],
    },
    {
      label: "网关",
      submenu: [
        ...state.profiles.map(
          (profile): MenuItemConstructorOptions => ({
            label: profile.label,
            type: "radio",
            checked: profile.id === state.activeProfileId,
            click: () => actions.switchProfile(profile.id),
          }),
        ),
        { type: "separator" },
        { label: "管理网关…", accelerator: "CmdOrCtrl+Shift+G", click: () => actions.manage() },
        { label: "重新连接", click: () => actions.restart() },
        { label: "在浏览器中打开", enabled: online, click: () => actions.openInBrowser() },
      ],
    },
    { role: "windowMenu", label: "窗口" },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}