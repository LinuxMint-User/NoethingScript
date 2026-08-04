# NoethingScript

基于行的显式类型脚本语言，由 NSI（NoethingScript Interpreter，TypeScript 编写的解释器）运行。

A line-based, explicit-type scripting language, powered by the NSI interpreter (written in TypeScript).

## 特性

- **显式声明**：变量必须声明作用域（`global`/`local`）与数据类型（`number`/`int`/`float`/`string`/`bool`/`array`）；声明初始化只允许字面量表达式（禁止引用变量）
- **流程控制**：`if`/`else`、`for`（C 风格，循环变量只读）、`while`、`switch`、`break`/`continue`
- **函数**：形参、返回值变量、`return` 即时返回；支持 `mut` 可变引用参数与 `copy` 深拷贝
- **数组**：定长声明、`arrfill` 填充、`len()` 长度；四种传参模式（只读引用/副本/字面量/可变引用 `mut`），整体赋值引用共享，只读视图写保护
- **异常处理**：`try`/`catch` 可捕获全部错误类型（`SyntaxError`/`TypeError`/`ReferenceError`/`RangeError`/`AssertionError`/循环初始化/循环更新错误等）
- **内置对象**：`Math`（sin/cos/tan/sqrt/abs/pow/floor/ceil/round/random）、`len`/`str`/`int`/`float`/`copy`
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

## 示例

```ns
debug 0

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

## 目录结构

```
NoethingScript/
├── noethingScript-Interpreter.ts   # 解释器源码
├── doc.md                          # 语言规范手册
├── tests/                          # 功能测试用例 (.ns) 与目标清单 (tests_goals.md)
├── vscode-extension/               # VSCode 语法高亮扩展 (NoethingScript Language Support)
├── dist/                           # 编译产物 (npm run build 生成)
├── tsconfig.json
└── LICENSE
```

## 语言规范

完整语法规则见 [doc.md](doc.md)。

## 版本历史

- **2.3.0**：完整中英国际化（i18n）——`--lang en|zh` 切换输出语言，158 对双语消息模板，错误类型名中英对照，第一行切换提示
- **2.2.0**：数组四种传参模式、数组整体赋值与 `copy` 深拷贝、`return` 规则检测、只读传播修复
- **2.1.0**：声明初始化字面量限制、关键字补全、文档同步

## License

[Apache License 2.0](LICENSE)
