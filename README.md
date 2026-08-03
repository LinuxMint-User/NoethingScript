# NoethingScript

基于行的显式类型脚本语言，由 NSI（NoethingScript Interpreter，TypeScript 编写的解释器）运行。

A line-based, explicit-type scripting language, powered by the NSI interpreter (written in TypeScript).

## 特性

- **显式声明**：变量必须声明作用域（`global`/`local`）与数据类型（`number`/`int`/`float`/`string`/`bool`/`array`）
- **流程控制**：`if`/`else`、`for`（C 风格，循环变量只读）、`while`、`switch`、`break`/`continue`
- **函数**：形参、返回值变量、`return` 即时返回
- **数组**：定长声明、`arrfill` 填充、`len()` 长度
- **异常处理**：`try`/`catch` 捕获 `SyntaxError`、`TypeError`、`ReferenceError`、`RangeError`、`AssertionError` 等
- **调试控制**：`debug` 级别调节输出详细程度
- **其他**：断言、跳转 `jump`、清除量 `purge`、单行/多行注释

## 快速开始

```bash
# 安装依赖 (含 TypeScript)
npm install

# 编译到 dist/
npm run build

# 运行脚本
node dist/noethingScript-Interpreter.js 脚本文件名.ns

# 带调试级别运行 (0-3)
node dist/noethingScript-Interpreter.js 脚本文件名.ns --debug 2
```

## 示例

```vbnet
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
├── tests/                          # 测试用例
│   ├── testerrs/                   # 功能测试 (.ns)
│   └── alpha tests/                # 早期开发测试 (.nsi)
├── dist/                           # 编译产物 (npm run build 生成)
├── tsconfig.json
└── LICENSE
```

## 语言规范

完整语法规则见 [doc.md](doc.md)。

## License

[Apache License 2.0](LICENSE)
