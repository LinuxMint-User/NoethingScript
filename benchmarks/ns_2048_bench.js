// 2048 端到端基准 + 确定性校验: 当前版 vs (可选) 基线提交
//
// 用法:
//   node benchmarks/ns_2048_bench.js             只测当前版 (dist/)
//   node benchmarks/ns_2048_bench.js --head      对比基线提交 (默认 HEAD~1)
//   node benchmarks/ns_2048_bench.js --base=rev  对比任意提交
//
// 方法: 固定 LCG 随机种子 + 固定按键序列, 每个解释器在独立 vm sandbox 中跑完整一局。
//       确定性校验: 基线与当前版输出逐字节一致 (验证语义零回归)。
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { ROOT, interpPath, ensureBaseline, printEnv } = require('./helpers');

const withHead = process.argv.includes('--head');
const baseArg = process.argv.find(a => a.startsWith('--base='));
const baseRev = baseArg ? baseArg.slice('--base='.length) : null;
const code = fs.readFileSync(path.join(ROOT, 'examples', '2048.ns'), 'utf8');
const MOVES = ['w', 'a', 's', 'd', 'w', 's', 'd', 'a', 'w', 'a', 'd', 's', 'w', 'a', 'd', 's', 'w', 'a', 'd', 's', 'q'];

// 固定种子 LCG (与示例同构, 保证可复现)
function makeRand() {
    let seed = 20240806;
    return () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
}

// 独立 sandbox 跑完整一局, 返回 { ms, out }
function runOnce(interpPathStr) {
    const sandbox = {
        window: {},
        console: { log: () => {}, error: () => {}, warn: () => {} },
        Math: Object.create(Math),
        require: (m) => require(m),
        process: {}, Buffer, setTimeout, clearTimeout
    };
    sandbox.Math.random = makeRand();
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(interpPathStr, 'utf8'), sandbox);
    const NSI = sandbox.window.NSI;
    let idx = 0;
    NSI.setInput(() => MOVES[idx++] || 'q');
    const out = [];
    const origLog = sandbox.console.log;
    sandbox.console.log = (...a) => out.push(a.join(' '));
    try {
        const t0 = process.hrtime.bigint();
        NSI.run(code);
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        return { ms, out: out.join('\n') };
    } catch (e) {
        return { ms: NaN, out: 'CRASH: ' + (e && e.message ? e.message : String(e)) };
    } finally {
        sandbox.console.log = origLog;
    }
}

const currPath = interpPath('curr');
const headPath = withHead ? ensureBaseline(baseRev) : null;
const baseLabel = withHead ? (baseRev || 'HEAD~1') : null;

// 预热各 1 次
runOnce(currPath);
if (headPath) runOnce(headPath);

const rounds = 5;
let cSum = 0, hSum = 0;
console.log('2048 端到端 (固定种子 20240806 + 固定按键序列, ' + rounds + ' 轮)');
printEnv();
const pad = (s, n) => String(s).padStart(n);
console.log(pad('', 14) + ' | ' + pad('HEAD', 8) + pad('CURR', 8) + pad('变化', 8));
console.log('-'.repeat(46));

for (let i = 0; i < rounds; i++) {
    const c = runOnce(currPath);
    const h = headPath ? runOnce(headPath) : null;
    cSum += c.ms; hSum += h.ms;
    const diff = h ? ((c.ms / h.ms - 1) * 100).toFixed(1) + '%' : '-';
    console.log(pad('round' + (i + 1), 14) + ' | ' +
        pad(h ? h.ms.toFixed(1) + 'ms' : '-', 8) +
        pad(c.ms.toFixed(1) + 'ms', 8) + pad(diff, 8));
}
console.log(pad('avg', 14) + ' | ' +
    pad(headPath ? (hSum / rounds).toFixed(1) + 'ms' : '-', 8) +
    pad((cSum / rounds).toFixed(1) + 'ms', 8) +
    pad(headPath ? (((cSum / hSum) - 1) * 100).toFixed(1) + '%' : '-', 8));
console.log('');

if (headPath) {
    const headOut = runOnce(headPath).out;
    const currOut = runOnce(currPath).out;
    if (headOut === currOut) {
        console.log('确定性校验: HEAD 与当前版输出逐字节一致 ✓ (语义零回归)');
    } else {
        console.log('确定性校验: 输出不一致 ✗ (回归!)');
        const h = headOut.split('\n'), c = currOut.split('\n');
        for (let i = 0; i < Math.max(h.length, c.length); i++) {
            if (h[i] !== c[i]) console.log('L' + (i + 1) + ' HEAD[' + h[i] + '] CURR[' + c[i] + ']');
        }
    }
}
