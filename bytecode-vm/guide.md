# NSVM 字节码虚拟机说明

> 说明文档:面向读者的实现说明,与 [design.md](design.md)(设计蓝图)互补。
> 设计蓝图回答"应该是什么",本文件回答"实际是什么、怎么跑、在哪看代码"。

## 1. 这是什么

NSVM(NoethingScript Virtual Machine)是解释器内部的一层字节码执行引擎。它在加载期把脚本编译为扁平指令流,运行期由分发循环执行,在**不改变错误报告、行号、try-catch 语义**的前提下提升性能。

两个文档的分工:

| 文档 | 性质 | 回答的问题 |
|---|---|---|
| `design.md` | 设计蓝图(v0.3) | 指令集应该怎么定、每种语句怎么映射、边界怎么处理 |
| `guide.md`(本文) | 实现说明 | 现在实际是什么样、执行流程怎么走、性能现状如何 |

## 2. 核心思想:混合架构

NSVM 不是"全部指令化",而是**热语句指令化 + 冷语句委托行解释器**:

| 类别 | 语句 | 处理方式 |
|---|---|---|
| 热语句(指令化) | 控制流(`if`/`while`/`for`/`switch`/`jump`)、函数调用、数组声明与赋值 | 编译为指令,运行期走 VM 分发 |
| 冷语句(STMT 委托) | `print`、`purge`、普通赋值、普通声明、纯表达式 | 发射 `STMT` 指令,运行期委托行解释器 `executeCommand` |

这是多轮 BISECT 实测得出的结论,**指令化并非越细越好**:

- 语句级全寄存器微指令化(`GETGLOBAL`/`SETGLOBAL`/`GLOBALDECL` 等逐条展开)收益不成立——变量读写走表达式级 `LOADVAR` + 原槽位/查找路径即可(design.md v0.3 修订 1)
- 表达式级 `GETARRAY`(数组元素读取指令化)实测 2048 端到端 **+6~8% 负收益**,故实现但默认不启用(修订 2)
- 复杂指令的执行器必须**外提为独立方法**,内联进主分发循环会拖累 V8 优化——实测 `SETARRAY` 内联慢 ~20%、`CALLFUNC` 内联慢 ~3%(修订 4)

## 3. 一次运行发生了什么

```
脚本 .ns ──加载──> 行信息 LINE_INFO + 槽位表 SLOT_BY_NAME
                │
                ├── 编译期: NSVMCompiler 逐语句编译 → 全局块 + 函数块
                │     任意语句不可编译 → 整体回退行解释器(见 §7)
                │
                └── 运行期: NSVMExecutor 分发循环执行指令流
                     ├── 表达式 → ExprBytecodeCompiler 编译为独立指令流
                     └── STMT 指令 → 委托行解释器
```

编译产物(`CompiledProgram`)含:

```
Block {
  instrs: Int32Array,   // 指令序列 [op,a,b,c] 扁平内存, pc 顺序自增
  consts: any[],        // 常量池: 数字/字符串/布尔 + 元数据
  lines: number[],      // 行号表 (与 instrs 一一对应)
  handlers: Handler[],  // 异常处理器表 (try-catch)
  lineToInstr: number[] // 源行号 → 指令索引 (jump 目标解析)
}
```

## 4. 指令流与常量池

- **编码**:`Int32Array[4]` = `[op, a, b, c]`,每指令固定 4 个 int32,整块为扁平内存,降低 GC 压力
- **语句级指令**:`NSVMOp` 枚举(源码 ~L6922)共 **23 条**,编号经实现后固定、不得重排(已废弃的 `CALL` 保留编号防错位)。完整表见 design.md §3.1,高频几条:
  - `STMT`(委托行解释器)、`JMP`/`JZ`/`JNZ`(控制流跳转)
  - `CALLFUNC`(函数调用,argc 从常量池模式表长度读取,**绝不从操作数携带**)
  - `NEWARRAY`/`SETARRAY`(数组声明/元素赋值)
  - `RETV`/`RET`(带值返回/`:end` 无值返回)、`FORINIT`/`FORUPD`/`FORCLEAN`
  - `TRY`/`CATCH`/`ENDTRY`、`SWSTART`/`SWCASE`/`SWDEF`/`SWEND`、`ASSERTCHK`/`ASSERTFAIL`、`HALT`
