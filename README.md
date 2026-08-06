# NoethingScript

基于行的显式类型脚本语言，由 NSI（NoethingScript Interpreter，TypeScript 编写的解释器）运行。

A line-based, explicit-type scripting language, powered by the NSI interpreter (written in TypeScript).

## 特性

- **显式声明**：变量必须声明作用域（`global`/`local`）与数据类型（`number`/`int`/`float`/`string`/`bool`/`array`）；声明初始化只允许字面量表达式（禁止引用变量）
- **流程控制**：`if`/`else`、`for`（C 风格，循环变量只读）、`while`、`switch`、`break`/`continue`
- **函数**：形参、返回值变量、`return` 即时返回；支持 `mut` 可变引用参数与 `copy` 深拷贝
- **数组**：定长声明、`arrfill` 填充、`len()` 长度；四种传参模式（只读引用/副本/字面量/可变引用 `mut`），整体赋值引用共享，只读视图写保护
- **异常处理**：`try`/`catch` 可捕获全部错误类型（`SyntaxError`/`TypeError`/`ReferenceError`/`RangeError`/`AssertionError`/循环初始化/循环更新错误等）
- **内置对象**：`Math`（sin/cos/tan/sqrt/abs/pow/floor/ceil/round/random）、`len`/`str`/`int`/`float`/`copy`/`input`（运行时输入，命令行读 stdin、浏览器默认 prompt 弹窗且可自定义绑定；浏览器交互模式支持挂起/恢复，供脚本自持主循环）
- **进制字面量**：二进制 `0b`、八进制 `0o`、十六进制 `0x`
- **调试控制**：`debug` 级别调节输出详细程度
- **国际化**：`--lang en|zh` 切换输出语言（默认中文），消息模板化语言包可扩展（l10n 友好）
- **统一错误报告**：`[ERROR N] [行 X] 类型: 消息`、`[WARN]` 警告、`[内部错误]`（解释器缺陷）、CLI `[错误]` 四层隔离，互不混淆
- **其他**：断言 `assert`、跳转 `jump`、清除量 `purge`、单行 `//` 与多行 `///`（独占行）注释

## 快速开始

```bash
# 安装依赖 (含 TypeScript)
npm install

# 编译到 dist/
npm run build

# 运行脚本 (默认中文输出)
node dist/noethingScript-Interpreter.js 脚本文件名.ns

# 英文输出
node dist/noethingScript-Interpreter.js 脚本文件名.ns --lang en

# 带调试级别运行 (0-3)
node dist/noethingScript-Interpreter.js 脚本文件名.ns --debug 2

# 帮助与版本
node dist/noethingScript-Interpreter.js --help
node dist/noethingScript-Interpreter.js --version
```

> 注：不支持短参数（如 `-h`）；以 `-` 开头的未知参数会提示"未知参数"而非被当作文件名。

## 浏览器中使用

解释器核心为纯 TypeScript，不依赖 Node.js API，可直接在浏览器中加载 `dist/noethingScript-Interpreter.js`，通过全局 `window.NSI` 调用：

```html
<script src="dist/noethingScript-Interpreter.js"></script>
<script>
    // 执行一段 NoethingScript 代码 (输出走 console, 与 Node 一致)
    window.NSI.run("global x:int = 42\nprint x * 2");

    // 切换输出语言 ('zh' | 'en', 默认 zh)
    window.NSI.setLanguage('en');
    window.NSI.getLanguage();

    // 绑定自定义输入: input() 调用此同步函数, 而非默认的 prompt 弹窗
    window.NSI.setInput(() => document.getElementById('inputBox').value);
    window.NSI.setInput(null); // 恢复默认 prompt

    // 交互执行 (程序模式): 脚本自持主循环, 跑到 input() 时挂起返回 'suspended',
    // 由 JS 喂入输入继续执行, 直到脚本自然结束返回 'finished'
    const status = window.NSI.runInteractive(NS_SCRIPT, () => {});   // 启动/重新开局
    function onKey(key) { window.NSI.resumeInput(key); }             // 每按键喂一次
</script>
```

`window.NSI` 提供：`version`、`run(code)`、`runInteractive(code, onInput?)`、`resumeInput(value)`、`setLanguage(lang)`、`getLanguage()`、`setInput(handler)`，以及底层类 `Interpreter`/`ExpressionEvaluator`/`ScopeManager` 和语言包 `LANG_PACKS`。在 Node 环境中加载本文件不会挂载 `NSI`，命令行行为不受影响。交互执行完整示例见 `examples/2048_web.html`（脚本与命令行版 `examples/2048.ns` 同构、自持主循环）。

## 示例

将以下代码保存为 `example.ns` 并运行：

```ns
global message:string = "Hello, NoethingScript!"
print message

global array data[5]:int = [10, 20, 30, 40, 50]
for (local i:int = 0; i < len(data); i = i + 1)
    print data[i]
endfor

:add (a:int, b:int) -> sum:int
    sum = a + b
    return sum
:end

call add(3, 4) -> result
print result

try
    print undefinedVar
catch (Exception err)
    print "caught: " + err
endtry
```

