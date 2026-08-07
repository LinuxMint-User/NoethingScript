# NoethingScript 寄存器型虚拟机 (NSVM) 指令集设计

> 版本: v0.3 (v0.2 实现验证后的实际架构修订, 以 BISECT/变体实测为准)
> 关联代码: `noethingScript-Interpreter.ts` (现有树遍历解释器)
> 目标: 在不改变**错误报告、try-catch、对外 API** 的前提下, 将解释执行模型逐步替换为"行级预编译 → 表达式字节码 → 寄存器型虚拟机"。

### v0.3 评审修订记录 (实现验证)

| # | 评审意见 (源自实现验证/BISECT) | 修订 |
|---|---|---|
| 1 | 语句级全寄存器微指令化 (LOADK/ADD/SETGLOBAL 逐条展开) 收益假设错误 | §2/§3/§8: 实际采用**混合架构** —— 热语句 (控制流/函数调用/数组声明与赋值/for) 编译为指令; 冷语句 (print/purge/普通赋值/普通声明) 委托 `STMT` 指令走行解释器。**删除**语句级 LOADK/MOVE/GETGLOBAL/SETGLOBAL/GLOBALDECL/ARRAYLEN/ARRAYASSIGN/ARRFILL/PRINT/ASSERT/PURGE* 的指令化要求 |
| 2 | GETARRAY 指令实测负收益 | §3: `GETARRAY` **保留但不启用**。BISECT 实测完整实现 (数组访问走指令) 2048 端到端 +6~8%, 回退表达式树求值后无劣化 |
| 3 | "for 零帧"简化与逐字节回归冲突 | §2.5: **for 保留运行时帧**。循环变量只读 (checkLoopVarWritable)、jump 重入复用、自然结束清理时机均依赖 CONTROL_FLOW_STACK 的 for 帧; 以 FORINIT/FORUPD/FORCLEAN 指令复刻, 而非编译期消除 |
| 4 | 复杂分支内联进主分发循环有害 | §8/§9: 复杂指令执行器一律**外提为独立方法**, case 仅委托调用。BISECT: SETARRAY 内联实现 2048 端到端慢 ~20%, CALLFUNC 内联慢 ~3%, 内联块拖累主分发循环的 V8 优化 |
| 5 | "移除旧行解释器依赖"与实际矛盾 | §8: `STMT` 委托是主路径的**组成部分** (冷语句委托优于指令化), 非"兜底开关"; 双模式由"热语句指令化 + 冷语句委托 + 整表达式原子回退"构成, 无部分执行状态 |
| 6 | 编译器改动与执行器改动的成本归属 | 变体验证 (vNoFull): 编译器照常发射新指令但执行器回退行解释器 → 与 full 端到端无差别 (-0.1%), 证明编译器改动零成本; 性能差异全部来自执行路径选择 |
| 7 | 函数调用执行路径仍有约 4.3µs/次 (debugLog 闭包 ~20 个/次、bodyStartLine 逐行扫描/次、RETV 二次分发、parseValue 双查找) | §5.6/§8: **函数调用热路径系统惰性化** —— CALLFUNC 元数据加 `bodyStartLine` (编译期预解析, 免运行期逐行扫描); `RETV`/`RET` case 直接调 `executeReturn`/`executeFunctionEndTag` (跳过 `executeCommand` switch 二次分发); 函数路径全部 debugLog 包 `if (DEBUG_LEVEL >= N)` 门控 (低级别免闭包创建, 高级别输出逐字节不变), 覆盖 executeCallCompiled/getVariable/getVariableInfo/addVariable/executeReturn/executeFunctionEndTag/executeOperation。实测: 函数调用 5 万 -8% (9228x→8420x vs JS), 2048 端到端 -4% |

### v0.2 评审修订记录

