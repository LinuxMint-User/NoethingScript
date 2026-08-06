# NoethingScript 寄存器型虚拟机 (NSVM) 指令集设计

> 版本: v0.1 (设计稿, 待审阅)
> 关联代码: `noethingScript-Interpreter.ts` (现有树遍历解释器)
> 目标: 在不改变**错误报告、try-catch、对外 API** 的前提下, 将解释执行模型逐步替换为"行级预编译 → 表达式字节码 → 寄存器型虚拟机"。

---

## 1. 设计目标与约束

| 项 | 说明 |
|---|---|
| 对外契约不变 | `NSI` 暴露的接口 (`loadProgram` / `run` / 输入输出 / 交互挂起恢复) 全部保持; `reportError` 输出格式与文案 (i18n `t()` 模板) 不变 |
| 错误行号不变 | 每条指令携带源行号, 任何运行时错误报告的行号与现有实现逐行一致 |
| try-catch 语义不变 | 异常捕获、`catch (Exception e)` 绑定、`endtry` 清理、跨函数冒泡, 与现实现完全等价 |
| 性能目标 | 行分发开销减半 (阶段 1) → 表达式免重复切词/建树 (阶段 2) → 变量访问寄存器直读直写、控制流零帧开销 (阶段 3) |
| 实施方式 | 三个阶段渐进落地, 每阶段完成后现有 `tests/*.ns` 全量回归通过 |

---

## 2. 执行模型

### 2.1 程序结构 (编译产物)

程序被编译为一组**代码块**:

```
CompiledProgram {
  globalBlock: Block,            // 全局作用域
  funcs: { [name]: FuncBlock },  // 每个用户函数一个块
  globalNames: string[],         // 全局变量名表 (g 操作数索引此表)
  builtins: string[],            // 内置函数表 (固定顺序, bi 操作数索引)
}

Block {
  instrs: Instruction[],  // 指令序列, pc 顺序自增 (jump 除外)
  consts: any[],          // 常量池 (数字/字符串/布尔/预构建数组字面量)
  lines: number[],        // 行号表, lines[i] 与 instrs[i] 一一对应 (源行号, 0 基)
  nRegs: number,          // 本块所需寄存器总数 (变量寄存器 + 临时寄存器)
  handlerTable: Handler[],// 异常处理器表 (见 §6)
  labels: { name: instrIdx },  // 标签名 → 指令索引 (jump 目标)
}
```

### 2.2 指令编码

统一为 4 字段扁平数组, 便于调试与执行:

```
Instruction = [op: OpCode, a: number, b: number, c: number]
```

- `op` — 操作码 (枚举数字, 见 §3 总表)
- `a/b/c` — 操作数, 含义按指令而定, 未用字段填 0
- 操作数取值: **寄存器号** / **常量池索引 k** / **全局名索引 g** / **内置函数索引 bi** / **函数名索引 fn** / **指令索引 target** / **类型码 type** / **实参模式 mode** / **参数个数 argc**

> 编码可后续优化为 `Int32Array` / 对象池, 不改变指令集语义。

### 2.3 寄存器文件

寄存器是 `any[]`。**一帧 = 一个寄存器数组**。

- **局部变量 = 固定寄存器**: 复用现有静态符号表 `SLOT_BY_NAME` 的槽位编号 —— 槽位号即寄存器号。声明 (类型/const/作用域行) 在编译期静态登记为帧元数据 `slotMeta[i]`, 运行时不再按名查找。
- **临时寄存器**: 编译器从 `maxVarSlot + 1` 起为表达式中间结果分配, 表达式求值完即回收 (栈式分配)。
- **全局变量不占寄存器**: 由程序级全局名表 + 运行时全局存储访问 (`GETGLOBAL`/`SETGLOBAL`/`GLOBALDECL`)。
- **数组变量**: 寄存器中存 `Variable` 数组对象 (与现实现一致), 整体赋值走引用拷贝。

```
Frame {
  regs: any[];        // 寄存器数组 (长度 = 块 nRegs)
  slotMeta: SlotMeta[]; // 变量元数据 (type/isConst/readonly), 编译期静态生成
  retAddr: number;    // 返回地址 (调用方块内的下一条指令索引)
  caller: Frame | null;
  block: Block;       // 当前代码块
}
```

