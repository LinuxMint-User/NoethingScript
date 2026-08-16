// 构建后把源码 modules/ 同步到 dist/modules (模块目录默认基准 = 解释器文件同目录, 设计稿 §7.3)
// 用法: npm run build (tsc 之后执行); dist 为构建产物 (gitignore), 发布形态 = 整个 dist/ (解释器 JS + 模块)
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const src = path.join(root, 'modules');
const dst = path.join(root, 'dist', 'modules');
fs.cpSync(src, dst, { recursive: true });
console.log('[sync] modules -> dist/modules');
