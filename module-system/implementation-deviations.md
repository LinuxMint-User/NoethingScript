# 实现与设计偏差记录 (Implementation vs Design)

> 关联设计: `module-system/design.md`（v0.9）
> 关联实现: `noethingScript-Interpreter.ts`（2.7.4 + 模块系统 M1–M7，含模块管理器 nsm）
> 用途: 专门记录解释器实现过程中**与设计稿的实际偏差**、**设计未明示处的实现决策**、以及**已达成确认/待办**的状态核对。
> 维护规则: 每完成一个新里程碑或设计稿修订，回到本文档增补/更新对应条目；已达成项标注状态，不删除（保留决策历史）。

## 状态速览

| # | 条目 | 类型 | 状态 |
|---|---|---|---|
| 1 | 加载完成后**不释放**模块源码 | 有意偏差（§7.5 注意点②） | 保持 |
| 2 | cmdargs 匿名填充跳过 bool 参数 | 设计未明示处的实现决策（§5.2.4） | 保持 |
| 3 | 模块内 cmdargs 语法错误仍报错 | 设计范围解读（§5.2.2） | 保持 |
| 4 | 加载期仅消费 `manifest.package`/`modules` | 部分实现（§7.3/§9.1，其余字段服务 M7） | 完成（消费方=nsm，解释器加载期仍只读 package/modules） |
| 5 | design.md v0.9「cmdargs 未实现」注记过时 | 文档状态过时 | 待更新设计稿 |
| 6 | 点分调用无行解释器回退 | 已达成确认（非偏差） | — |
| 7 | 模块调用性能实测 | 验证结果（非偏差） | — |
| 8 | M7 模块管理器 | 已实现（§9.1, 2026-08-16） | 完成 |
| 9 | input() 不支持 cast 类型（普通变量无 cast 类型） | 设计未实现（§5.2.5） | 保持（doc.md 已按实现修正） |
| 10 | registerGlobal JS 能力注入（§6） | 已实现（M7 前置, 2026-08-16） | 完成 |
| 11 | Node/CLI 注入入口（`--inject` + require NSI） | 已实现（M7 前置, 2026-08-16） | 完成 |
| 12 | try/endtry 局部清理按 `varStart` 截断 + nsm §9.1 细节规格补齐 | 实现决策/修复（2026-08-16） | 完成 |
| 13 | 本地模拟远程仓库实测 + NSVM/解析器 4 处潜伏 bug 修复 | 修复/验证（2026-08-16） | 完成 |
| 14 | 镜像自动回退（§9.1 "GitHub 主 / Gitee 镜像: 网络失败可切换"） | 实现补齐（2026-08-16） | 完成 |
| 15 | 打包工具 nsmp（§9.1 M7 独立包） | 已实现（2026-08-16） | 完成 |
| 16 | 解释器自更新（§9.1 "解释器本体自己负责更新"） | 已实现（2026-08-16） | 完成 |
| 17 | 自更新镜像写死 + `--upgrade-repo` 本次覆盖 | 设计未明示处的实现决策（2026-08-16） | 保持 |
| 18 | 官方模块仓库建立（GitHub `LinuxMint-User/NoethingScriptModules`）+ nsm 内置默认镜像指向真实仓库 | 实现补齐（2026-08-16） | 完成 |

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
- **实现**（`moduleLocate` inner 分支）: 解释器加载期只读 `package`（包根校验）与 `modules`（inner 模块存在性校验）；`version`/`ns`/`source`/`command`/`description` 加载期无消费者——按设计分工这些字段服务**模块管理器（M7）与打包工具 nsmp**。
- **状态**: **M7（nsm）已完成消费**——`version`/`ns`/`source` 经 `fs.readJsonField` 读取（适配检查/来源安全/版本比对），`command` 经命令包装别名解析消费，`description` 仅 search 展示备选；**解释器加载期仍只读 package/modules**（M7 在 NS 层经注入能力读 manifest，不经解释器加载期，分工维持）。加载期读 manifest 走同一 loader、不进源码缓存（`readModuleSource(name, false)`，避免与模块源码命名空间冲突）。

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

## 8. M7 模块管理器（已实现，§9.1）