### 2.4 常量池

数字、字符串、布尔字面量编译为 `LOADK dst, k`。`null`/`undefined` 关键字在表达式中被现语言禁止 (运行时抛错), 不放入常量池。数组字面量在**调用方块**内由 `NEWARRAY` + `SETARRAY` 展开 (保证每次调用创建独立对象, 避免共享)。

### 2.5 控制流运行时帧 (关键简化)

| 构造 | 编译方式 | 运行时帧 |
|---|---|---|
| `if` / `else` / `endif` | 条件求值 + `JZ`/`JMP` 跳转 | **无** (编译期消除) |
| `while` / `endwhl` | `JZ` + `JMP` 回环 | **无** |
| `for` / `endfor` | init / cond / body / update 四段跳转, `break`→循环尾, `continue`→update 段 | **无** |
| `switch` / `case` | 见 §5.5 (保留帧) | switch 帧 |
| `try` / `catch` / `endtry` | 见 §6 (保留帧) | try / catch 帧 |
| 函数调用 | 见 §5.6 (保留帧) | function 帧 |

**收益**: if/while/for 不再压栈弹栈, 异常回退时也无需清理这些无状态帧; `break`/`continue` 的目标在编译期直接解析为指令索引。

---

## 3. 指令集总表

| # | 助记符 | 操作数 | 语义 |
|---|---|---|---|
| 0 | `NOP` | - | 占位 (对齐/调试) |
| 1 | `HALT` | - | 结束当前块执行 (全局块末尾) |
| 2 | `LOADK` | `dst, k` | `R[dst] = consts[k]` |
| 3 | `MOVE` | `dst, src` | `R[dst] = R[src]` (寄存器间拷贝) |
| 4 | `GETGLOBAL` | `dst, g` | `R[dst] = 全局变量(globalNames[g])`; 含 undefined/引用检查, 数组返回对象 |
| 5 | `SETGLOBAL` | `g, src` | 全局赋值 `globalNames[g] = R[src]`; 含类型校验 / const 检查 |
| 6 | `GLOBALDECL` | `g, src, type` | 全局变量声明 + 初始化; 含登记/重复定义检查/类型转换 |
| 7 | `UNPOS` | `dst, src` | `R[dst] = +R[src]` |
| 8 | `NEG` | `dst, src` | `R[dst] = -R[src]` |
| 9 | `NOT` | `dst, src` | `R[dst] = !R[src]` |
| 10 | `ADD` | `dst, a, b` | `+` (数值运算或字符串拼接), 数字操作数快速路径 |
| 11 | `SUB` | `dst, a, b` | `-` |
| 12 | `MUL` | `dst, a, b` | `*` |
| 13 | `DIV` | `dst, a, b` | `/`, 含除零检查 (RangeError) |
| 14 | `MOD` | `dst, a, b` | `%` |
| 15 | `POW` | `dst, a, b` | `**` = `Math.pow` |
| 16 | `EQ` | `dst, a, b` | `==`, 类型不同返回 `false` (不报错) |
| 17 | `NEQ` | `dst, a, b` | `!=`, 同上 |
| 18 | `LT` | `dst, a, b` | `<` |
| 19 | `GT` | `dst, a, b` | `>` |
| 20 | `LE` | `dst, a, b` | `<=` |
| 21 | `GE` | `dst, a, b` | `>=` |
| 22 | `AND` | `dst, a, b` | `&&`, 双操作数必须为布尔 (抛错), **非短路** (与现实现一致, 两操作数均求值) |
| 23 | `OR` | `dst, a, b` | `||`, 同上 |
| 24 | `NEWARRAY` | `dst, lenReg, type` | 创建定长数组, 长度取 `R[lenReg]` (非负整数检查), 元素类型为 type |
| 25 | `GETARRAY` | `dst, arrReg, idxReg` | `R[dst] = R[arrReg][R[idxReg]]`; 索引类型/范围检查 |
| 26 | `SETARRAY` | `arrReg, idxReg, srcReg` | `R[arrReg][R[idxReg]] = R[srcReg]`; const/readonly/元素类型检查 |
| 27 | `ARRAYLEN` | `dst, arrReg` | `R[dst] = 数组长度` (供 `len`) |
| 28 | `ARRAYASSIGN` | `dst, src` | 数组整体引用赋值 (`b = a`), 含 const/readonly/只读传播检查 |
| 29 | `ARRFILL` | `arrReg, srcReg` | `arrfill`: 全部元素填 `R[srcReg]` |
| 30 | `JMP` | `target` | 无条件跳转到指令索引 target |
| 31 | `JZ` | `src, target` | `R[src]` 为假 → 跳转 (if/while/逻辑条件) |
| 32 | `JNZ` | `src, target` | `R[src]` 为真 → 跳转 |
| 33 | `SWITCHSTART` | `src` | 求值后的条件值入 switch 帧 (含 int/string 类型检查), 压栈 |
| 34 | `CASETEST` | `k, target` | 与栈顶 switch 帧条件比较 (未匹配时); 匹配则标记 `hasMatched` 并跳 target |
| 35 | `SWITCHEND` | - | 弹出 switch 帧 |
| 36 | `ARG` | `dst, src, mode` | 准备实参: `R[dst] = R[src]`; mode 编码引用/可变/拷贝模式 (见 §5.6) |
| 37 | `CALLBUILTIN` | `dst, bi, argBase, argc` | 内置函数调用, 结果 → `R[dst]`; 实参为 `R[argBase .. argBase+argc-1]` |
| 38 | `CALLFUNC` | `dst, fn, argBase, argc` | 用户函数调用; 建帧/拷参/执行 callee 块/恢复调用方 |
| 39 | `RET` | - | 无返回值返回 (void 函数 / `:end`) |
| 40 | `RETVAL` | `src` | 带值返回 |
| 41 | `TRY` | - | 压入 try 帧 (记录处理器表对应条目) |
| 42 | `CATCH` | - | 异常进入: 绑定 `PENDING_EXCEPTION` 为异常变量; 正常流程: 跳过 catch 块体 |
| 43 | `ENDTRY` | - | 弹出 catch/try 帧 |
| 44 | `PRINT` | `src` | `console.log(R[src])` |
| 45 | `ASSERT` | `src` | 断言: 真则继续; 假则后续用 `ASSERTFAIL` 抛错 |
| 46 | `ASSERTFAIL` | `k` | 抛 `AssertionError`, 消息 = `consts[k]` |
| 47 | `PURGEALL` | - | 清除全部局部变量 (含槽位/寄存器清理) |
| 48 | `PURGEVAR` | `nameIdx, isGlobal` | 清除指定变量 (局部或全局) |
| 49 | `PURGEEXCEPT` | `k` | `purge all except ...`: 清除全部局部, 恢复 `consts[k]` (名字数组) 中列出的变量 |

