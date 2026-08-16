# 实现与设计偏差记录 (Implementation vs Design)

> 关联设计: `module-system/design.md`（v0.9）
> 关联实现: `noethingScript-Interpreter.ts`（2.7.3 + 模块系统 M1–M6 与 cmdargs）
> 用途: 专门记录解释器实现过程中**与设计稿的实际偏差**、**设计未明示处的实现决策**、以及**已达成确认/待办**的状态核对。
> 维护规则: 每完成一个新里程碑或设计稿修订，回到本文档增补/更新对应条目；已达成项标注状态，不删除（保留决策历史）。

## 状态速览

| # | 条目 | 类型 | 状态 |
|---|---|---|---|
| 1 | 加载完成后**不释放**模块源码 | 有意偏差（§7.5 注意点②） | 保持 |
| 2 | cmdargs 匿名填充跳过 bool 参数 | 设计未明示处的实现决策（§5.2.4） | 保持 |
| 3 | 模块内 cmdargs 语法错误仍报错 | 设计范围解读（§5.2.2） | 保持 |
| 4 | 加载期仅消费 `manifest.package`/`modules` | 部分实现（§7.3/§9.1，其余字段留给 M7） | 随 M7 推进 |
| 5 | design.md v0.9「cmdargs 未实现」注记过时 | 文档状态过时 | 待更新设计稿 |
| 6 | 点分调用无行解释器回退 | 已达成确认（非偏差） | — |
| 7 | 模块调用性能实测 | 验证结果（非偏差） | — |
| 8 | M7 模块管理器未实现 | 待办（非偏差） | 等用户决定 |
| 9 | input() 不支持 cast 类型（普通变量无 cast 类型） | 设计未实现（§5.2.5） | 保持（doc.md 已按实现修正） |
| 10 | registerGlobal JS 能力注入（§6） | 已实现（M7 前置, 2026-08-16） | 完成 |
| 11 | Node/CLI 注入入口（`--inject` + require NSI） | 已实现（M7 前置, 2026-08-16） | 完成 |

---

## 1. 加载完成后不释放模块源码（有意偏差，§7.5 注意点②）