- **设计**: §6 JS 能力分层 + §9.1 模块管理器（已完整定稿）：NS 逻辑 + `registerGlobal` 注入 fs/http + cmdargs 接收子命令（install/update/upgrade/check-update/check-upgrade/refresh/list/search/remove）、仓库 manifest 清单、http 按路径压缩包拉取、DNF 式缓存（TTL 7 天）、包内 manifest 读取 + 本地压缩包安装、命令包装；打包工具 `nsmp` 为独立包。
- **实现**（2026-08-16，`modules/main/nsm/nsm/nsm.ns`）: 单入口 + cmdargs 子命令全量实现（见 CHANGELOG 2.7.4）；**§9.1 细节规格已补齐**——本地压缩包带来源/@版本报错、`update` 无参=全部安全更新、`upgrade` 跨适配段含确认（--force 跳过）、check 系列默认强制刷新清单、search 清单缓存过期自动重拉（详见 #12）；实跑验证：网络命令正确走 404 预期路径（NSModules 仓库未建）、本地命令全流程通过（含交互确认 y/n、--force、custom 安装与卸载）。
- **未做（设计稿明确的独立项）**: 解释器本体自更（`ns --check-upgrade`，Node 原生网络，管理器不管解释器）。
- **已做（原"未做"清单项，2026-08-16）**: 打包工具 `nsmp` 独立包已完成（扫描包目录自动生成 manifest/打包，见 #15）。
- **连带待办**: 浏览器端模块加载注入 API（`setModuleLoader`/`setModuleDir`/`setCurrentFilePath`）已实现但无真实浏览器模块示例验证；模块示例库仅 tools/stack 两个，队列/集合示例未写（M8）。

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

## 12. try/endtry 局部清理按 varStart 截断 + nsm §9.1 细节规格补齐（修复/实现决策，2026-08-16）

- **解释器修复（executeEndTry）**: 旧清理 `LOCAL_VARS.filter(v => !(v.startLine >= try起始行 && !v.isGlobal))` 会误删**外层函数帧变量**——其声明行号可能 ≥ try 起始行（如 nsm `refresh main`：fetchCatalog 内 try 起始行 354，外层 cmdRefresh 帧的 `target`/`ok`/`r` 声明行号 891+，被一并清除，返回后 `return ok` 报 `未定义的变量 target`）。修复：try 帧记录入口 `LOCAL_VARS.length`（`varStart` 字段），endtry 截断到该位置（仅清 try 块内声明的局部变量 + catch 异常变量，二者均在 try 入口后压栈），保留外层帧变量；无 varStart 的旧帧回退原过滤。附带收益：异常跨帧传播时，try 入口后压栈的嵌套函数帧残留变量也被截断清理。
- **nsm §9.1 细节规格补齐**（对照设计稿命令表，详见 #8）:
  1. `install <本地压缩包路径>` 带来源/@版本 → 报错（来源由包内 manifest 决定，两语义分离）；
  2. `update` 无参 = **全部模块**安全更新（旧实现只提示"执行 upgrade"）；
  3. `upgrade` 跨适配段升级 → **确认**（--force 跳过；确认后安装时跳过适配检查，来源安全校验不受影响——`installPkgRemote` 的 force 语义仅在已确认的 upgrade 路径内放宽）；
  4. `check-update`/`check-upgrade` 默认**强制刷新** main/extra 清单；
  5. `search` 清单缓存**过期自动重拉**（`loadCatalog` 拆分 `loadCatalogCache`，超 TTL 自动 fetchCatalog，失败回退旧缓存并提示）。
- **验证**: 本地 zip+来源报错、update 无参全量、check 强制刷新、upgrade --force 跨适配均实测通过（NSModules 仓库未建，网络命令走 404 预期路径）；26 项回归 + 14 项 js_global + 7 项 node_inject 全过。

## 13. 本地模拟远程仓库实测 + NSVM/解析器 4 处潜伏 bug 修复（修复/验证，2026-08-16）

**本地模拟远程仓库**（验证 §9.1 远程能力）: 用 `python3 -m http.server` 架本地 HTTP 仓库（`/tmp/nsrepo`，目录结构按 §9.1：`catalog/{源}.manifest.json` + `packages/{包}@{版本}-v{适配}.zip`），nsm 用 `--repo http://127.0.0.1:8765` 覆盖默认基址指向本地——**实测全链路**：refresh main/extra、install hello（含依赖 greet 递归自动装）、install extratest from extra、真实压缩包本地 zip 安装（custom，来源校验 + --force）、use 已装模块真实可运行（`use hello` 输出"你好, 世界!"、`use extratest from extra`、`use greet from custom` 均验证）、update 安全更新（greet 0.1.0→0.2.0）、upgrade 跨适配段（hello→ns 3.0，含确认 y/n 与 --force）、check-update/check-upgrade 强制刷新、remove（确认/取消 + 孤立标记变化）、list 孤立检测。测试产物已全部清理。