> 说明: `jump (cond):label` 语句编译为"条件求值 + `JZ`/`JNZ` + `JMP`", 不需要专用指令; 标签目标在编译期解析为指令索引。`assert` 块 (`assert (cond)` / `"消息"` / `endasrt`) 编译为: 条件求值 → `JNZ` 跳过断言体 → `ASSERTFAIL`。`debug N` 首行在加载期处理, 不产生指令。

---

## 4. 指令详细语义 (执行器要点)

所有二元/一元指令的执行器**复刻现有 `evaluateOperation` / `evaluateUnaryOperation` 的完整语义**:

- **数值类运算符** (`- * / % ** < > <= >=` 及加减的数值分支): 操作数非数字时报 `TYPE_ERROR` (`op_left/right_operand_not_number`); 两操作数均为原生 `number` 时走数字快速路径 (直接 JS 运算)。
- **`/`**: 除零抛 `RANGE_ERROR` (`division_by_zero`)。
- **`==` / `!=`**: 类型不同返回 `false`, 不报错; 类型相同按值比较。
- **`&&` / `||`**: 操作数非布尔抛 `TYPE_ERROR` (`logic_op_*_not_bool`); **非短路**, 两个操作数无条件求值。
- **`+`**: 任一操作数为字符串则拼接 (`String() + String()`)。
- **`GETGLOBAL` / 变量读取**: 未定义抛 `REFERENCE_ERROR`, 值为 `undefined` 抛 `TYPE_ERROR` (`var_undefined_expr_*` / `var_value_undefined`), 数组整体返回 `Variable` 对象。
- **`SETGLOBAL` / 局部变量写**: 复刻 `setVariable` 的类型校验与 const 检查; 循环变量只读保护 (`loop_var_readonly`) 由 `slotMeta` 的 readonly 标记 + `FOR_UPDATE` 豁免标志实现。
- **数组指令**: 复刻 `getVariable` 的存在性/类型/const/readonly/越界 (`arr_index_out_of_range`)/元素类型校验 (`array_element_type_mismatch`) 全部检查。
- **行号**: 任何错误抛出时, `exception.lineNumber = lines[pc]`, 与现实现 "+1 显示" 规则一致。

