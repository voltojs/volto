# 应用图标资源

本目录是 electron-builder 的 `buildResources` 根（见 `../electron-builder.yml`）。打包时 builder 会查找这些文件：

| 文件 | 平台 | 推荐尺寸 |
|---|---|---|
| `icon.icns` | macOS | 多分辨率 1024 → 16 |
| `icon.ico` | Windows | 多分辨率 256 / 128 / 64 / 48 / 32 / 16 |
| `icon.png` | Linux | 512×512（也兼容更大） |

## 从 SVG 源生成最终图标

只有 `icon.svg` 在 git 中（避免污染仓库），二进制图标需要本地生成一次。推荐使用 [`electron-icon-maker`](https://www.npmjs.com/package/electron-icon-maker)（一次性生成三平台）：

```bash
# 1. 从 SVG 渲染一张高清 PNG（需要 librsvg / rsvg-convert，或者用 Inkscape / Figma 导出）
rsvg-convert -w 1024 -h 1024 resources/icon.svg -o /tmp/icon-source.png

# 2. 派生 .icns / .ico / 多尺寸 .png
pnpm dlx electron-icon-maker --input=/tmp/icon-source.png --output=resources/

# 3. 重命名 / 拷贝到 electron-builder 要求的位置
cp resources/icons/mac/icon.icns resources/icon.icns
cp resources/icons/win/icon.ico  resources/icon.ico
cp resources/icons/png/512x512.png resources/icon.png
```

## 不在 Git 中追踪二进制图标的原因

- PNG / ICNS / ICO 是二进制 + 派生产物，CI 容易因脚本差异生成不同字节流而误造 commit
- code review 无法对二进制做语义检查
- 任何想自定义品牌的下游分支都可以替换 SVG 后重新生成

如果未来切换到长期稳定的品牌图标，可以反转此策略：commit 二进制图标 + 在 README 说明。

## 影响

- `pnpm package:dir`：缺图标会**告警但仍成功**，electron-builder 回退到 electron 默认图标。本仓库默认走该路径作为打包验证。
- `pnpm package:mac` / `package:win` / `package:linux`：缺图标会**失败**（electron-builder 严格要求对应平台图标）。执行任一前请先按上面的步骤生成图标。