## 性能基准

内置合成基准与 2048 端到端基准（`benchmarks/`），可对比当前版与任意基线提交：

```bash
npm run bench          # 合成基准: 当前版 vs 原生 JS (全局/局部循环、函数调用、数组读写)
npm run bench:head     # 合成基准: 对比基线提交 (默认 HEAD~1, 自动编译基线, 含行吞吐)
npm run bench:2048     # 2048 端到端计时 + 固定种子确定性校验 (语义零回归验证)
node benchmarks/ns_perf_bench.js --base=<rev>   # 对比任意提交 (如 --base=7fc14c5)
```

说明：行吞吐口径为每轮循环执行 4 行（`while` 条件行 + body + `endwhl` 结构行）；倍率以原生 JS 稳态中位耗时（200 次预热 + 100 次计时）为基准，JS 侧为微秒级，绝对倍率仅供参考，相对变化与历史对比请保持同一脚本同一口径。基线产物缓存于 `.bench-head/`（已 gitignore），基线提交变化时自动重建。

### 运行环境

基准结果与硬件 CPU 与 Node 版本强相关，两个基准脚本每次运行都会自动打印运行环境（`printEnv()`），对比数字时请先核对环境一致：

```text
运行环境: Node v22.23.1 / AMD Ryzen 5 5600 6-Core Processor (12 线程) / linux 7.1.6-201.fc44.x86_64
```

记录于 2026-08 的参考数据（本机实测）为上述环境。跨环境对比时，同一代码在更快的 CPU/更新的 Node 上数字会整体更好，但相对变化（当前版 vs 基线提交）在不同环境间基本可比。

### 历史性能记录

以下数字均来自各提交信息，全部为**参考环境（上述 Node/CPU）实测**，相对变化为同环境、同基准脚本口径下测得，可追溯：

| 提交 | 基线 | 相对变化 |
|---|---|---|
| `7fc14c5` 解释器全面提速 | 最初版本 | 循环 -56%，函数 -42%，数组 -74%；倍率 ~11800x → ~4600x |
| `8bee034` 局部变量槽位化 | `7fc14c5` | 局部循环 -26%，局部数组 -20%；2048 端到端 -11% |
| `347d7c3` 函数/表达式/数组特化 | `71c997d` | 局部循环 -29%，局部数组 -28%，全局循环 -18%，全局数组 -23%，函数调用 -10%；2048 端到端 -19% |

如需复现任一历史版本的绝对数字：`git show <rev>:noethingScript-Interpreter.ts` 取回源码编译后，用当前基准脚本在参考环境重跑即可。注意：`347d7c3` 之后基准脚本才加入自动打印环境（`printEnv()`），更早提交无环境记录，故统一以上述参考环境为准。

## 目录结构

```
NoethingScript/
├── noethingScript-Interpreter.ts   # 解释器源码
├── benchmarks/                     # 性能基准 (合成基准 + 2048 端到端, 支持基线对比; npm run bench)
├── doc.md                          # 语言规范手册
├── tests/                          # 功能测试用例 (.ns) 与目标清单 (tests_goals.md), 含 input 演示 (tests/input_demo.ns, tests/input_browser_demo.html)
├── examples/                       # 演示项目: 2048 命令行游戏 (examples/2048.ns) 与网页版 (examples/2048_web.html, 浏览器中直接打开)
├── vscode-extension/               # VSCode 语法高亮扩展 (NoethingScript Language Support)
├── dist/                           # 编译产物 (npm run build 生成)
├── tsconfig.json
└── LICENSE
```

## 语言规范

完整语法规则见 [doc.md](doc.md)。

## 版本历史

- **2.4.4**：性能优化——局部变量槽位化 O(1) 访问、函数调用特化（参数/返回值帧槽位、帧清理 O(1) 截断）、表达式求值数字快速路径、数组访问帧缓存；新增 `benchmarks/` 基准测试（合成基准 + 2048 端到端 + 确定性校验），基准自动打印运行环境，README 补历史性能记录追溯
- **2.4.0**：内置 `input()` 运行时输入——命令行同步读取 stdin（含中文），浏览器默认 prompt 弹窗、可 `NSI.setInput()` 自定义绑定（如页面输入框）；新增浏览器交互执行 `NSI.runInteractive`/`NSI.resumeInput`（input() 挂起/恢复，脚本可自持主循环，双环境通用）
- **2.3.1**：浏览器接口——全局 `window.NSI`（`run`/`setLanguage`/`getLanguage`/底层类），浏览器可直接加载 `dist` 产物运行脚本
- **2.3.0**：完整中英国际化（i18n）——`--lang en|zh` 切换输出语言，158 对双语消息模板，错误类型名中英对照，第一行切换提示
- **2.2.0**：数组四种传参模式、数组整体赋值与 `copy` 深拷贝、`return` 规则检测、只读传播修复
- **2.1.0**：声明初始化字面量限制、关键字补全、文档同步

## License

[Apache License 2.0](LICENSE)