---

## 5. 寄存器分配与编译映射

### 5.1 变量 → 寄存器

复用现有 `SLOT_BY_NAME` (静态符号表, `buildSlotSymbolTable` 已按"函数/块 + 行号作用域"解析遮蔽与递归隔离):

```
槽位号 (帧内序号) = 寄存器号
slotMeta[槽位] = { name, type, isConst, isReadonly, scope }
```

- 全局块: for 循环变量与 catch 变量也登记为全局块的寄存器 (它们本就是局部语义)。
- 临时寄存器: 从 `maxVarSlot + 1` 起栈式分配; 调用实参区为连续临时寄存器。

### 5.2 赋值语句

```
i = i + 1                    →   GETGLOBAL/局部寄存器读 R[a]
                                 ADD  R[t], R[a], 常量1
                                 SETGLOBAL/写回寄存器 (含类型校验)
```

### 5.3 if / while

```
if (a > b) ... else ... endif
→
   GETGLOBAL R[a]; GETGLOBAL R[b]; GT R[t], R[a], R[b]
   JZ R[t], elseL            ; 条件为假跳 else
   ...then 块...
   JMP endL
elseL: ...else 块...
endL:
```

```
while (c) ... endwhl
→
topL: 求值条件 → R[t]
   JZ R[t], endL
   ...body...
   JMP topL
endL:
```

### 5.4 for

```
for (local i:int = 0; i < n; i = i + 1) ... endfor
→
   LOADK R[i], 0             ; init (i 为固定寄存器)
topL: 求值条件 (i < n) → R[t]
   JZ R[t], endL
   ...body...
updL: 求值更新 (i = i + 1)   ; continue → updL; 更新写 i 寄存器带 FOR_UPDATE 豁免
   JMP topL
endL:                        ; break → endL
```

循环变量寄存器标记 `readonly`, 仅 update 段写入时豁免 (对应现 `FOR_UPDATE_VAR` 机制)。

### 5.5 switch

```
switch (x) case 1: ... case 2: ... default: ... endswc
→
   求值 x → R[t]
   SWITCHSTART R[t]          ; 类型检查 + 压 switch 帧
   CASETEST 常量1, case1L    ; 与栈顶 switch 帧比较
   CASETEST 常量2, case2L
   JMP defL_or_endL          ; 无匹配
case1L: ...case1 块...
   JMP endL                  ; case 块末尾自动跳到 switch 尾 (复刻"已匹配后跳过后续 case")
case2L: ...case2 块...
   JMP endL
defL: ...default 块...
endL: SWITCHEND
```

- `break` 在 case 块内 → `JMP endL`。
- 嵌套 switch: switch 帧栈式处理, `CASETEST` 只比较栈顶帧 (复刻现 `executeCase` 对最近 switch 帧的判断)。

### 5.6 函数调用

实参模式由编译期 `parseArrayArgument` 判定 (现 `executeCall` 内的运行时解析前移):

