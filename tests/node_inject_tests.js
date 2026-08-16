// Node/CLI 注入入口 (registerGlobal, design.md §6) 测试
// 用法: node tests/node_inject_tests.js
// 覆盖两条链路:
//   1) Node require 链路: require 解释器 bundle 返回 NSI (main 不触发), 宿主 registerGlobal 注入后 run
//   2) CLI --inject 链路: node <解释器> --inject fs,http <脚本> 注入内置能力 (fs/http), 未知能力报错退出
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist', 'noethingScript-Interpreter.js');

let passed = 0, failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log('PASS ' + name); }
    else { failed++; console.error('FAIL ' + name + (detail !== undefined ? '\n  ' + detail : '')); }
}

// ---------- 1. require 链路 ----------
const errs = [];
const origErr = console.error;
console.error = (...a) => errs.push(a.join(' '));
const NSI = require(DIST); // require 若误触发 main() 会打印 cli_usage 到 stderr
console.error = origErr;
check('require 返回 NSI 且与 globalThis.NSI 同引用', !!NSI && NSI === globalThis.NSI && typeof NSI.registerGlobal === 'function');
check('require 不触发 CLI (无用法错误输出)', !errs.some(l => l.indexOf('用法') !== -1 || l.indexOf('Usage') !== -1), JSON.stringify(errs));

// require 链路: registerGlobal 注入 + run (输出走 console, 捕获断言)
const out = [];
const origLog = console.log;
console.log = (...a) => out.push(a.join(' '));
NSI.registerGlobal('host', { greet: (s) => 'hi ' + s, num: () => 42 });
NSI.run('call host.greet("x") -> r\nprint r\ncall host.num() -> n\nprint n');
console.log = origLog;
check('require 链路 registerGlobal + run', out[0] === 'hi x' && out[1] === '42', JSON.stringify(out));

// ---------- 2. CLI --inject 链路 ----------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nsi-inject-'));
const script = [
    'call fs.writeFile("' + tmpDir + '/a.txt", "abc")',
    'call fs.exists("' + tmpDir + '/a.txt") -> e',
    'print e',
    'call fs.readFile("' + tmpDir + '/a.txt") -> c',
    'print c',
    'call fs.mkdir("' + tmpDir + '/sub")',
    'call fs.isDir("' + tmpDir + '/sub") -> d',
    'print d',
    'call fs.listDir("' + tmpDir + '") -> items',
    'print len(items)',
    'try',
    '    call fs.readFile("' + tmpDir + '/nope.txt") -> x',
    'catch (Exception ex)',
    '    print "caught"',
    'endtry',
    'call fs.cwd() -> w',
    'print w',
    'call fs.join("' + tmpDir + '", "sub2") -> j',
    'print j'
].join('\n');
const scriptPath = path.join(os.tmpdir(), 'nsi-inject-script-' + process.pid + '.ns');
fs.writeFileSync(scriptPath, script);

const r = cp.spawnSync('node', [DIST, '--inject', 'fs,http', scriptPath], { cwd: ROOT, encoding: 'utf8' });
const lines = r.stdout.split('\n').filter(l => l.length > 0);
check('CLI --inject fs 全链路',
    lines[0] === 'true' && lines[1] === 'abc' && lines[2] === 'true' && lines[3] === '2' && lines[4] === 'caught' &&
    lines[5] === ROOT && lines[6] === tmpDir + '/sub2',
    'exit=' + r.status + ' stdout=' + JSON.stringify(r.stdout) + ' stderr=' + JSON.stringify(r.stderr));

// 宿主异常可捕获已在上文验证 (caught); 验证异常消息带注入对象名
const r2 = cp.spawnSync('node', [DIST, '--inject', 'fs', scriptPath], { cwd: ROOT, encoding: 'utf8' });
check('CLI --inject fs (不含 http) 正常', r2.status === 0 && r2.stdout.split('\n').filter(Boolean)[4] === 'caught', JSON.stringify(r2.stdout));

// 未知能力名 → 报错退出码 1
const r3 = cp.spawnSync('node', [DIST, '--inject', 'bogus', scriptPath], { cwd: ROOT, encoding: 'utf8' });
check('CLI --inject 未知能力报错退出', r3.status === 1 && r3.stderr.indexOf('bogus') !== -1, 'exit=' + r3.status + ' stderr=' + JSON.stringify(r3.stderr));

// --inject 与 cmdargs 分隔符 `--` 互不干扰 (inject 只认解释器参数区)
const script2 = 'cmdargs\nparam v:string = "d"\nendcmdargs\nprint v';
const scriptPath2 = path.join(tmpDir, 'inject_cmdargs.ns');
fs.writeFileSync(scriptPath2, script2);
const r4 = cp.spawnSync('node', [DIST, '--inject', 'fs,http', scriptPath2, '--', 'hello'], { cwd: ROOT, encoding: 'utf8' });
check('CLI --inject 与 cmdargs 分隔符互不干扰', r4.status === 0 && r4.stdout.split('\n').filter(Boolean)[0] === 'hello', 'exit=' + r4.status + ' stdout=' + JSON.stringify(r4.stdout) + ' stderr=' + JSON.stringify(r4.stderr));

// 清理临时目录
fs.rmSync(tmpDir, { recursive: true, force: true });
if (fs.existsSync(scriptPath)) fs.unlinkSync(scriptPath);

console.log('');
console.log(passed + ' passed, ' + failed + ' failed');
process.exit(failed === 0 ? 0 : 1);
