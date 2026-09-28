#!/usr/bin/env node
/**
 * 产物级补丁：desktop-app 浏览器形态下的 session owner 放行
 * ═══════════════════════════════════════════════════════════════════
 * 背景（上游 bug，本项目部署端已修）：
 *   apps/desktop/src/store/session-owner-resolution.ts 的
 *   ambientGatewayOwnsEverySession() 原实现：
 *     return !hasRegistryTopology() && $profiles.get().length <= 1
 *
 *   本项目跑「浏览器形态」：web-shim.js 把 Electron 桥降级为纯浏览器实现，
 *   前端拿不到 tile owner / 连接注册表 / 带归属的行，于是只要配置 ≥2 个
 *   profile，该函数返回 false，所有 session-scoped RPC 在前端本地抛
 *   SessionOwnerResolutionError 被拒（后端其实正常，请求根本没发出去）。
 *
 *   正确修法：浏览器形态下只有一个后端服务全部 profile，活跃网关即 owner，
 *   直接放行。判据用 web-shim 已有的全局标记 window.__HERMES_WEB_SHIM_LOADED__
 *   （web-shim.js 里同步赋值，早于 type="module" 的 bundle 执行）。
 *
 * minified 产物形态（变量名每次构建都变，故按结构匹配）：
 *   修复前：function ht(){return!he()&&Ce.get().length<=1}
 *   修复后：function ht(){return typeof window!=="undefined"&&window.__HERMES_WEB_SHIM_LOADED__?!0:!he()&&Ce.get().length<=1}
 *
 * 用法：
 *   node scripts/patch-desktop-app-session-owner.js [--dir <path>] [--check]
 *     --dir    目标 desktop-app 目录（默认 app/desktop-app）
 *     --check  只检查不修改：已打补丁退出 0，未打补丁退出 1
 *
 * 失败语义（fail loud，最重要）：
 *   扫完既没匹配到、也没发现「已打过补丁」的文件 → 非 0 退出并明确报错。
 *   上游更新 desktop-app 产物后形态可能变化，必须人工重做补丁，
 *   绝不能静默成功产出未修复的包。
 * ═══════════════════════════════════════════════════════════════════
 */
'use strict';

const fs = require('fs');
const path = require('path');

const MARKER = '__HERMES_WEB_SHIM_LOADED__';
const ERROR_STRING = 'SessionOwnerResolutionError';
// 结构匹配：function <name>(){return!<a>()&&<b>.get().length<=1}
const PATTERN = /function (\w+)\(\)\{return!(\w+)\(\)&&(\w+)\.get\(\)\.length<=1\}/g;
const REPLACEMENT =
  'function $1(){return typeof window!=="undefined"&&window.' +
  MARKER +
  '?!0:!$2()&&$3.get().length<=1}';

function parseArgs(argv) {
  const opts = { dir: 'app/desktop-app', check: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') {
      opts.check = true;
    } else if (a === '--dir') {
      opts.dir = argv[++i];
      if (!opts.dir) {
        console.error('✗ --dir 缺少参数');
        process.exit(2);
      }
    } else if (a.startsWith('--dir=')) {
      opts.dir = a.slice('--dir='.length);
    } else if (a === '-h' || a === '--help') {
      console.log('用法: node scripts/patch-desktop-app-session-owner.js [--dir <path>] [--check]');
      process.exit(0);
    } else {
      console.error(`✗ 未知参数: ${a}`);
      process.exit(2);
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const assetsDir = path.join(opts.dir, 'assets');

  if (!fs.existsSync(assetsDir)) {
    console.error(`✗ 找不到 assets 目录: ${assetsDir}`);
    process.exit(2);
  }

  const files = fs
    .readdirSync(assetsDir)
    .filter((f) => f.endsWith('.js'))
    .sort()
    .map((f) => path.join(assetsDir, f));

  let patchedFiles = []; // 已含标记（此前打过补丁）
  let changedFiles = []; // 本次修改
  let replacements = 0;
  let candidates = 0; // 含 SessionOwnerResolutionError 的文件
  let unmatched = []; // 是候选但既不匹配、也无标记（形态可能变了）

  for (const file of files) {
    const src = fs.readFileSync(file, 'utf8');

    // 条件 (a)：只处理含错误字符串的 chunk，避免误伤其它恰好含 length<=1 的文件
    if (!src.includes(ERROR_STRING)) continue;
    candidates++;

    // 幂等：已含 web-shim 标记 → 视为已打过补丁
    if (src.includes(MARKER)) {
      patchedFiles.push(file);
      console.log(`· already patched: ${file}`);
      continue;
    }

    // 条件 (b)：结构匹配
    PATTERN.lastIndex = 0;
    const hits = src.match(PATTERN);
    if (!hits || hits.length === 0) {
      unmatched.push(file);
      console.log(`· 候选文件但未匹配目标函数: ${file}`);
      continue;
    }

    if (opts.check) {
      changedFiles.push(file);
      replacements += hits.length;
      console.log(`✗ 未打补丁: ${file}（匹配 ${hits.length} 处）`);
      continue;
    }

    PATTERN.lastIndex = 0;
    const out = src.replace(PATTERN, REPLACEMENT);
    fs.writeFileSync(file, out);
    changedFiles.push(file);
    replacements += hits.length;
    console.log(`✓ 已修改: ${file}（替换 ${hits.length} 处）`);
  }

  // ── 汇总 ─────────────────────────────────────────────────────────
  console.log(
    `── 汇总 ── 扫描 ${files.length} 个 js，候选 ${candidates} 个，` +
      `本次修改 ${changedFiles.length} 个（${replacements} 处），` +
      `已打过补丁 ${patchedFiles.length} 个`
  );

  // fail loud：候选文件既不匹配、也无标记 → 上游形态可能已变化，两种模式都报错
  if (unmatched.length > 0) {
    console.error(
      `✗ 以下候选文件既不匹配目标函数、也不含补丁标记（上游产物形态可能已变化，需人工重做补丁）：\n  ` +
        unmatched.join('\n  ')
    );
    process.exit(3);
  }

  if (opts.check) {
    if (changedFiles.length > 0) {
      console.error(`✗ --check: 有 ${changedFiles.length} 个文件未打补丁`);
      process.exit(1);
    }
    if (patchedFiles.length > 0) {
      console.log(`✓ --check: 补丁已就位（${patchedFiles.length} 个文件）`);
      process.exit(0);
    }
    console.error(
      '✗ --check: 既没找到已打补丁的文件，也没找到待打补丁的目标函数。\n' +
        '  上游 desktop-app 产物形态可能已变化，需人工重做补丁。'
    );
    process.exit(1);
  }

  // 非 check 模式
  if (changedFiles.length === 0 && patchedFiles.length === 0) {
    console.error(
      '✗ 未匹配到任何目标函数，也未发现已打补丁的文件。\n' +
        `  已扫描 ${files.length} 个 js，含 "${ERROR_STRING}" 的候选 ${candidates} 个。\n` +
        '  上游 desktop-app 产物形态很可能已变化，本补丁需人工重做——拒绝静默成功。'
    );
    process.exit(4);
  }

  if (changedFiles.length === 0) {
    console.log('✓ 无需修改（补丁已就位）');
  } else {
    console.log(`✓ 补丁完成，共修改 ${changedFiles.length} 个文件 / ${replacements} 处`);
  }
  process.exit(0);
}

main();