| 实参写法 | mode | 编译 |
|---|---|---|
| 标量/表达式 | `0` (值) | 求值 → 参数寄存器 |
| 数组名 (引用) | `1` (arrayref) | `MOVE` 数组对象 → 参数寄存器; callee 侧形参标只读视图 `isReadonlyArray` |
| `mut 数组名` | `2` (arraymut) | `MOVE` 数组对象 → 参数寄存器; callee 侧形参放开只读 |
| `copy(数组名)` | `3` (arraycopy) | 先 `CALLBUILTIN copy` 深拷贝 → 参数寄存器 |
| `[字面量]` | `0` (值) | `NEWARRAY` + `SETARRAY` 展开 → 参数寄存器 |

```
call add(a, b) -> sum        →   GETGLOBAL R[a0]; GETGLOBAL R[b0]
                                     ARG R[a0], R[a0], 0     ; (必要时)
                                     ARG R[a1], R[b0], 0
                                     CALLFUNC R[res], 函数索引add, argBase, 2
```

调用流程 (`CALLFUNC`):
1. 查 `funcs[fn]` 不存在 → `REFERENCE_ERROR` (`func_undefined`)。
2. 返回值规则校验 (`-> result` 与返回类型匹配, `func_result_var_missing` / `func_result_var_unexpected`) —— 阶段 3 先在调用点编译期做静态匹配检查, 保持报错行号。
3. 建 callee 帧 (`regs = 该块 nRegs`), 按形参声明将实参拷入参数寄存器 (含 mut/引用只读视图处理)。
4. `retAddr` 指向调用点下一条指令, 执行 callee 块。
5. `RETVAL`/`RET`: 结果写入调用方 `R[dst]` (void 函数忽略), 恢复调用方帧。

表达式内函数调用仅限内置 (`CALLBUILTIN`), 与现实现一致 (用户函数只能经 `call` 语句)。

### 5.7 数组声明 / 赋值

```
a[3]:int = {1, 2, i+1}        →   LOADK R[len], 3
                                        NEWARRAY R[a], R[len], INT
                                        LOADK R[t0], 1; LOADK R[idx], 0; SETARRAY R[a], R[idx], R[t0]
                                        ... (逐元素)
                                        ADD R[t2], R[i], 常量1; LOADK R[idx], 2; SETARRAY ...
a[3]:int = arrfill            →   NEWARRAY R[a], R[len], INT
                                        LOADK R[f], 默认值; ARRFILL R[a], R[f]
```

---

## 6. 异常处理设计 (try / catch)

### 6.1 处理器表

编译期为每个块构建嵌套有序的异常处理器表:

```
Handler {
  tryInstr: number,     // TRY 指令索引
  catchInstr: number,   // CATCH 指令索引
  endtryInstr: number,  // ENDTRY 指令索引
  errorName: string,    // catch 异常变量名
}
```

### 6.2 运行时语义 (与现实现逐条对应)

- `TRY`: 压 try 帧 (记 tryInstr / 对应 handler), 并压 `EXCEPTION_STACK` 的 `TRY_BLOCK` 标记。
- 任何指令抛异常时 (同现主循环):
  1. 从 `EXCEPTION_STACK` 自顶向下找最近 `TRY_BLOCK`;
  2. 弹掉其上的控制流帧 (现 `CONTROL_FLOW_STACK.length = tryIdx + 1`) —— 在 VM 中仅需弹 switch 帧 (if/while/for 已无帧);
  3. `PENDING_EXCEPTION = exception`; 跳转 `pc = handler.catchInstr`;
  4. 当前块 handler 表若不存在匹配 (异常发生在 callee 块内) → 函数帧连带异常**冒泡到调用方** (弹帧、清理该帧异常标记), 调用方继续按本规则查找 —— 与现"异常穿越函数"行为一致。
- `CATCH`:
  - `PENDING_EXCEPTION != null`: 绑定异常变量 (`errorName`, string 类型, 值为 `exception.message`), 写入 catch 变量寄存器 (编译期已登记), 压 `CATCH_BLOCK` 帧;
  - `PENDING_EXCEPTION == null` (try 无异常正常走到 catch 行): 弹 `TRY_BLOCK` 标记与 try 帧, `JMP endtryInstr` 跳过 catch 块体。
- `ENDTRY`: 弹 `CATCH_BLOCK`/try 帧, 清理异常变量寄存器。
- 未捕获异常: 沿用现有两条路径 —— 脚本异常 `reportError` + 终止; 解释器内部错误打印 `internal_error` 提示。