- **设计**: 性能模型（§7.5 确认记录 #30）注意点②——「加载完成释放源码（缓存只服务加载期）」，内存最小化。
- **实现**: 加载完成后**不释放**，模块源码行保留在 `ns.sourceLines` 并作为 `programLines` 供运行期使用（`pushModuleContext` 按行指针语义工作，[loadModuleFile](file:///run/media/echan/DATA/项目/JavaScript Projects/NoethingScript/noethingScript-Interpreter.ts#L2884-2900)）。
- **原因（已论证）**:
  1. 运行期模块上下文切换按行指针语义，`programLines === ns.sourceLines` 是执行前提；
  2. NSVM 全量编译失败整体回退行解释器时，模块函数须按源码行执行——释放源码则回退路径无行可执行；
  3. `getReturnVarName` 等运行期辅助也读 `programLines`；
  4. 条件释放需引入「重编译恢复源码行」机制，复杂度/风险不成比例；而保留成本仅 KB 级（设计稿自述可忽略）。
- **影响**: 内存多 KB 级，换取行为正确性与回退健壮性。

## 2. cmdargs 匿名填充跳过 bool 参数（设计未明示处的实现决策，§5.2.4）

- **设计**: §5.2.4 只规定「匿名参数按声明顺序匹配」「匿名比声明少用默认值、多用丢弃警告」「bool 是开关（传入即翻转默认值，不吞后面的值）」。**未明示**匿名裸参数遇上 bool 声明时如何处理。
- **实现**（`bindCmdargs` 第二步）: 匿名填充时**跳过 bool**（保持默认值），裸参数按序流向后续 string/cast 声明；「匿名比声明多」的判定基准 = 可接收匿名值的声明数（string/cast），非全部声明数。
- **依据**: bool 无「值」概念（传入即翻转），裸参数无法表达翻转语义，跳过与 §5.2.7 开关语义一致。
- **验证**: `tests/cmdargs_tests.ns` 默认值场景 + 命令行 `-- run 99 2.5` 场景（bool 保持默认、99→cast.int、2.5→cast.float）。

## 3. 模块内 cmdargs 语法错误仍报错（设计范围解读，§5.2.2）

- **设计**: §5.2.2「非入口文件（被 use 的模块）写了 cmdargs **不报错、不生效**，参数保持默认值」。
- **实现**（`parseHeaderBlocks` 中 `parseParamDef`）: 「不报错不生效」按**绑定期**解读——模块被 use 时不接收命令行值，param 按默认值绑定为模块私有只读全局（autoinit/函数内可引用）；但 param **声明语法错误**（格式/未知类型/缺默认值/短名冲突/重复声明）在模块加载期仍报错，作为 §7.4 加载期错误整体终止、不可 try-catch。
- **解读依据**: 「不报错」约束的是命令行绑定动作，语法错误属加载期错误范畴（§7.4），模块作者写错声明应当被告知。
- **验证**: `tests/cmdargs_syntax_error.ns`（入口场景）+ 模块加载错误路径。

## 4. 加载期仅消费 manifest 的 package/modules 字段（部分实现，§7.3/§9.1）

- **设计**: 包根 `manifest`（JSON）字段 `package`/`version`/`ns`/`source`/`command`/`description`/`modules`。
- **实现**（`moduleLocate` inner 分支）: 解释器加载期只读 `package`（包根校验）与 `modules`（inner 模块存在性校验）；`version`/`ns`/`source`/`command`/`description` 加载期无消费者——按设计分工这些字段服务**模块管理器（M7）与打包工具 nsmp**，M7 未实现故未消费。
- **状态**: 随 M7 推进补齐消费方；加载期读 manifest 走同一 loader、不进源码缓存（`readModuleSource(name, false)`，避免与模块源码命名空间冲突）。

## 5. design.md v0.9「cmdargs 未实现」注记过时（文档状态）

- **现状**: design.md v0.9 变更记录（§11）与 §10.4 仍写「cmdargs 与关键字预留均为 2.7.x 计划，**未实现**」——这是 v0.9 定稿时的状态。
- **实际**: cmdargs（§5.2 全规格）与关键字预留（use/from/as/inner/modules/endmodules/cmdargs/endcmdargs/param/cast/autoinit/endautoinit）已于 **2026-08-16 全部实现**并进 26 项回归基线。
- **建议**: 下次修订设计稿时把「设计定稿 ≠ 已实现」注记改为「已实现」。

## 6. 点分调用无行解释器回退（已达成确认，非偏差，确认记录 #31）

- **设计**: 确认记录 #31——设计上不留回退（NS 静态语言，点分调用编译期全可解析，点分 call 必须编译进 NSVM）；仅允许 M1 过渡期（NSVM CALL 支持模块寻址前）临时回退行解释器保功能，M5 接入 NSVM 后**移除回退**。
- **实现**: M5 完成 `CALLFUNC` 指令（函数名/实参拆分/模式判定/个数与返回值校验全部前移到编译期），点分调用**无行解释器回退**（[编译注记](file:///run/media/echan/DATA/项目/JavaScript Projects/NoethingScript/noethingScript-Interpreter.ts#L8867-8921)）。
- **背景澄清（避免误判为回退）**: `tests/` 中 3 个 LINE 模式测试（`array_param_tests`/`edge_cases`/`try_catch_tests`）是 **NSVM 刻意不编译构造的既有设计性回退**（与模块系统无关）；旧版本同 21 NSVM / 3 LINE，探针对比验证一致，非模块改动引入。

## 7. 模块调用性能实测（验证结果，非偏差，§7.5）

- **设计**: 运行期零额外开销——共用同一调用管道（NSVM 指令/编译期绑定模块前缀/两跳查找链/值零转换/来源标识不进计算路径）。
- **实测**: 500k 次模块函数调用循环，NSVM **2.35s** vs 强制回退行解释器 **3.06s**，快约 **30%**，输出逐字节一致。符合设计预期。
- **实测 2（模块化 vs 单文件, 2026-08-16, `benchmarks/ns_module_bench.js`）**: 同一工作负载两种组织方式（函数内联主程序普通 call vs 模块函数点分 call），经真实 CLI 输出逐字节校验一致后各取 NS 中位耗时——轻函数高频调用（2.5 万轮×2 次）flat **196ms** / split **243ms**（模块化 **+24%**）；模块内数组求和（2.5 万次×16 读）flat **732ms** / split **741ms**（**+1%**）。结论：点分调用存在可测量的寻址/命名空间净开销，函数体越轻、调用越频繁占比越大，函数体内有实际计算时差异摊薄至噪声级——设计稿"运行期零额外开销"为量级描述，实测为小常数开销（微秒级/次）。

## 8. M7 模块管理器未实现（待办，非偏差）

- **设计**: §6 JS 能力分层 + §9.1 模块管理器（已完整定稿）：NS 逻辑 + `registerGlobal` 注入 fs/http + cmdargs 接收子命令（install/update/upgrade/check-update/check-upgrade/refresh/list/search/remove）、仓库 manifest 清单、http 按路径压缩包拉取、DNF 式缓存（TTL 7 天）、包内 manifest 读取 + 本地压缩包安装、命令包装；打包工具 `nsmp` 为独立包。
- **实现**: 未开始（解释器侧所有前置 M1–M6 + cmdargs + registerGlobal（§6）及 Node/CLI 注入入口（--inject/require）已全部完成，等用户决定后开工）。
- **连带待办**: 浏览器端模块加载注入 API（`setModuleLoader`/`setModuleDir`/`setCurrentFilePath`）已实现但无真实浏览器模块示例验证；模块示例库仅 tools/stack 两个，队列/集合示例未写。

## 9. input() 不支持 cast 类型（设计未实现，§5.2.5）

- **设计**: §5.2.5「应用: cmdargs 的 param（`param age:cast.int = 0`）; input() 赋值（`ratio = input()`，ratio 声明为 cast.float）」——cast 类型同时适用于 cmdargs param 与 input() 赋值，普通变量可声明为 `cast.int`/`cast.float`。
- **实现**: `cast.int`/`cast.float` **仅存在于 cmdargs param 定义**（`CmdargParamDef.type`）；普通变量声明不支持 cast 类型——`global ratio:cast.float = 1.5` 直接报语法错误（声明格式错误），`input()` 返回 string，需 `int()`/`float()` 显式转换。
- **验证**: 实测 `global ratio:cast.float` 报 `[ERROR 1] 语法错误: 全局变量声明格式应为 "global [const] 变量名:类型 = 值"`。
- **影响**: doc.md 原「`cast.类型`（两条输入通道共用的…接收类型）」为设计稿回声、与实际不符，已按实现修正为「cast 仅限 cmdargs 的 param」。

## 10. registerGlobal JS 能力注入（已实现，§6，M7 前置）

- **设计**: JS 能力分层（§6）——宿主 `registerGlobal(name, obj)` 注入 JS 对象，NS 代码中与 NS 模块**同形**（`名字.函数()` 点分调用），值互通零转换，注入对象返回值限四类（number/string/boolean/Array），返回对象/函数等视为非法值报错。
- **实现**（2026-08-16）:
  1. `NSI.registerGlobal(name, obj)` 挂载（浏览器）；注入对象包装为伪 `ModuleNamespace`（`source='js'`、`jsObj` 存原始对象），函数成员收录为 `FunctionInfo.isJS` 标记；**非函数成员忽略、同名注册覆盖**（设计未明示）。
  2. 调用路径：`resolveFunction` 点分分支加 JS 注入 fallback（**NS 模块对象优先**，注入对象次之，设计未明示的解析顺序）；行解释器与 NSVM 双路径经统一入口 `executeJSFunctionCall`（NSVM 编译期跳过形参个数/模式/返回值规则校验，不整体回退）；模块上下文（模块函数内）同样可见注入对象。
  3. 实参**宽松求值**（`evalArgForJS`）：数字/字符串/布尔/数组字面量、变量、数组（转 JS Array 值数组）、表达式兜底；**实参个数不校验**（JS 函数 arity 运行期自然处理，设计未明示，与宽松语义一致）。
  4. 返回值校验：四类 + **`NaN`/`Infinity` 拒收**（与语言非有限值规则一致）；结果变量未声明时按 JS 值类型自动建变量（整数→INT 小数→FLOAT，数组→数组变量），已声明走现有 `setVariable` 类型检查。
  5. 错误语义：宿主函数抛异常 → `TypeError`（消息带注入对象名，可 `try-catch`）；调用未定义成员 → `ReferenceError`（可捕获）；非法返回值 → `reportError` 不中断。
- **设计未明示处决策**: ① 非函数成员忽略/同名覆盖；② 模块对象优先的解析顺序；③ 实参个数不校验；④ **Node/CLI 注入入口**（浏览器经 `NSI.registerGlobal`，Node 侧最初无注入点——2026-08-16 已补，见 #11）。
- **实现注意**: 跨 realm（vm/浏览器）宿主 `Error` 的 `instanceof` 不可靠，异常消息按 `message` 属性提取（`Error: boom` vs `boom`）。
- **验证**: `tests/js_global_tests.js`（14 项：四类返回值/数组实参与返回/表达式实参/跨作用域/模块共存/模块内调用/宿主异常与未定义成员可捕获/非法返回值/注册校验），全过；26 项回归逐字节一致。

## 11. Node/CLI 注入入口（已实现，§6，M7 前置）

- **设计**: §9.1 模块管理器运行环境为 Node/CLI 专用，**依赖 registerGlobal 注入的 fs/http 能力**；但设计未规定 Node/CLI 侧由谁、以何种机制完成注入（浏览器侧 `window.NSI.registerGlobal` 明确，Node 侧留白）。
- **实现**（2026-08-16，两条通道，均复用 #10 的 `nsiRegisterGlobal` 与 JS 注入执行路径）:
  1. **命令行 `--inject <能力名[,能力名...]>`**（解释器参数，位于 `--` 分隔符之前）：运行脚本前注入**内置能力对象**，未知能力名报错退出（exit 1，显式性不静默忽略）。能力对象成员为函数，返回类型限四类（`fs` 的 void 操作返回 `true` 表示成功——四类校验不接受 `undefined`）；失败抛异常（NS 可 `try-catch`）。
  2. **Node `require` 与 `globalThis.NSI`**：NSI 公开对象改为单一 `NSI_PUBLIC` 常量，浏览器挂 `window.NSI`、Node 挂 `globalThis.NSI`，且 `module.exports = NSI_PUBLIC`——`require` 直接返回 NSI（宿主可 `registerGlobal` 注入自定义对象后 `run(code)`）。
- **设计未明示处决策**:
  - 注入机制选 CLI 参数（而非自动/隐式注入）：与"显式性保证"（§5.2.9）一致；管理器命令包装（§9.1 command 别名）在 M7 解析命令时按需携带 `--inject fs,http`。
  - 内置能力对象**精选包装**而非裸导 Node 模块（裸 `fs.readFileSync` 返回 Buffer 不属四类；包装统一转 string/bool/Array）。
  - `http` 能力用 `spawnSync` 调用 `curl` 实现**同步下载**（NS 无异步、Node 无同步 http 标准库）；curl 缺失或网络失败抛异常可捕获。
- **入口守卫调整**: main() 执行条件从「存在 `process.argv`」收紧为「`require.main === module`」——require 加载场景不再误触发 CLI（此前 `require` 会报"用法"错误退出），浏览器（无 require）不受影响。
- **验证**: `tests/node_inject_tests.js`（7 项：require 返回 NSI/globalThis 同引用/不触发 CLI、require 链路注入+run、`--inject fs` 全链路（写/读/查/列目录/join/cwd/异常捕获）、不含 http 正常、未知能力报错退出、与 cmdargs `--` 分隔符互不干扰），全过；14 项 js_global_tests（vm 沙箱）+ 26 项回归 + module-test 均一致。