**修复 1 — NSVM 编译期 else-if 链**（[classifyLine/NSVM 编译器](file:///run/media/echan/DATA/项目/JavaScript Projects/NoethingScript/noethingScript-Interpreter.ts#L9440-9473)）: `classifyLine` 把 `else if (cond)` 归为 `StmtType.ELSE` 且 params 保留 `"if (cond)"`；行解释器 `executeElse` 正确处理条件，但 NSVM 编译器 ELSE 分支忽略条件、把 else-if 当无条件 else 编译 → 链中段分支失效。修复：ELSE 分支识别 `^if\s*\((.*)\)$` 模式压「链帧」（`chain: true`，NSVMStruct 接口新增字段）发射独立 JZ，ENDIF 循环回填链上所有帧。

**修复 2 — NSVM break/continue 直跳不弹循环帧**（[RET/RETV 处理](file:///run/media/echan/DATA/项目/JavaScript Projects/NoethingScript/noethingScript-Interpreter.ts#L10019-10040)）: `break`/`continue` 编译为 JMP 直跳，不复刻行解释器 `executeBreak`/`executeContinue` 弹 while/for 帧的语义 → 残留循环帧阻塞函数返回（`executeFunctionEndTag` 要求栈顶为 function 帧）。修复：函数返回前清理本函数帧之上残留的控制流帧。**两者复合是之前"mut 数组实参致全部命令报未知命令/未知的函数闭合标记"的根因链**（nsm 脚本经绕行消除 mut 数组实参后该组合不再触发，此处一并根治）。

**修复 3 — parseValue 把拼接表达式误判为字符串字面量**（[parseValue](file:///run/media/echan/DATA/项目/JavaScript Projects/NoethingScript/noethingScript-Interpreter.ts#L3216-3226)）: 实参 `"跨适配段升级 " + INST_PKG[i] + " 继续?"` 以引号开头和结尾，`parseValue` 未校验引号计数即按字符串字面量剥首尾引号 → **静默得到错误值** `跨适配段升级 " + INST_PKG[i] + " 继续?`（行解释器 executeCall 与 NSVM CALLFUNC 共用此函数，双双中招，upgrade 确认提示打印源码）。修复：字符串分支加引号计数校验（`quoteCount === 2` 才算字面量），拼接表达式落入后续分支明确报 `value_unresolvable`（不静默给错值）。NS 语言语义：**call 实参仅字面量/变量/数组元素**（设计稿未明示、两解释器一致的既有约束），nsm.ns 的 confirm 调用改为先拼局部变量再传。

**修复 4 — nsm 远程安装目标父目录不存在**（[installPkgRemote](file:///run/media/echan/DATA/项目/JavaScript Projects/NoethingScript/modules/main/nsm/nsm/nsm.ns#L584-599)）: `fs.rename` 不创建父目录，extra/custom 来源首次安装时 `modules/extra/` 等目录不存在 → ENOENT。修复：rename 前对 `MOD/{src}` 目标父目录 `fs.mkdir`。

**附带**: nsm `update` 汇总 `"已更新 " + updated + " 个模块"` 的 int 拼接报类型错误，改 `str(updated)`。fs.mtime 返回浮点 `mtimeMs` 而 NS int 拒收小数，取整 `Math.floor`（上轮遗漏记录）。

## 14. 镜像自动回退（实现补齐，§9.1 "GitHub 主 / Gitee 镜像: 网络失败可切换"，2026-08-16）

初版仅实现"基址可配置"（`--repo` 手动切单基址），未实现"网络失败可切换"的自动回退语义——用户指出后补齐：`REPO` 升级为镜像列表 `MIRROR[4]` + `MIRR_CNT`（无字典，平行数组；默认 `https://raw.githubusercontent.com/NoethingScript/NSModules/main` 主 + `https://gitee.com/NoethingScript/NSModules/raw/main` 镜像，均占位——NSModules 仓库未建）；`--repo` 支持**逗号分隔多基址**（`splitMirrors` 手写拆分，上限 4 截断），单基址则只用它（显式指定不自动回退）；新函数 `downloadRetry(rel, dest)` 统一驱动清单/zip 拉取：按序 try `http.download`，失败打印"镜像不可达, 尝试下一个"并切下一镜像，全部失败才报错；成功后 `LAST_URL` 记录实际来源供 `[信息] 已刷新/下载 <- URL` 打印；`fetchCatalog`/`installPkgRemote` 两处调用点替换。**偏差说明**: 设计稿"URL 结构相同"在 GitHub raw 与 Gitee raw 两平台下前缀格式不同（`raw.githubusercontent.com/{owner}/{repo}/{branch}` vs `gitee.com/{owner}/{repo}/raw/{branch}`），实现以"**基址 + 相对路径**"抽象屏蔽差异（相对路径 `{来源}/...` 结构相同），基址按平台定。**补充（同日）**: 镜像列表支持持久配置 `{MOD}/.nsm-mirrors.json`（JSON 对象 `mirrors` 数组字段，`fs.readJsonArray` 读取，上限 4 截断；NS 无法写 JSON——字符串字面量不转义，配置文件由用户手动编辑、nsm 只读；缺失/解析失败/为空回退内置默认并打提示；加载优先级 `--repo` > 配置文件 > 内置默认），新增 `repos` 命令显示生效镜像；配套修复 nsmp 默认适配段 bug（解释器版本"前两段"误取第一段）。实测：坏基址+好基址 refresh/install 均回退成功且安装模块可用，全坏依次尝试后报错，单基址不显示尝试提示；25 项回归全过。

## 15. 打包工具 nsmp（已实现，§9.1 M7 独立包，2026-08-16）

`modules/main/nsmp/`（manifest 声明命令 `nsmp`，命令别名经解释器解析并自动注入 fs）。`nsmp -- pack <包目录> [--version/--source/--ns/--command/--desc/--out] [--force|-y]`：包名=目录名（`baseName` 手写）；modules=扫 `{子目录}/{子目录}.ns` 集合；version/source/command/description/ns 参数优先 → 复用已有 manifest → 默认值（version 0.1.0 / source main / ns 解释器版本前两段）；打 zip `{包名}@{版本}-v{适配}.zip`（fs 注入补 `zip`——spawnSync zip 同步打包目录自身，zip 内顶层=目录 basename，兼容 nsm install 的 `{tmp}/{pkg}/manifest` 定位，与 unzip 对称）。**偏差说明（重要）**: 设计稿"扫描自动生成 manifest"在实现上 JSON 组装无法在 NS 侧完成——**NS 字符串字面量不转义、引号字符（`"`）无法用任何字面量表达**（`"\"` 实际是反斜杠字符，`String.replace` 也无法生成引号，NS 值模型下含引号的字符串仅能来自外部注入如 fs 能力返回值/命令行参数），故 fs 注入补专用能力 `writeManifest(p, pkg, ver, nsv, src, dsc, mods, nMods, cmds, nCmds)`（TS 侧 `JSON.stringify` 组装固定结构 manifest，description/command 空则省略字段），NS 侧直接调用（与 readJsonField 同类的专用能力先例）。实测闭环：nsmp 打包 nsm/nsmp 自身 → nsm 安装产物（--force 过来源校验，source=main 按 custom 装）→ 命令别名可用；`--modules /tmp/modtest` 验证产物结构/命令别名兼容；25 项回归全过。**扩展（同日）**: `nsmp -- gen-catalog <packages目录> [--source 源] [--out 目录]`——扫描目录下全部 `*.zip`，逐个解压读包内 manifest（`package`/`version`/`ns`/`source`，zip 内顶层目录=包名，解压到 `.cat-tmp` 后清理）汇总生成 `catalog/{源}.manifest.json`；JSON 组装同样由能力代做（fs 注入补 `writeCatalog(p, pkgs, vers, nss, zips, n)`，按包名字典序排序保证清单稳定 diff）；`--source` 缺省 `main`；包内 `manifest.source` 与目标源不一致告警（nsm 安装校验将拒绝）；覆盖输出文件需确认（-y 跳过）。实测：3 个 main 包 + 1 个 extra 包混合目录 → main 清单警告 1 项、extra 清单警告 3 项均正确；生成的 main 清单经本地 http.server 验证 refresh/install/search 全链路可用。

## 16. 解释器自更新（已实现，§9.1 "解释器本体自己负责更新"，2026-08-16）

设计稿 §9.1: 解释器本体自己负责更新（`ns --check-upgrade` / `--upgrade`），管理器不管解释器、upgrade 只管模块。实现（[自更新函数族](file:///run/media/echan/DATA/项目/JavaScript Projects/NoethingScript/noethingScript-Interpreter.ts#L8682-8859)）: CLI 新增 `--check-upgrade`（只检查报告、无副作用）与 `--upgrade`（完整更新: 检查远程版本 → 确认（`--force` 跳过）→ 备份本地 ts 为 `.upgrade-bak` → 镜像回退下载最新 `noethingScript-Interpreter.ts` + `package.json` → `npx tsc` 重编译 → 验证产物版本）。任一步失败（全部镜像不可达/下载失败/编译失败）自动恢复备份回滚；需在项目根目录运行（须存在 ts 与 package.json），不在根目录报错退出；升级成功提示保留备份供验证后删除并建议 git 提交；文件级 require 补 `cpUpgrade`（`child_process`，curl/npx/tsc 子进程调用）。**偏差说明**: 官方仓库镜像写死为 `DEFAULT_UPGRADE_MIRRORS`（GitHub raw 主 + Gitee raw 镜像按序回退，对应官方仓库 `LinuxMint-User/NoethingScript` / `epix-xhan/NoethingScript` 的 raw 基址；与 nsm 的镜像列表不同——nsm 走持久配置 `.nsm-mirrors.json`，自更新按用户要求直接写死）；保留可选 `--upgrade-repo <基址[,基址...]>` 覆盖默认镜像（仅本次，测试/换仓用）。**验证**: 本地 HTTP 仓库模拟实测全链路——check 发现新版本、upgrade 确认 y 成功升级（2.7.4→2.8.0 产物版本验证 + 备份生成）、取消 n 不动、`--force` 跳过确认、坏基址+好基址镜像回退成功、全镜像不可达报错退出 1、已是最新提示无需更新、坏源码编译失败自动恢复备份回滚、非项目根目录报错。

## 17. 自更新镜像写死 + `--upgrade-repo` 本次覆盖（设计未明示处的实现决策，2026-08-16）

- **设计**: §9.1 仅规定"解释器本体自己负责更新"，未明示更新源的配置方式。
- **实现**: 用户明确"不要可配置了吧？直接写死吧"——默认镜像写死 TS 常量 `DEFAULT_UPGRADE_MIRRORS`（GitHub 主 + Gitee 镜像），**但保留可选 `--upgrade-repo <基址[,基址...]>` 覆盖（仅本次运行，不持久化）**，兼顾"写死"与"测试/换仓"两类需求。
- **依据**: 与 nsm 的持久配置 `.nsm-mirrors.json` 形成对比——模块仓库需要用户自托管（持久配置合理），解释器官方仓库固定（写死合理）；`--upgrade-repo` 仅本次是"写死 + 逃生口"的平衡，不引入配置文件，不污染模块目录。
- **验证**: 本地 http.server 模拟仓库 + `--upgrade-repo http://127.0.0.1:8765` 全链路实测通过（见 #16）。

## 18. 官方模块仓库建立（§9.1 "官方仓库建立" 未完成项做掉，2026-08-16）

设计稿 §9.1 遗留的"官方仓库建立"（M1–M7 完成后剩 3 项未完成之一）已完成: GitHub 建官方模块仓库 `LinuxMint-User/NoethingScriptModules`（main 分支，用户提供），初始 4 个包——`nsm`/`nsmp`/`stack`/`tools`（`modules/main/` 现有包全量；queue/set 示例模块为 M8 剩余项，待补后再打包发布）。仓库结构遵循 [self-host-repo-guide.md](self-host-repo-guide.md): `catalog/main.manifest.json`（nsmp gen-catalog 自动生成，4 条目按包名排序）+ `packages/` 4 个 zip（nsmp pack 生成，zip 内顶层目录=包名含 manifest）。**nsm 内置默认镜像同步从占位 `NoethingScript/NSModules` 改为真实 `https://raw.githubusercontent.com/LinuxMint-User/NoethingScriptModules/main`**（initConfig 内置默认分支 MIRR_CNT=1；Gitee 镜像待建，建成后在 `.nsm-mirrors.json` 追加，机制不变）。**偏差/实现说明**:
1. 仓库目录独立于解释器项目：因沙箱限制父目录不可写，模块仓库放在项目下 `NoethingScriptModules/`（独立 git 仓库，解释器 `.gitignore` 排除）；
2. `--out` 相对路径与 zip 打包 `cwd`（打包目录父目录）错位 → nsmp pack 的 `--out` 用绝对路径（zip 写入以打包目录为基准的相对路径所致）；这是 `--out` 相对路径下的已知行为，未改代码（用绝对路径即可）；
3. 本地打包时 nsmp 会重写 `modules/main/*/manifest` 的 description（参数 `--desc` 优先，无参数复用已有）——本次顺手完善了 4 个包的 description，便于 search 展示；
4. 实测链路：本地 http.server 模拟仓库 → refresh/install/依赖递归（tools→stack）全部正常；推 GitHub 后真实 remote 验证：`nsm -- repos` 显示生效镜像为 GitHub raw 主镜像，`refresh main`/`install stack`/`install tools` 从 GitHub raw 真实拉取成功。**用户当前 `git push` 网络不稳**，本次推送用 `timeout 120 + GIT_HTTP_LOW_SPEED_LIMIT/TIME` 包装成功。
