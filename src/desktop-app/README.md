# desktop-app（桌面端 Web UI）

`desktop-app` 是 Hermes 桌面端 Web UI，由**官方 hermes-agent 上游的 web 构建产物**（assets/*.js）与**本项目自定义文件**组成。

## 组成

| 文件 | 来源 | 说明 |
| --- | --- | --- |
| `assets/*` | 上游编译 | 官方 Hermes Desktop UI 的 JS/CSS bundle（browser build） |
| `index.html` | 本项目 | 入口页，注入 `viewport-fit=cover`（移动端）+ 引用 web-shim |
| `web-shim.js` | 本项目 | 桌面桥接层：API 代理、中文汉化层（DICT+MutationObserver）、移动端适配（iOS 16px 防缩放/safe-area） |

## 构建

1. 上游 hermes-src 构建 web_dist（`hermes-src/hermes_cli/web_dist`）
2. 本项目把 `src/desktop-app-*.js` 和 `src/desktop-app-index.html` 覆盖到 desktop-app/
3. 最终 desktop-app/ = 官方 web 构建产物 + 本项目自定义覆盖

## 汉化机制

`web-shim.js` 内置：
- **DOM 汉化层**：242 条中英映射（账单/主题/人格/枚举/提示音等硬编码英文），MutationObserver + 500ms 兜底
- **移动端适配**：iOS 输入框强制 16px（防聚焦缩放）、safe-area-inset-bottom 刘海屏适配、触摸优化
- **API 桥接**：/proxy/dashboard 代理 + session token 注入

## 产物级补丁：session owner 放行（browser build）

### 修的是什么

上游 `apps/desktop/src/store/session-owner-resolution.ts` 的
`ambientGatewayOwnsEverySession()` 原实现：

```js
return !hasRegistryTopology() && $profiles.get().length <= 1
```

本项目跑的是**浏览器形态**：`web-shim.js` 把 Electron 桥降级成纯浏览器实现，
前端拿不到 tile owner / 连接注册表 / 带归属的行（`session.list` 返回的行也不含归属字段）。
于是只要配置了 **2 个及以上 profile**，该函数返回 `false`，所有 session-scoped RPC
（`session.control.read`、`subagent.*`、`process.kill`、`approval.*`、`goals`、`connectors`）
在前端本地抛 `SessionOwnerResolutionError` 被拒绝，界面报
「会话控制不可用: Session owner could not be resolved for ...」。
**后端其实完全正常——请求根本没发出去。**

正确修法：浏览器形态下只有一个后端服务全部 profile，活跃网关就是 owner，应直接放行。
判据用 web-shim 已有的全局标记 `window.__HERMES_WEB_SHIM_LOADED__`
（`web-shim.js` 里同步赋值，classic script 早于 `type="module"` 的 bundle 执行）。

### 为什么仓库只能这么修

本仓库**不自己构建前端**，`desktop-app/assets/*.js` 是上游 Vite minified 产物
（文件名带内容 hash）。本地修复无法回到源码，只能对产物做文本替换回迁
（先例：`src/desktop-app/` 下的覆盖用 chunk 文件）。

### 补丁脚本

`scripts/patch-desktop-app-session-owner.js`（Node，仅 fs/path，无第三方依赖）：

- 扫描 `<dir>/assets/*.js`，**双条件**命中才处理（避免误伤其它含 `length<=1` 的 chunk）：
  (a) 含字符串 `SessionOwnerResolutionError`；
  (b) 匹配 `/function (\w+)\(\)\{return!(\w+)\(\)&&(\w+)\.get\(\)\.length<=1\}/`。
- 替换为（变量名按捕获组保留，不写死）：
  `function $1(){return typeof window!=="undefined"&&window.__HERMES_WEB_SHIM_LOADED__?!0:!$2()&&$3.get().length<=1}`
- **幂等**：文件已含 `__HERMES_WEB_SHIM_LOADED__` 则跳过。
- **fail loud**：扫完既没匹配到、也没发现已打补丁的文件时**非 0 退出**并明确报错，
  绝不静默成功（上游产物形态变了必须人工重做）。

用法：

```bash
# 默认改 app/desktop-app；--check 只检查（已打→0，未打→1，不改文件）
node scripts/patch-desktop-app-session-owner.js
node scripts/patch-desktop-app-session-owner.js --dir build/<ver>/app/desktop-app
node scripts/patch-desktop-app-session-owner.js --check
```

`scripts/build.sh` 在 `cp -r app/desktop-app "$APP_STAGE/desktop-app"` 之后、
组装 FPK 之前调用它（`--dir "$APP_STAGE/desktop-app"`），脚本失败即构建失败。

### 上游更新 desktop-app 产物后如何重做

上游产物一覆盖，本地修改即丢失，但**不需要手改**——重跑脚本即可：

```bash
node scripts/patch-desktop-app-session-owner.js
```

若脚本报「未匹配到任何目标函数 / 上游产物形态可能已变化」并非 0 退出，
说明上游改了这段代码的 minified 结构，需人工对照上游源码重新确定匹配式与替换式，
再更新脚本里的 `PATTERN` / `REPLACEMENT`。

### 验证命令

```bash
node scripts/patch-desktop-app-session-owner.js --check   # 退出码 0 = 已打补丁
grep -c __HERMES_WEB_SHIM_LOADED__ app/desktop-app/assets/session-states-*.js  # 应为 1
```
