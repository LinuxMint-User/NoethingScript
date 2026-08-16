// NoethingScript 模块化基准: 单文件 (函数内联主程序) vs 模块化 (use + 点分 call) 执行性能差异
//
// 用法:
//   node benchmarks/ns_module_bench.js
//
// 口径:
//   - 同一工作负载两种组织方式, 计算内容完全一致; 两个变体先经真实 CLI 运行,
//     输出逐字节比对 (不一致即报错退出), 再在 vm sandbox 中分别取 NS 中位耗时对比。
//   - split 变体含 use 解析/模块加载开销 (跨 run 每次重载, 微秒级), 相对负载
//     (数万次函数调用) 可忽略; 计时时模块源码经 setModuleLoader 内存注入, 免文件 I/O。
//   - 差异 = 点分调用 (模块命名空间寻址) 相对普通调用 (全局函数表) 的净开销。
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { ROOT, interpPath, loadInterp, benchNS, printEnv } = require('./helpers');

// ---------- 模块源码 (内存注入; 定位名规则: {来源}/{包}/{模块}/{模块}.ns) ----------
const benchModuleSource = `:addOne (a:int) -> r:int
    r = a + 1
    return r
:end
:mulMod (a:int) -> r:int
    r = (a * 3) % 10007
    return r
:end
:sumArr (arr[]:int) -> r:int
    local i:int = 0
    r = 0
    while (i < 16)
        r = r + arr[i]
        i = i + 1
    endwhl
    return r
:end
`;

// 两个变体: flat = 函数直接定义在主程序 (普通 call); split = 函数放模块 (点分 call)。
// 计算序列与调用次数完全一致, 末尾 print 结果供逐字节校验。
const workloads = [
    {
        name: '轻函数高频调用 (2.5万轮×2次)',
        flat: `
:addOne (a:int) -> r:int
    r = a + 1
    return r
:end
:mulMod (a:int) -> r:int
    r = (a * 3) % 10007
    return r
:end
global j:int = 0
global t:int = 0
while (j < 25000)
    call addOne(t) -> t
    call mulMod(t) -> t
    j = j + 1
endwhl
print t
`,
        split: `
modules
use bench from main
endmodules
global j:int = 0
global t:int = 0
while (j < 25000)
    call bench.addOne(t) -> t
    call bench.mulMod(t) -> t
    j = j + 1
endwhl
print t
`
    },
    {
        name: '模块内数组求和 (2.5万次×16读)',
        flat: `
:sumArr (arr[]:int) -> r:int
    local i:int = 0
    r = 0
    while (i < 16)
        r = r + arr[i]
        i = i + 1
    endwhl
    return r
:end
global array data[16]:int = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
global j:int = 0
global t:int = 0
while (j < 25000)
    call sumArr(data) -> t
    j = j + 1
endwhl
print t
`,
        split: `
modules
use bench from main
endmodules
global array data[16]:int = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]
global j:int = 0
global t:int = 0
while (j < 25000)
    call bench.sumArr(data) -> t
    j = j + 1
endwhl
print t
`
    }
];

// 逐字节输出校验 (真实 CLI, 模块文件写入临时目录, --modules 指向; stderr 丢弃, Tip 等不影响比对)
function verify(workload) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-module-bench-'));
    const modFile = path.join(dir, 'modules', 'main', 'bench', 'bench', 'bench.ns');
    fs.mkdirSync(path.dirname(modFile), { recursive: true });
    fs.writeFileSync(modFile, benchModuleSource);
    const runCli = (code, name) => {
        const f = path.join(dir, name);
        fs.writeFileSync(f, code);
        return cp.execFileSync('node', [interpPath('curr'), f, '--modules', path.join(dir, 'modules')],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    };
    let a, b;
    try {
        a = runCli(workload.flat, 'flat.ns');
        b = runCli(workload.split, 'split.ns');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
    if (a !== b) {
        console.error('输出不一致 (flat vs split):');
        console.error('--- flat ---'); console.error(a);
        console.error('--- split ---'); console.error(b);
        process.exit(1);
    }
}

const nsi = loadInterp(interpPath('curr'));
nsi.setModuleLoader(name => name === 'main/bench/bench/bench.ns' ? benchModuleSource : null);

console.log('NoethingScript 模块化基准 (单文件 vs use+点分调用; NS 中位 3 次)');
printEnv();
console.log('解释器: 当前版 dist/ (v' + nsi.version + ')');
console.log('');

const pad = (s, n) => String(s).padStart(n);
let header = pad('', 22) + ' | ' + pad('flat', 9) + pad('split', 9) + ' | ' + pad('split相对flat', 12) + ' | ' + '输出校验';
console.log(header);
console.log('-'.repeat(header.length));

for (const w of workloads) {
    verify(w);
    const flat = benchNS(nsi, w.flat);
    const split = benchNS(nsi, w.split);
    const delta = ((split - flat) / flat) * 100;
    const row = pad(w.name, 22) + ' | ' +
        pad(flat.toFixed(1) + 'ms', 9) +
        pad(split.toFixed(1) + 'ms', 9) + ' | ' +
        pad(delta.toFixed(1) + '%', 12) + ' | ' +
        '逐字节一致 ✓';
    console.log(row);
}

console.log('');
console.log('注: flat = 函数内联主程序 (普通 call, 全局函数表); split = 模块函数 (点分 call, 模块命名空间寻址);');
console.log('    正数 = 模块化更慢, 负数 = 模块化更快; 差异主要来自点分调用寻址与模块上下文切换。');
