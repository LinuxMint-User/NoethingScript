// 基准测试共享工具
// - ensureBaseline(): 从 git HEAD 构建基线解释器 (仅一次, HEAD 变化自动重建)
// - loadInterp(): 在 vm sandbox 中加载解释器 bundle (抑制 console, 避免触发 CLI)
// - benchJS()/benchNS(): JS 侧稳态计时 (预热+多次取中位) / NS 侧多轮取中位
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const os = require('os');
const cp = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BASELINE_DIR = path.join(ROOT, '.bench-head');
const HEAD_SRC = path.join(BASELINE_DIR, 'noethingScript-Interpreter.ts');
const HEAD_DIST = path.join(BASELINE_DIR, 'dist', 'noethingScript-Interpreter.js');
const CURR_DIST = path.join(ROOT, 'dist', 'noethingScript-Interpreter.js');

// 基准运行环境 (CPU/Node/平台): 基准结果与软硬件强相关, 每次运行自动打印, 便于跨环境/跨历史对比
function printEnv() {
    const cpu = os.cpus()[0];
    console.log('运行环境: Node ' + process.versions.node + ' / ' +
        (cpu ? cpu.model.trim() : '未知 CPU') +
        ' (' + os.cpus().length + ' 线程) / ' + os.platform() + ' ' + os.release());
}

// 解释器路径: 'head' -> 基线提交编译产物; 'curr' -> 当前 dist
function interpPath(which) {
    return which === 'head' ? HEAD_DIST : CURR_DIST;
}

// 构建基线解释器: git show 出指定提交源码 + tsc 单文件编译到 .bench-head/dist。
// 默认基线为 HEAD~1 (优化前的上一提交), 可用 --base=<rev> 指定任意提交。
// HEAD_SHA 记录构建时的提交 SHA, 提交变化时自动重建。
function ensureBaseline(rev) {
    rev = rev || 'HEAD~1';
    const sha = () => cp.execSync('git rev-parse ' + rev, { cwd: ROOT }).toString().trim();
    const shaFile = path.join(BASELINE_DIR, 'HEAD_SHA');
    if (fs.existsSync(HEAD_DIST) && fs.existsSync(shaFile) && fs.readFileSync(shaFile, 'utf8').trim() === sha()) {
        return HEAD_DIST;
    }
    if (!fs.existsSync(BASELINE_DIR)) fs.mkdirSync(BASELINE_DIR, { recursive: true });
    fs.writeFileSync(HEAD_SRC, cp.execSync('git show ' + rev + ':noethingScript-Interpreter.ts', { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString());
    cp.execSync(
        'npx tsc ' + JSON.stringify(HEAD_SRC) +
        ' --target es2015 --module commonjs --esModuleInterop --strict --skipLibCheck' +
        ' --outDir ' + JSON.stringify(path.join(BASELINE_DIR, 'dist')),
        { cwd: ROOT, stdio: 'inherit' }
    );
    fs.writeFileSync(shaFile, sha());
    return HEAD_DIST;
}

function loadInterp(p) {
    const sandbox = {
        window: {},
        console: { log: () => {}, error: () => {}, warn: () => {} },
        Math,
        require: (m) => require(m),
        process: {}, Buffer, setTimeout, clearTimeout
    };
    vm.createContext(sandbox);
    // 函数包装加载: vm 上下文中脚本顶层 var 会绑定为全局对象属性, 每次访问走全局代理 (实测比函数作用域慢 ~7x);
    // 包一层函数让顶层 var 变为函数作用域 (等价 require 的模块作用域 / 浏览器脚本上下文), 反映解释器真实执行性能。
    const wrapped = '(function(module, exports, require) {\n' +
        fs.readFileSync(p, 'utf8') + '\n})();';
    vm.runInContext(wrapped, sandbox);
    return sandbox.window.NSI;
}

function median(arr) {
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
}

// JS 原生稳态计时: 预热 warmup 次后跑 runs 次取中位 (消除 JIT/GC 噪声)
function benchJS(fn, warmup = 200, runs = 100) {
    for (let i = 0; i < warmup; i++) fn();
    const t = [];
    for (let i = 0; i < runs; i++) {
        const t0 = process.hrtime.bigint();
        fn();
        t.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return median(t);
}

// NS 计时: 预热 1 次后跑 runs 次取中位
function benchNS(nsi, code, runs = 3) {
    nsi.run(code);
    const t = [];
    for (let i = 0; i < runs; i++) {
        const t0 = process.hrtime.bigint();
        nsi.run(code);
        t.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    return median(t);
}

module.exports = { ROOT, interpPath, ensureBaseline, loadInterp, benchJS, benchNS, median, printEnv };