### 6.3 错误报告

所有抛出的异常对象带 `lineNumber = lines[pc]`, `type`/`message` 与现实现完全一致; 未捕获时主执行入口负责 `reportError` 输出并终止 —— 对外输出格式不变。

---

## 7. 边界情形与兼容性决策

| 情形 | 处理 |
|---|---|
| `debug N` 首行 | 加载期设置 `DEBUG_LEVEL`, 不产生指令 |
| 多行注释 `///` / 空行 / 注释行 | 加载期已由 `LINE_INFO` 剥离, 不产生指令 (行号仍对齐源文件) |
| `:end` 无函数定义 / 函数内嵌套函数 / 无 return 语句 | 扫描期错误, 与现实现同时机报出 |
| `jump` 跳入函数体内部标签 | 现有行指针模型允许; VM 中标签按所在块解析, 若目标位于函数块内, 阶段 3 记录为已知边界情形, 优先保守回退到行解释器 (不影响其余指令化) |
| `input()` 挂起信号 | 执行器保留 `isInputSuspend` 穿透处理, 交互模式/恢复执行不受影响 |
| 数字字面量 (0x/0b/0o) | 编译期解析为数值入常量池 |
| `global.` 前缀 | 编译期去前缀解析为全局名索引 |

---

## 8. 三阶段实施计划

### 阶段 1: 行级预编译 (不动表达式)

- `loadProgram` 时把每行解析为**结构化行对象**: `{ type: 'assign'|'if'|'while'|'for'|..., lhs?, rhs?, params?, line }`。
- 主循环执行改为对行对象 `switch (type)` 分发, 替换现有"每行 trim + split + 关键字判定 + 字符串切片"路径。
- 表达式不变: 行对象中的 rhs/条件仍走现有 `ExpressionEvaluator.evaluate` (含树缓存)。
- 控制流/函数/try-catch 逻辑不动, 只换行入口分发。
- 收益: 行分发开销减半, 风险最小。
- 验证: 全部 `tests/*.ns` 通过; `benchmarks/` 对比。

### 阶段 2: 表达式编译为指令 (先数字运算)

- 引入 §2 的块结构、寄存器帧、常量池、`LOADK`/`MOVE`/`GETGLOBAL`/`SETGLOBAL`/一元/二元 (数字运算优先) 指令与执行器。
- 覆盖: 字面量、变量读写、算术/比较/逻辑表达式、`print`、赋值语句。
- 回退: try-catch、函数调用、数组、`call`、`jump` 等尚未指令化的构造, 仍回退阶段 1 行对象路径 (表达式仍可走原树求值)。
- 保留执行器内数字快速路径。
- 验证: 表达式类测试 (expr_ops_tests / math_literals_tests 等) 全量通过; 基准对比。

### 阶段 3: 全覆盖

- 控制流指令化: if/while/for/switch 编译跳转 (运行时帧仅保留 switch/try/function)。
- 函数指令化: `CALLFUNC`/`RET`/`RETVAL`/`ARG`, 帧栈、递归隔离、mut/copy 实参模式。
- 数组指令化: `NEWARRAY`/`GETARRAY`/`SETARRAY`/`ARRAYLEN`/`ARRAYASSIGN`/`ARRFILL`。
- 内置函数指令化: `CALLBUILTIN`。
- 语句指令化: `PRINT`/`ASSERT`/`PURGE*`/`jump` 语句。
- try-catch: §6 处理器表 + 跨函数冒泡, 行号对齐。
- 全局: 移除对旧行解释器的依赖 (或保留为兜底开关), `NSI` API 不变。
- 验证: 全部测试 + 2048 基准; 版本号升级。

---

## 9. 预期收益与定位

- 阶段 1 已可拿到行分发的一半收益;
- 阶段 2 免去表达式重复切词/建树/树遍历;
- 阶段 3 变量寄存器直读直写 + 控制流零帧 + 单遍指令分发, 是"解释器本身"意义上的全部收益;
- 本设计不改变语言语义, 只改变解释对象 (源码字符串 → 结构化行对象 → 指令流)。