- **表达式级指令**:`ExprOp` 枚举(源码 ~L4955)——`LOADK`/`LOADVAR`(字面量/变量读取)、一元(`UNPOS`/`NEG`/`NOT`)、算术与比较(`ADD`~`GE`)、逻辑(`AND`/`OR` 非短路,从结构上杜绝短路副作用)、`GETARRAY`(实现但不启用)
- **常量池**除字面量外,还承载运行期需要的元数据:实参模式表(`CALLFUNC` 的 `modesK`)、调用元数据(`NSVMCallMeta`)、数组声明/赋值元数据、条件表达式串、断言信息、异常变量名等

## 5. 控制流帧

| 构造 | 运行时帧 | 原因 |
|---|---|---|
| `if` / `while` | **无**(编译期消除) | 条件求值 + `JZ`/`JMP` 跳转即可,压弹帧纯开销 |
| `for` | **保留 for 帧** | 循环变量只读保护、`jump` 重入复用、自然结束 vs `break` 的清理时机都依赖帧(v0.3 修订 3) |
| `switch` / `try` / 函数调用 | 保留帧 | `SWSTART`/`TRY`/`CALLFUNC` 压栈,`SWEND`/`ENDTRY`/返回弹栈 |

对应实现:条件表达式在运行期经表达式字节码求值(可编译则 `runExprCode`,否则整表达式树求值);`JZ`/`JNZ` 复刻 if/while 的调试输出与 while 帧压弹语义。

## 6. 函数调用路径

`call add(a, b) -> sum` 编译为 `CALLFUNC fnK, modesK, metaK`:

1. `argc = consts[modesK].length`,**绝不从操作数携带**(防不一致)
2. 实参模式由编译期 `parseArrayArgument` 判定,编码进模式表(5 种:值 / 数组引用 / `mut` 可变引用 / `copy` 深拷贝 / `[字面量]`)
3. 实参个数与返回值规则编译期静态校验,不满足整体回退行解释器
4. 运行期逐实参求值/绑定,建函数帧;`RETV`/`RET` 复刻 `executeReturn`/`executeFunctionEndTag`,成功路径弹帧恢复调用方,失败路径(报错后继续执行函数体)不弹帧

**已实施的热路径优化**(v2.6.2):函数体首条可执行行编译期预解析(免运行期逐行扫描)、`RETV`/`RET` 直调执行器(免 `executeCommand` switch 二次分发)、函数路径 debugLog 系统惰性化(低级别免闭包创建)。函数调用合成基准 -8%(9228x→8420x vs JS),2048 端到端 -4.1%。

## 7. 回退与安全

- **整表达式原子选择**:可编译则整体编译,否则整体走树求值,**绝不混合**
- **编译失败整体原子回退**:任何语句不可编译 → 整程序回退行解释器,无部分执行状态
- **边缘情形编译期拒绝**:如 `jump` 跳入函数体等,宁可拒绝也不静默回退
- **行号一致性**:每条指令携带源行号,任何运行时错误报告的行号与行解释器逐行一致

## 8. 性能现状

| 对比 | 倍率 |
|---|---|
| NS vs CPython(同为无 JIT 解释器) | 慢 20~68x |
| NS vs LuaJIT / JS 原生 | 慢 1000~9000x |
| 当前最弱项 | 函数调用(仍需优化) |

指令化的收益空间已多次 BISECT 收敛:**混合架构是当前口径下的最优形态**,继续往"全指令化"方向扩展收益趋零甚至为负。基准见 `benchmarks/ns_perf_bench.js` 与 `benchmarks/ns_2048_bench.js`(均支持与任意基线提交对比)。

## 9. 如何阅读源码

| 想了解 | 位置(noethingScript-Interpreter.ts) |
|---|---|
| 语句级指令枚举 | `NSVMOp` ~L6922 |
| 编译器(行→指令) | `NSVMCompiler` ~L7052 |
| 执行器(分发循环) | `NSVMExecutor` ~L7764 |
| 表达式级指令枚举 | `ExprOp` ~L4955 |
| 表达式编译器 | `ExprBytecodeCompiler` ~L4997 |
| 行解释器(委托目标) | `executeCommand` / `executeCall` / `executeArrayDeclaration` 等 |

> 行号随版本演进会变化,以源码中的类/符号名检索为准。

## 10. 验证与调试

- 运行期调试:`node dist/noethingScript-Interpreter.js 脚本.ns --debug 2`(0-3 级)
- 语义零回归:`node benchmarks/ns_2048_bench.js --head`(2048 端到端 + 固定种子确定性校验)
- 逐字节回归:`tests/` 下全部 `.ns` 用例输出逐字节一致是每轮改动的硬门槛(design.md §1 对外契约不变)
