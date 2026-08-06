// NoethingScript 合成基准: 当前版 vs (可选) 基线提交 vs 原生 JS
//
// 用法:
//   node benchmarks/ns_perf_bench.js             只测当前版 (dist/) 与原生 JS
//   node benchmarks/ns_perf_bench.js --head      对比基线提交 (默认 HEAD~1)
//   node benchmarks/ns_perf_bench.js --base=rev  对比任意提交 (如 --base=7fc14c5)
//
// 行吞吐口径: 每轮循环执行 4 行 (while 条件行 + body 语句 + endwhl 结构行),
//             静态声明/调用/返回等一次性行另计。吞吐 = 执行行数 / NS 中位耗时。
// 倍率口径: NS 耗时 / 原生 JS 稳态中位耗时 (JS 侧为微秒级, 绝对倍率受计时噪声
//            影响, 相对变化才有意义; 建议与历史记录对比时保持同一脚本同一口径)。
const { interpPath, ensureBaseline, loadInterp, benchJS, benchNS, printEnv } = require('./helpers');

const withHead = process.argv.includes('--head');
const baseArg = process.argv.find(a => a.startsWith('--base='));
const baseRev = baseArg ? baseArg.slice('--base='.length) : null;

const workloads = [
    {
        name: '循环累加10万(全局)',
        lines: 2 + 4 * 100000, // 声明2行 + 每轮 while+body×2+endwhl 共4行
        ns: `
global i:int = 0
global s:int = 0
while (i < 100000)
    s = s + i
    i = i + 1
endwhl
`,
        js: () => { let i = 0, s = 0; while (i < 100000) { s = s + i; i = i + 1; } }
    },
    {
        name: '循环累加10万(局部)',
        lines: 400006, // 函数体内 while 40万 + 声明/返回 4行 + 顶层 call/global 2行
        ns: `
:locsum () -> r:int
    local i:int = 0
    local s:int = 0
    while (i < 100000)
        s = s + i
        i = i + 1
    endwhl
    r = s
    return r
:end
global g:int = 0
call locsum() -> g
`,
        js: () => { let i = 0, s = 0; while (i < 100000) { s = s + i; i = i + 1; } }
    },
    {
        name: '函数调用5万',
        lines: 300002, // 顶层 while 20万 + 函数体(每调用2行) 10万 + 声明2行
        ns: `
:add2 (a:int) -> r:int
    r = a + 1
    return r
:end
global j:int = 0
global t:int = 0
while (j < 50000)
    call add2(t) -> t
    j = j + 1
endwhl
`,
        js: () => {
            function add2(a) { return a + 1; }
            let j = 0, t = 0;
            while (j < 50000) { t = add2(t); j = j + 1; }
        }
    },
    {
        name: '数组读写5万(全局)',
        lines: 200002, // 声明2行 + 每轮4行
        ns: `
global array arr[16]:int = arrfill
global k:int = 0
while (k < 50000)
    arr[k % 16] = arr[k % 16] + 1
    k = k + 1
endwhl
`,
        js: () => { const arr = new Array(16).fill(0); let k = 0; while (k < 50000) { arr[k % 16] = arr[k % 16] + 1; k = k + 1; } }
    },
    {
        name: '数组读写5万(局部)',
        lines: 200006, // 函数体内 while 20万 + 声明/返回 4行 + 顶层 call/global 2行
        ns: `
:locarr () -> r:int
    local array arr[16]:int = arrfill
    local k:int = 0
    while (k < 50000)
        arr[k % 16] = arr[k % 16] + 1
        k = k + 1
    endwhl
    r = arr[0]
    return r
:end
global g:int = 0
call locarr() -> g
`,
        js: () => { const arr = new Array(16).fill(0); let k = 0; while (k < 50000) { arr[k % 16] = arr[k % 16] + 1; k = k + 1; } }
    }
];

const curr = loadInterp(interpPath('curr'));
const head = withHead ? loadInterp(ensureBaseline(baseRev)) : null;
const baseLabel = withHead ? (baseRev || 'HEAD~1') : null;

console.log('NoethingScript 合成基准 (NS 中位 3 次 / JS 原生 200 预热 + 100 次取中位)');
printEnv();
console.log('解释器: 当前版 dist/ vs 基线 ' + (baseLabel || '(无, 仅当前版)'));
console.log('');

const pad = (s, n) => String(s).padStart(n);
let header = pad('', 20) + ' | ' + pad('HEAD', 8) + pad('CURR', 8) + pad('JS原生', 9) + ' | ' +
    pad('HEAD倍率', 9) + pad('CURR倍率', 9) + pad('CURR吞吐', 9) + ' | ' + pad('CURR变化', 8);
console.log(header);
console.log('-'.repeat(header.length));

for (const w of workloads) {
    const c = benchNS(curr, w.ns);
    const h = head ? benchNS(head, w.ns) : null;
    const j = benchJS(w.js);
    const cRate = Math.round(w.lines / c); // 行/ms = k行/秒
    const cRatio = Math.round(c / j);
    const row = pad(w.name, 20) + ' | ' +
        pad(h !== null ? h.toFixed(1) + 'ms' : '-', 8) +
        pad(c.toFixed(1) + 'ms', 8) +
        pad(j.toFixed(3) + 'ms', 9) + ' | ' +
        pad(h !== null ? (h / j).toFixed(0) + 'x' : '-', 9) +
        pad(cRatio + 'x', 9) +
        pad(cRate + 'k行/s', 9) + ' | ' +
        pad(h !== null ? (((c / h) - 1) * 100).toFixed(1) + '%' : '-', 8);
    console.log(row);
}

console.log('');
console.log('注: 倍率 = NS耗时/JS原生稳态耗时, JS 侧微秒级, 绝对倍率仅供参考;');
console.log('    CURR吞吐 = 执行行数/NS耗时 (含 while/endwhl 结构行).');