| # | 评审意见 | 修订 |
|---|---|---|
| 1 | 编码与传参: 勿直接用 `[op,a,b,c]` 数组 (阶段2即切 Int32Array 扁平内存) 减 GC 压力 | §2.2 指令编码改为 `Int32Array` 扁平内存 (op/a/b/c 各 4 int32), 阶段 2 起实施 |
| 2 | 函数调用省去冗余 ARG 搬运, 实参直接求值到 argBase 区, CALLFUNC 携带元数据 | 删除 `ARG` 指令; 实参求值落 argBase 连续区; `CALLFUNC` 以 `modesK` (常量池预构建 Int32Array 模式表) 携带引用/拷贝元数据; `argc` 由模式表长度决定, 编译期已校验实参个数 |
| 3 | 双模式回退警惕寄存器状态不同步, 宁可编译期拒绝边缘情形也不静默回退 | §7/§8: 回退为**整表达式原子选择** (整体编译 or 整体树求值), 无部分状态; 不可编译构造 (call/arrayAccess/arrayAssignment 等) 编译期判定并整体回退, 绝不混合; 边缘情形 (jump 跳入函数体等) 编译期拒绝 |
| 4 | PURGEEXCEPT 预存寄存器号而非运行期查常量池名称 | §3 `PURGEEXCEPT k`: `consts[k]` 为编译期预构建的恢复描述数组 (name + reg + meta), 运行期直取寄存器号, 不再按名查表 (该指令连同恢复描述表于 v0.3 修订 #1 删除, 见 §3.3) |
| 5 | GETGLOBAL 严格"先存在性 (REFERENCE_ERROR) 后值 (undefined 抛 TYPE_ERROR)" | §4 明确并锁定检查顺序 |
| 6 | AND/OR 非短路副作用严防死守 | §3/§4: 求值器无跳转指令, 双操作数无条件先求值再二元判断, 从结构上杜绝短路; 阶段 2 起代码注释固化 |
| 7 | SWITCH 比较附带类型信息防隐式转换 | §3/§5.5: `SWITCHSTART` 保存 cond 类型码, `CASETEST` 按类型严格比较 (与现 executeCase 的 typeof 语义一致) |
| 8 | 统一 JZ/JNZ 操作数命名规范 | §3 统一为 `JZ src, target` / `JNZ src, target` (条件寄存器在前, 目标在后) |
| 9 | RETVAL 保留运行时类型校验作为编译期静态检查兜底 | §5.6: 返回值类型先在调用点编译期静态匹配检查; `RETVAL` 执行时仍做运行时类型校验兜底, 双保险 |

---

## 1. 设计目标与约束

| 项 | 说明 |
|---|---|
| 对外契约不变 | `NSI` 暴露的接口 (`loadProgram` / `run` / 输入输出 / 交互挂起恢复) 全部保持; `reportError` 输出格式与文案 (i18n `t()` 模板) 不变 |
| 错误行号不变 | 每条指令携带源行号, 任何运行时错误报告的行号与现有实现逐行一致 |
| try-catch 语义不变 | 异常捕获、`catch (Exception e)` 绑定、`endtry` 清理、跨函数冒泡, 与现实现完全等价 |
| 性能目标 | 行分发开销减半 (阶段 1) → 表达式免重复切词/建树/树遍历 (阶段 2) → 变量访问寄存器直读直写、控制流零帧开销 (阶段 3) |
| 实施方式 | 三个阶段渐进落地, 每阶段完成后现有 `tests/*.ns` 全量回归通过 |

---

## 2. 执行模型

### 2.1 程序结构 (编译产物, v0.3 修订: 混合架构)

程序被编译为一组**代码块**:

```
CompiledProgram {
  globalBlock: Block,            // 全局作用域
  funcs: { [name]: FuncBlock },  // 每个用户函数一个块
}

Block {
  instrs: Int32Array,     // 指令序列 (见 §2.2 编码), pc 顺序自增 (jump 除外)
  consts: any[],          // 常量池 (数字/字符串/布尔/实参模式表/调用元数据/数组元数据/条件表达式串)
  lines: number[],        // 行号表, lines[i] 与 instrs[i] 一一对应 (源行号, 0 基)
  handlers: Handler[],    // 异常处理器表 (见 §6)
  lineToInstr: number[],  // 源行号 → 指令索引 (jump 目标解析; -1 = 无指令)
}
```

> v0.3 修订: 删去 v0.2 的 `globalNames`/`builtins` 名表与 `nRegs`/`labels` 字段。语句级**不设寄存器文件与名表**, 全局/局部变量访问继续走原槽位/查找路径; 表达式级独立寄存器 (见 §2.3)。标签目标经 `lineToInstr` 在编译期解析。

### 2.2 指令编码 (Int32Array 扁平内存)

统一为固定 4 字段扁平内存, 阶段 2 起即采用, 降低 GC 压力:

```
Instruction = Int32Array[4]   // [op, a, b, c], 每指令占 4 个 int32; 块指令序列为整体 Int32Array
```

- `op` — 操作码 (数字枚举, 见 §3 总表)
- `a/b/c` — 操作数, 含义按指令而定, 未用字段填 0
- 操作数取值: **常量池索引 k** (表达式串/元数据/字符串/Int32Array 模式表等) / **源行号** (STMT/RETV/RET) / **指令索引 target** / **未用字段填 0**。表达式级另有**寄存器号** (ExprOp 的 dst/src)。
- 字符串等非数值数据一律经常量池 (`consts[k]`) 间接引用, 指令流内只存整数

### 2.3 寄存器文件 (v0.3 修订: 仅表达式级, 语句级无寄存器)

**v0.2 主张的语句级寄存器文件 (Frame.regs + slotMeta, 局部变量=固定寄存器) 经实现验证未采用** (v0.3 修订 1): 变量访问继续走原 `SLOT_BY_NAME` 槽位快速路径 + 回退查找, 收益已由阶段 2 的 `LOADVAR` 槽位绑定取得, 语句级再叠寄存器文件收益趋零且改动面巨大。**实际只有表达式级存在寄存器**:

```
ExprFrame {
  regs: any[];        // 临时寄存器数组 (长度 = ExprCode.nTemps, 寄存器 0 恒为结果寄存器)
  // 变量/字面量经 LOADVAR/LOADK 进入临时寄存器; 语句级变量读写不经此帧
}
```

- **表达式临时寄存器**: 编译器从 0 起为表达式中间结果分配, 表达式求值完即回收。
- **全局/局部变量不占表达式寄存器**: 由 `LOADVAR` (槽位绑定或原查找) 读写, 语义复刻 evalTree 的 variable 分支 (先存在性后值检查)。
- **数组变量**: 值与现实现一致 (`Variable` 对象), 整体赋值走引用拷贝。

### 2.4 常量池

数字、字符串、布尔字面量在表达式级编译为 `LOADK dst, k` (语句级无 LOADK, 见 §3.3)。`null`/`undefined` 关键字在表达式中被现语言禁止 (运行时抛错), 不放入常量池。数组字面量经 `CALLFUNC` 元数据内预拆分的元素串在运行期创建临时数组 (每次调用独立对象, 避免共享)。语句级常量池还承载: 实参模式表 (`CALLFUNC` 的 `modesK`)、调用元数据、数组声明/赋值元数据、条件表达式串、断言信息、异常变量名等。

### 2.5 控制流运行时帧 (v0.3 修订: for 保留帧)

| 构造 | 编译方式 | 运行时帧 |
|---|---|---|
| `if` / `else` / `endif` | 条件求值 + `JZ`/`JMP` 跳转 | **无** (编译期消除) |
| `while` / `endwhl` | `JZ` + `JMP` 回环 | **无** |
| `for` / `endfor` | init / cond / body / update 四段跳转, `break`→循环尾, `continue`→update 段 | **for 帧** (保留, 见下) |
| `switch` / `case` | 见 §5.5 (保留帧) | switch 帧 |
| `try` / `catch` / `endtry` | 见 §6 (保留帧) | try / catch 帧 |
| 函数调用 | 见 §5.6 (保留帧) | function 帧 |

**收益**: if/while 不再压栈弹栈, 异常回退时也无需清理这些无状态帧; `break`/`continue` 的目标在编译期直接解析为指令索引。

**for 帧为何保留** (v0.3 修订, 替代 v0.2 的"零帧"主张):
- 循环变量只读保护: `checkLoopVarWritable` 依赖 `CONTROL_FLOW_STACK` 中的 for 帧判断 update 段豁免 (FOR_UPDATE_VAR) 与函数体外的写保护;
- `jump` 重入已初始化的循环: 需复用既有变量与帧 (FORINIT 判定 `hasVariable` 复用);
- 循环自然结束 vs `break` 跳出的变量清理时机不同: FORCLEAN 复刻条件不满足分支的 `cleanupLocalVariable`, 而 break 跳出时循环变量残留 — 两者语义必须逐字节一致。

对应实现: `FORINIT` (声明循环变量 + 压帧) / `FORUPD` (更新段, 设置只读豁免) / `FORCLEAN` (自然结束清理 + 弹帧)。

---

## 3. 指令集总表

### 3.1 v0.3 实际指令集 (语句级 NSVMOp)

> v0.2 的设计指令集经实现验证后重组如下。**实际语句级指令共 23 条**, 编码为 `Int32Array[4]` `[op, a, b, c]`; 操作数含义按指令而定 (常量池索引 k / 源行号 / 指令索引 target / 元数据常量索引)。指令**编号经实现后固定**, 不得重排 (已废弃 CALL 保留编号防错位)。

| # | 助记符 | 操作数 | 语义 | 相对 v0.2 |
|---|---|---|---|---|
| 0 | `HALT` | - | 结束全局块执行 | 保留 |
| 1 | `STMT` | `a=行号` | **委托行解释器**: 执行 `executeCommand(LINE_INFO[a].stmt, content)` (冷语句: print/purge/普通赋值/普通声明/纯表达式) | **新增** (混合架构核心) |
| 2 | `JMP` | `target` | 无条件跳转指令索引 | 保留 |
| 3 | `JZ` | `a=condK, b=target` | 条件表达式 (常量池索引) 为假 → 跳转; 复刻 if/while 调试输出与 while 帧压弹 | 保留 (条件载体改为常量索引) |
| 4 | `JNZ` | `a=condK, b=target` | 条件表达式为真 → 跳转 | 保留 |
| 5 | `CALL` | - | **已废弃** (编号保留, 无指令再发射; 由 CALLFUNC 取代) | 废弃 |
| 6 | `RETV` | `a=行号` | 带值返回 (executeReturn + VM 帧恢复) | 保留 (= v0.2 `RETVAL`) |
| 7 | `RET` | `a=行号` | 无值返回 `:end` | 保留 |
| 8 | `FORINIT` | `a=init 元数据 K` | 声明循环变量 (jump 重入复用) + 压 for 帧 | **新增** (for 帧保留) |
| 9 | `FORUPD` | `a=更新表达式 K, b=变量名 K` | 更新循环变量 (只读豁免 FOR_UPDATE_VAR) | **新增** |
| 10 | `SWSTART` | `a=condK, b=类型错误目标` | 求值条件 + int/string 类型检查 + 压 switch 帧 | 改名 (v0.2 `SWITCHSTART`) |
| 11 | `SWCASE` | `a=case值K, b=匹配目标, c=跳过目标` | 按类型严格比较; 匹配跳 body, 已匹配则跳 skip | 拆分 (v0.2 `CASETEST`) |
| 12 | `SWDEF` | `a=default体目标, b=跳过目标` | default 分支 | **新增** (v0.2 用 JMP 表达) |
| 13 | `SWEND` | - | 弹 switch 帧 | 改名 (v0.2 `SWITCHEND`) |
| 14 | `TRY` | `a=handler 索引` | 压 try 帧 | 保留 |
| 15 | `CATCH` | `a=异常变量名 K, c=endtry 行号` | 异常进入: 绑定异常变量; 正常: 跳过 catch 体 | 保留 |
| 16 | `ENDTRY` | - | 清理 try/catch 帧 | 保留 |
| 17 | `ASSERTFAIL` | `a=消息 K` | 抛 AssertionError | 保留 |
| 18 | `FORCLEAN` | `a=init 元数据 K` | 循环自然结束清理变量 + 弹帧 (break 跳出时跳过) | **新增** |
| 19 | `ASSERTCHK` | `a=assert 信息 K, b=跳过目标` | 复刻 executeAssert: 真值性判断 (非布尔不报错) + 调试输出; 假则 ASSERTFAIL | **新增** (v0.2 `ASSERT`+JNZ 组合不够逐字节) |
| 20 | `CALLFUNC` | `a=fn名K, b=modesK, c=调用元数据 K` | 用户函数调用; argc **一律从 consts[b] 模式表长度读取** (绝不从操作数携带); 实参表达式串预拆分存元数据, 运行期逐实参求值/绑定 | 保留 (argBase 连续区改为元数据) |
| 21 | `NEWARRAY` | `a=数组声明元数据 K` | 数组声明: 编译期预解析格式/元素拆分, 运行期复刻 executeArrayDeclaration (长度求值/类型检查/arrfill/登记) | 保留 (元数据替代 lenReg) |
| 22 | `SETARRAY` | `a=数组赋值元数据 K` | 数组元素赋值 `arr[i]=expr`: 编译期预建整行表达式树, 运行期复刻 executeOperation 数组分支 | 保留 (元数据替代寄存器) |

### 3.2 v0.3 实际指令集 (表达式级 ExprOp, 阶段 2)

表达式编译为独立指令流 (挂载于树节点缓存, `ExprCode.code: Int32Array`), **与语句级指令流分离**:

| 助记符 | 语义 |
|---|---|
| `LOADK` `LOADVAR` | 字面量 / 变量读取 (槽位快速路径 → 回退查找; 先存在性后值检查) |
| `UNPOS` `NEG` `NOT` | 一元运算 |
| `ADD` `SUB` `MUL` `DIV` `MOD` `POW` | 算术 (数字快速路径; 除零检查) |
| `EQ` `NEQ` `LT` `GT` `LE` `GE` | 比较 (类型不同 `==`/`!=` 返 false) |
| `AND` `OR` | 逻辑 (非短路, 结构上杜绝) |
| `GETARRAY` | 数组元素读取; **实现但不启用** (见 3.3) |

### 3.3 v0.2 设计指令的处置清单 (实现验证结论)

| 处置 | 指令 | 理由 (实测) |
|---|---|---|
| **删除** (回退行解释器) | `NOP` `MOVE` `GETGLOBAL` `SETGLOBAL` `GLOBALDECL` `ARRAYLEN` `ARRAYASSIGN` `ARRFILL` `PRINT` `PURGEALL` `PURGEVAR` `PURGEEXCEPT` | 语句级寄存器直读直写收益不成立 (v0.3 修订 1): 变量读写走表达式级 `LOADVAR` + 原槽位/查找路径即可; 冷语句 (print/purge/声明) 委托 `STMT` 优于指令化。v0.2 修订 #4 的 `PURGEEXCEPT` 恢复描述表**确认不实施** (PURGE* 整体不指令化, 行解释器继续按名在局部变量作用域中查找/恢复排除变量, 非待办项) |
| **删除** | `CALLBUILTIN` | 内置函数调用不单独指令化, 走表达式求值 (调用点编译期预解析已有) |
| **保留不启用** | `GETARRAY` (表达式级) | BISECT: 完整实现 2048 端到端 +6~8%, 回退表达式树求值无劣化 (v0.3 修订 2) |
| **已实现** | 其余全部 | 见 §3.1/§3.2 |

> 说明: `jump (cond):label` 语句编译为"条件求值 + `JZ`/`JNZ` + `JMP`", 不需要专用指令; 标签目标在编译期解析为指令索引。`assert` 块 (`assert (cond)` / `"消息"` / `endasrt`) 编译为: `ASSERTCHK` (条件真值性判断 + 调试输出) → 假则 `ASSERTFAIL`。`debug N` 首行在加载期处理, 不产生指令。

---

## 4. 指令详细语义 (执行器要点)

所有二元/一元指令的执行器**复刻现有 `evaluateOperation` / `evaluateUnaryOperation` 的完整语义**:

- **数值类运算符** (`- * / % ** < > <= >=` 及加减的数值分支): 操作数非数字时报 `TYPE_ERROR` (`op_left/right_operand_not_number`); 两操作数均为原生 `number` 时走数字快速路径 (直接 JS 运算)。
- **`/`**: 除零抛 `RANGE_ERROR` (`division_by_zero`)。
- **`==` / `!=`**: 类型不同返回 `false`, 不报错; 类型相同按值比较。
- **`&&` / `||`**: 操作数非布尔抛 `TYPE_ERROR` (`logic_op_*_not_bool`); **非短路** —— 求值器不含任何跳转指令, 两个操作数在二元指令执行前已被无条件求值, 副作用不可能被短路 (代码注释固化此约束)。
- **`+`**: 任一操作数为字符串则拼接 (`String() + String()`)。
- **变量读取** (`LOADVAR` / 原查找): 检查顺序锁死为 **① 存在性** (未定义 → `REFERENCE_ERROR`) → **② 值** (`undefined` → `TYPE_ERROR` `var_undefined_expr_*` / `var_value_undefined`); 数组整体返回 `Variable` 对象。
- **变量写** (语句级原 `setVariable` / 表达式级赋值): 复刻 `setVariable` 的类型校验与 const 检查; 循环变量只读保护 (`loop_var_readonly`) 由 `CONTROL_FLOW_STACK` for 帧 + `FOR_UPDATE_VAR` 豁免标志实现 (v0.3 修订 3: 无 slotMeta, 只读判定走运行时帧)。
- **数组指令**: 复刻 `getVariable` 的存在性/类型/const/readonly/越界 (`arr_index_out_of_range`)/元素类型校验 (`array_element_type_mismatch`) 全部检查。
- **行号**: 任何错误抛出时, `exception.lineNumber = lines[pc]`, 与现实现 "+1 显示" 规则一致。

---

## 5. 编译映射 (v0.3 修订: 语句级无寄存器分配)

> v0.2 的"变量 → 寄存器"分配 (槽位号=寄存器号, slotMeta) 未采用。实际映射:**语句级指令只携带常量池索引与指令目标, 不分配寄存器**; 表达式内部临时寄存器由 `ExprBytecodeCompiler` 自 0 起栈式分配。变量读写分别复刻 `evalTree` variable 分支与 `setVariable` 语义。

### 5.1 变量访问

复用现有 `SLOT_BY_NAME` 槽位快速路径 (表达式级 `LOADVAR` 携带编译期槽位绑定, 无绑定/槽位空则回退原查找); 语句级赋值/声明继续走原 `executeOperation`/`executeLocal`/`executeGlobal` 路径 (经 `STMT` 委托)。

### 5.2 赋值语句

```
i = i + 1                    →   STMT 委托行解释器 (executeOperation 求值右值 + setVariable 写回)
```

普通赋值不指令化 (v0.3 修订 1); 仅数组元素赋值 `arr[i]=expr` 指令化为 `SETARRAY` (编译期预建整行表达式树), 数组声明指令化为 `NEWARRAY`。

### 5.3 if / while

```
if (a > b) ... else ... endif
→
   consts[condK] = "a > b"        ; 条件表达式串入常量池 (运行期 evaluateExpression)
   JZ condK, elseL                ; 条件为假跳 else
   ...then 块...
   JMP endL
elseL: ...else 块...
endL:
```

```
while (c) ... endwhl
→
topL: JZ condK, endL             ; condK = "c" 常量索引
   ...body...
   JMP topL
endL:
```

条件表达式串在运行期经表达式字节码求值 (可编译则 `runExprCode`, 否则整表达式树求值); `JZ`/`JNZ` 复刻 if/while 的调试输出与 while 帧压弹语义。

### 5.4 for (v0.3 修订: for 帧保留)

```
for (local i:int = 0; i < n; i = i + 1) ... endfor
→
   FORINIT initMetaK             ; 声明循环变量 (jump 重入复用) + 压 for 帧
topL: JZ condK, endL             ; condK = "i < n"
   ...body...
updL: FORUPD updK, "i"           ; continue → updL; 更新变量带只读豁免 (FOR_UPDATE_VAR)
   JMP topL
endL: FORCLEAN initMetaK         ; break → endL (break 跳出时跳过 FORCLEAN, 变量残留)
```

循环变量只读保护由 for 帧 + `FOR_UPDATE_VAR` 豁免实现 (v0.3 修订 3, 替代 v0.2 的"寄存器 readonly 标记")。

### 5.5 switch

```
switch (x) case 1: ... case 2: ... default: ... endswc
→
   SWSTART condK, typeErrL       ; 求值条件 + int/string 类型检查 + 压 switch 帧
   SWCASE case1K, case1L, skipL  ; 按类型严格比较 (防隐式转换); 匹配跳 body, 已匹配跳 skip
   SWCASE case2K, case2L, skipL
   SWDEF defL, skipL             ; 无匹配跳 default 体 (或 skip)
skipL: SWEND                     ; case 块尾/无匹配汇合
   JMP endL
case1L: ...case1 块...
   JMP endL                      ; 复刻"已匹配后跳过后续 case"
case2L: ...case2 块...
   JMP endL
defL: ...default 块...
endL:
```

- `break` 在 case 块内 → `JMP endL`。
- 嵌套 switch: switch 帧栈式处理, `SWCASE`/`SWDEF` 只比较/作用于栈顶帧 (复刻现 `executeCase` 对最近 switch 帧的判断)。

### 5.6 函数调用 (无 ARG 搬运)

实参模式由编译期 `parseArrayArgument` 判定 (现 `executeCall` 内的运行时解析前移), 编码进实参模式表:

| 实参写法 | mode | 运行期处理 |
|---|---|---|
| 标量/表达式 | `0` (值) | `parseValue(元数据.argExprs[i], 形参类型)` → 绑定参数 |
| 数组名 (引用) | `1` (arrayref) | 数组对象引用绑定; callee 侧形参标只读视图 `isReadonlyArray` |
| `mut 数组名` | `2` (arraymut) | 数组对象引用绑定; callee 侧形参放开只读 |
| `copy(数组名)` | `3` (arraycopy) | 深拷贝后绑定 |
| `[字面量]` | `4` (literal) | 元素串拆分 → 创建临时数组 (只读视图) |

```
call add(a, b) -> sum        →   CALLFUNC fnK, modesK, metaK
                                     ; modesK: consts 内模式表 Int32Array [0,0] (长度即 argc)
                                     ; metaK: { funcName, callParams, content, argExprs, resultVar }
```

调用流程 (`CALLFUNC` → `executeCallCompiled`, 复杂语义外提, v0.3 修订 4/7):
1. `argc = modesK.length` (绝不从操作数携带)。
2. 查 `FUNCTIONS[fnK]` 不存在 → `REFERENCE_ERROR` (`func_undefined`)。
3. 实参个数与返回值规则已在编译期静态校验 (不匹配 → 编译期拒绝整体回退行解释器)。
4. 逐实参解析 (`mode 0` 用 `parseValue`, 失败报错后调用方继续, 无绑定污染); 建帧 (`CALL_FRAME_ID`)、绑定参数 (含 mut/引用只读视图处理)。
5. 执行 callee 块; `RETV`/`RET`: 复刻 executeReturn/executeFunctionEndTag, 成功路径弹帧恢复调用方, 失败路径 (报错后继续执行函数体) 不弹帧。

> v0.3 修订 7 (函数调用热路径优化): 调用元数据预存 `bodyStartLine` (编译期跳过函数体首条空行/标签行, 运行期免重复扫描 `programLines`); `RETV`/`RET` 不再经 `executeCommand` switch 二次分发, 由 case 按 op 直接调 `executeReturn`/`executeFunctionEndTag` (调试输出自行补齐, 逐字节不变); 函数调用路径全部 debugLog 惰性化门控, DEBUG_LEVEL 不足时不创建闭包。

表达式内函数调用仅限内置, 与现实现一致 (用户函数只能经 `call` 语句); 内置函数**不指令化** (v0.3 修订 1, 走表达式求值)。

### 5.7 数组声明 / 赋值

```
a[3]:int = {1, 2, i+1}        →   NEWARRAY declMetaK
                                     ; declMeta: { arrayName, lengthExpr, elementTypeStr,
                                     ;   elementValues: ["1","2","i+1"], isGlobal, isConst, ... }
                                     ; 运行期: 求长度表达式 → 类型检查 → 逐元素 parseInitValue → 登记
a[3]:int = arrfill            →   NEWARRAY declMetaK
                                     ; elementValues = null (arrfill): 填默认值

a[i] = expr                   →   SETARRAY setMetaK
                                     ; setMeta: { content, tree: 整行表达式树 (arrayAssignment), nTokens }
                                     ; 运行期: evalTree arrayAssignment (索引检查先于右值) → 查找/类型/const/readonly/越界检查 → 写元素
```

> v0.3 修订: 声明/赋值元数据替代 v0.2 的 `LOADK len`+`NEWARRAY`+逐元素 `SETARRAY` 展开; `GETARRAY`/`ARRAYLEN`/`ARRAYASSIGN`/`ARRFILL` 不启用 (修订 2)。

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
  2. 弹掉其上的控制流帧 (现 `CONTROL_FLOW_STACK.length = tryIdx + 1`) —— 在 VM 中需弹 switch 帧与 for 帧 (v0.3 修订 3: for 帧保留, 非 v0.2 所述"if/while/for 已无帧");
  3. `PENDING_EXCEPTION = exception`; 跳转 `pc = handler.catchInstr`;
  4. 当前块 handler 表若不存在匹配 (异常发生在 callee 块内) → 函数帧连带异常**冒泡到调用方** (弹帧、清理该帧异常标记), 调用方继续按本规则查找 —— 与现"异常穿越函数"行为一致。
- `CATCH`:
  - `PENDING_EXCEPTION != null`: 绑定异常变量 (`errorName`, string 类型, 值为 `exception.message`), 登记异常变量 (原 `executeCatch` 路径), 压 `CATCH_BLOCK` 帧;
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
| **双模式回退** | 回退为**整表达式/整构造的原子选择**: 表达式要么整体编译为字节码, 要么整体走树求值; 不可编译构造 (函数调用/数组访问/数组赋值等) 在编译期判定并整体回退, **绝不静默回退到部分执行状态**, 从根上杜绝寄存器状态不同步。v0.3 扩展: 混合架构中"指令化"与"STMT 委托行解释器"并存于同一块, 二者以**编译期静态分类** (热/冷语句) 而非运行期动态判定划分, 同一语句绝不部分指令执行 |
| `jump` 跳入函数体内部标签 | 现有行指针模型允许; VM 中标签按所在块解析, 目标位于函数块内属边缘情形 → **编译期拒绝** (报错), 不静默回退 |
| `input()` 挂起信号 | 执行器保留 `isInputSuspend` 穿透处理, 交互模式/恢复执行不受影响 |
| 数字字面量 (0x/0b/0o) | 编译期解析为数值入常量池 |
| `global.` 前缀 | 编译期去前缀解析为全局名索引 |

---

## 8. 三阶段实施计划 (v0.3: 三阶段均已完成)

### 阶段 1: 行级预编译 (已完成, 提交 9a25ca5)

- `loadProgram` 时把每行解析为**结构化行对象** (`StmtType` 数字枚举 + 预拼接参数)。
- 主循环执行改为数字类型 switch 分发, 替换"每行 trim + split + 关键字判定 + 字符串切片"路径。
- 表达式不变 (仍走 `ExpressionEvaluator.evaluate` 树求值)。
- 结果: 负载提速 23.6%~33.6% (平均约 28%), 23 个非交互测试输出与基线逐字节一致。

### 阶段 2: 表达式编译为指令 (已完成, 提交 ee5e79b)

- 引入表达式级字节码 VM: 块结构 (表达式级 `ExprCode`)、临时寄存器帧、常量池、`LOADK`/`LOADVAR`/一元/二元指令与执行器, 指令存 **Int32Array** 扁平内存。
- 编译输入为已缓存的表达式树 (不再二次切词/建树); 结果经两级缓存 (programId → 表达式 → `ExprCode|null`)。
- 覆盖: 字面量、变量读写、算术/比较/逻辑表达式 (含赋值语句右值), 间接覆盖 `print`/条件/声明初始化等全部表达式求值入口。
- 回退: 函数调用、数组访问、数组赋值等不可编译构造 → 整表达式原子回退树求值 (非短路与检查顺序等语义由求值器复刻锁定)。
- 保留执行器内数字快速路径。
- 验证: 表达式类测试 (expr_ops_tests / math_literals_tests 等) 全量通过; 基准对比。

### 阶段 3: 全覆盖 (已完成, 提交 b881828 → 2a7b98c → a3babcc; 按 v0.3 实际范围)

- 控制流指令化: if/while 编译跳转**零帧**; for 保留运行时帧 (`FORINIT`/`FORUPD`/`FORCLEAN`, v0.3 修订 3); switch 用 `SWSTART`/`SWCASE`/`SWDEF`/`SWEND` 四指令 (v0.2 `SWITCHSTART`/`CASETEST`/`SWITCHEND` 拆分, default 独立指令)。
- 函数指令化: `CALLFUNC`/`RETV`/`RET`/实参模式表 (`modesK`, argc 取自模式表长度), 帧栈、递归隔离、mut/copy 实参模式; 复杂语义**外提**至 `executeCallCompiled` (v0.3 修订 4)。
- 数组指令化: `NEWARRAY`/`SETARRAY` (编译期预解析元数据), **不启用** `GETARRAY`/`ARRAYLEN`/`ARRAYASSIGN`/`ARRFILL` (v0.3 修订 1/2)。
- 内置函数: **不指令化** `CALLBUILTIN`, 走表达式求值 (v0.3 修订 1)。
- 语句: 冷语句 (print/purge/普通赋值/普通声明) 经 `STMT` **委托行解释器** (混合架构, v0.3 修订 1/5); assert 用 `ASSERTCHK`+`ASSERTFAIL`; `jump` 编译为 JZ/JNZ/JMP。
- try-catch: §6 处理器表 + 跨函数冒泡, 行号对齐。
- 全局: **保留行解释器为 `STMT` 委托的主路径组成部分**, `NSI` API 不变。
- 验证: 全部 24 测试逐字节一致; 2048 确定性逐字节一致; 版本 2.6.0。

---

## 9. 预期收益与定位 (v0.3: 以实测收益为准)

- 阶段 1 (行级预编译): 已实现, 负载提速 23.6%~33.6% (平均约 28%)。
- 阶段 2 (表达式字节码): 已实现, 免去表达式重复切词/建树/树遍历 (树遍历递归 → Int32Array 扁平指令循环)。
- 阶段 3 (指令化): **收益集中在热路径** —— 控制流跳转零帧 (if/while)、`CALLFUNC` 合成基准 -9.2%、数组 `NEWARRAY`/`SETARRAY` 相对 2a7b98c -0.8% 净收益。
- **v0.3 实证修正**: 指令化收益**并非"越细越好"** —— 复杂指令执行器必须外提为独立方法 (case 仅委托), 内联进主分发循环会拖累 V8 优化 (SETARRAY 内联慢 ~20%); `GETARRAY` 完整实现反而 +6~8%; 冷语句委托 `STMT` 行解释器优于逐条指令化。**混合架构是实测最优形态**, 而非 v0.2 设想的全寄存器指令流。
- 本设计不改变语言语义, 只改变解释对象 (源码字符串 → 结构化行对象 → 指令流)。
