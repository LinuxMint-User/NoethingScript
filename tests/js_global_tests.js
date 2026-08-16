// registerGlobal (JS 能力注入, design.md §6) 功能测试
// 用法: node tests/js_global_tests.js
// 在 vm sandbox 中加载解释器 bundle, 捕获 console 输出, 断言 NS 代码调用注入对象的行为
// (四类返回值/数组/宿主异常/非法返回值/模块共存等)。CLI 场景无注入入口 (Node 宿主注入见 M7),
// 故本测试经 window.NSI.registerGlobal 走浏览器注入路径, 与解释器内部执行路径一致。
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'noethingScript-Interpreter.js');

function makeInterp() {
    const out = [];
    const sandbox = {
        window: {},
        console: { log: (...a) => out.push(a.join(' ')), error: (...a) => out.push(a.join(' ')), warn: (...a) => out.push(a.join(' ')) },
        Math,
        require: (m) => require(m),
        process: {}, Buffer, setTimeout, clearTimeout
    };
    vm.createContext(sandbox);
    vm.runInContext('(function(module, exports, require) {\n' + fs.readFileSync(DIST, 'utf8') + '\n})();', sandbox);
    return { nsi: sandbox.window.NSI, out };
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log('PASS ' + name); }
    else { failed++; console.error('FAIL ' + name + (detail !== undefined ? '\n  ' + detail : '')); }
}

// 注入对象: 覆盖四类返回值 / 数组 / 宿主异常 / 非法返回值
const jm = {
    add: (a, b) => a + b,
    greet: (s) => 'hello ' + s,
    isPos: (n) => n > 0,
    sumArr: (arr) => arr.reduce((s, v) => s + v, 0),
    range: (n) => { const r = []; for (let i = 0; i < n; i++) r.push(i); return r; },
    mul2: (a) => a * 2,
    boom: () => { throw new Error('boom'); },
    badObj: () => ({ x: 1 }),
    badFn: () => () => 1,
    badNaN: () => NaN,
};

const { nsi, out } = makeInterp();
nsi.registerGlobal('jm', jm);
out.length = 0;

// 1. 数字返回值 + 字面量实参
nsi.run('call jm.add(2, 3) -> r\nprint r');
check('数字返回值/字面量实参', out[0] === '5', JSON.stringify(out));

// 2. 字符串/布尔实参与返回值
out.length = 0;
nsi.run('call jm.greet("NS") -> s\nprint s\ncall jm.isPos(5) -> b\nprint b\ncall jm.isPos(-1) -> b2\nprint b2');
check('字符串/布尔', out[0] === 'hello NS' && out[1] === 'true' && out[2] === 'false', JSON.stringify(out));

// 3. 数组实参 (NS 数组 → JS Array)
out.length = 0;
nsi.run('global array a[3]:int = [1, 2, 3]\ncall jm.sumArr(a) -> n\nprint n');
check('数组实参', out[0] === '6', JSON.stringify(out));

// 4. 数组字面量实参
out.length = 0;
nsi.run('call jm.sumArr([1, 2, 3]) -> n2\nprint n2');
check('数组字面量实参', out[0] === '6', JSON.stringify(out));

// 5. 数组返回值 (未声明结果变量自动建数组变量)
out.length = 0;
nsi.run('call jm.range(4) -> arr\nprint arr[0]\nprint arr[3]\nprint len(arr)');
check('数组返回值', out[0] === '0' && out[1] === '3' && out[2] === '4', JSON.stringify(out));

// 6. 变量/表达式实参
out.length = 0;
nsi.run('global x:int = 10\ncall jm.add(x, 5) -> y\nprint y\ncall jm.add(Math.abs(-3), 1) -> y2\nprint y2');
check('变量/表达式实参', out[0] === '15' && out[1] === '4', JSON.stringify(out));

// 7. 函数内调用注入对象 (跨作用域)
out.length = 0;
nsi.run(':f (a:int) -> r:int\n    call jm.mul2(a) -> r\n    return r\n:end\ncall f(21) -> z\nprint z');
check('函数内调用注入对象', out[0] === '42', JSON.stringify(out));

// 8. 无结果变量调用 (有返回值但丢弃)
out.length = 0;
nsi.run('call jm.add(1, 2)\nprint "ok"');
check('无结果变量调用', out[0] === 'ok', JSON.stringify(out));

// 9. 宿主异常 → TypeError 可被 try-catch 捕获
out.length = 0;
nsi.run('try\n    call jm.boom()\ncatch (Exception e)\n    print "caught: " + e\nendtry\nprint "after"');
check('宿主异常可捕获', out[0] === 'caught: JS 注入函数调用失败 jm.boom: boom' && out[1] === 'after', JSON.stringify(out));

// 10. 未定义成员 → ReferenceError 可捕获
out.length = 0;
nsi.run('try\n    call jm.nope()\ncatch (Exception e)\n    print "caught: " + e\nendtry');
check('未定义成员可捕获', out[0] === "caught: 函数 'jm.nope' 未定义", JSON.stringify(out));

// 11. 非法返回值 (对象/函数/NaN) → 报错, 程序继续
out.length = 0;
nsi.run('call jm.badObj() -> v\nprint "continue1"\ncall jm.badFn() -> v2\nprint "continue2"\ncall jm.badNaN() -> v3\nprint "continue3"');
check('非法返回值报错且继续',
    out.some(l => l.indexOf('返回非法值') !== -1) &&
    out.some(l => l === 'continue1') && out.some(l => l === 'continue2') && out.some(l => l === 'continue3'),
    JSON.stringify(out));

// 12. 注入对象与 use 模块共存 (点分调用解析: 模块对象优先)
out.length = 0;
nsi.setModuleLoader(name => name === 'main/m/m/m.ns' ? ':twice (a:int) -> r:int\n    r = a * 2\n    return r\n:end\n' : null);
nsi.run('modules\nuse m from main\nendmodules\ncall jm.add(1, 1) -> a1\ncall m.twice(3) -> a2\nprint a1\nprint a2');
check('注入对象与模块共存', out[0] === '2' && out[1] === '6', JSON.stringify(out));

// 13. 模块函数内调用注入对象 (模块上下文 JS fallback)
out.length = 0;
nsi.setModuleLoader(name => name === 'main/m2/m2/m2.ns' ? ':mulX (a:int) -> r:int\n    call jm.mul2(a) -> r\n    return r\n:end\n' : null);
nsi.run('modules\nuse m2 from main\nendmodules\ncall m2.mulX(5) -> r2\nprint r2');
check('模块函数内调用注入对象', out[0] === '10', JSON.stringify(out));

// 14. registerGlobal 校验: 非法名 / 非法对象
out.length = 0;
nsi.registerGlobal('9bad', jm);
nsi.registerGlobal('ok', null);
check('非法名/非法对象报错',
    out.some(l => l.indexOf("registerGlobal: 非法注入名 '9bad'") !== -1) &&
    out.some(l => l.indexOf('registerGlobal: 注入对象须为包含函数成员的对象') !== -1),
    JSON.stringify(out));

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
