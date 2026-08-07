
// 解释器版本
const NSIVersion: string = "2.7.1";
// console.log("NSI Version: " + NSIVersion);

// Debug级别变量
var DEBUG_LEVEL: number = 0; // 默认不输出debug信息

// 命令行是否显式指定 --debug: 命令行优先级最高, 覆盖脚本内 debug 指令
var CLI_DEBUG_SET: boolean = false;

// 自定义运行时输入处理器 (优先级最高): 由 NSI.setInput() 设置, 未设置时回退到默认 (Node 读 stdin / 浏览器 prompt)
var INPUT_HANDLER: (() => string) | null = null;

// ===== 浏览器交互执行 (input 挂起/恢复) =====
// 交互模式下脚本自持主流程: 执行到 input() 且无可用输入时挂起 (抛信号交还控制权),
// 宿主通过 NSI.resumeInput(value) 提供输入后从挂起点继续执行。
var INPUT_INTERACTIVE_MODE: boolean = false;    // 交互模式开关 (NSI.runInteractive 开启)
var INPUT_ON_REQUEST: (() => void) | null = null; // 挂起时通知宿主 (如刷新"等待输入"提示)
var INPUT_PRELOAD: string[] = [];               // 恢复时预取的输入值队列
var INPUT_SUSPENDED: boolean = false;           // 当前是否处于挂起等待输入状态
// 挂起信号: 带 type 字段以便穿透解释器各层 catch (该 type 不属于 ExceptionType, 不会被当作脚本异常)
const INPUT_SUSPEND_SIGNAL: any = { type: '__INPUT_SUSPEND__' };
function isInputSuspend(e: any): boolean {
    return !!e && e.type === '__INPUT_SUSPEND__';
}

// 自定义debug日志函数
// 惰性参数: 调用点可将字符串模板等重代价表达式包成 0 参函数 (如 debugLog(2, () => `...${x}...`)),
// 仅在 DEBUG_LEVEL 达标需要输出时才求值, 避免无条件构造模板字符串 / 调用 Object.keys 等开销。
// 编译期静默标志: NSVM 编译期间的表达式预解析 (SETARRAY 探测) 禁止输出调试日志。
// 编译期解析发生在运行期 debug 级别已生效之后, 且行指针非目标行, 输出会污染调试结果 (与行解释器
// 在语句执行时刻输出解析日志的时机不符); 探测仅判定结构, 不产生任何对外可见输出。
var silentCompileParse = false;

function debugLog(level: number, ...args: any[]): void {
    if (DEBUG_LEVEL >= level) {
        if (silentCompileParse) return;
        const lineInfo = typeof currentLinePointer !== 'undefined'
            ? ` [Line ${currentLinePointer + 1}]`
            : '';
        const resolved = args.map(a => (typeof a === 'function' ? a() : a));

        console.log(`[DEBUG ${level}]${lineInfo}`, ...resolved);
    }
}

// 关键字
const keywords = ['global', 'local', 'number', 'int', 'float', 'string', 'bool', 'array', 'true', 'false',
    'const', 'if', 'else', 'endif', 'for', 'endfor',
    'while', 'endwhl', 'switch', 'case', 'default', 'endswc',
    'break', 'continue', 'return', 'assert', 'endasrt', 'try',
    'catch', 'endtry', 'Exception', 'null', 'undefined', 'void',
    'jump', 'arrfill', 'purge', 'all', 'except',
    'call', 'print', 'debug', 'mut', 'copy'
];

// 全局变量存储
var GLOBAL_VARS: { [key: string]: Variable } = {};

// 局部变量存储
var LOCAL_VARS: Variable[] = [];

// ========== 槽位映射 (静态符号表 + 运行时槽位索引) ==========
// 局部变量的"声明"在程序加载时静态登记为槽位 (帧内序号), 热路径变量访问由
// "按名线性扫描" 变为 "按槽位 O(1) 下标", 语义 (遮蔽/递归帧隔离/行号作用域) 在静态建表时解析。
interface SlotDecl {
    name: string;
    startLine: number;   // 声明行 (0基)
    endLine: number;     // 作用域结束行 (0基, 含)
    type: DataType;
    isConst: boolean;
    isArray: boolean;
    frameKey: string;    // 'top' (顶层/函数外块) 或 'f:<函数名>:<函数定义行>' (函数调用帧)
    slot: number;        // 帧内槽位号
}
var SLOT_DECLS: SlotDecl[] = [];                      // 全部局部声明 (静态)
var SLOT_BY_NAME: Map<string, SlotDecl[]> = new Map();// name → 声明列表 (按登记顺序)
// 运行时槽位索引: 帧键 → 槽位 → Variable 对象。
// 帧键: 'top' (顶层局部) 或 函数调用帧ID (数字, 字符串化)。由 rebuildSlotIndex() 从 LOCAL_VARS 重建。
var SLOT_INDEX: { [frameKey: string]: { [slot: number]: Variable } } = {};
// 程序指纹: 每次 loadProgram 递增。表达式树缓存按程序隔离 (树节点携带静态槽位绑定, 跨程序不可共享)。
var PROGRAM_ID: number = 0;

// 按 (名字, 行号) 静态解析引用点的槽位绑定 (区间包含该行且声明行最晚者)
function lookupSlotBinding(name: string, line: number): { frameKey: string; slot: number } | null {
    const list = SLOT_BY_NAME.get(name);
    if (!list) return null;
    let best: SlotDecl | null = null;
    for (let i = 0; i < list.length; i++) {
        const d = list[i];
        if (line >= d.startLine && (line <= d.endLine || d.endLine === -1)) {
            if (!best || d.startLine > best.startLine) best = d;
        }
    }
    return best ? { frameKey: best.frameKey, slot: best.slot } : null;
}

// 按 (名字, 声明行, 结束行) 精确匹配声明 (rebuild 槽位索引用)
function findSlotDecl(name: string, startLine: number, endLine: number): SlotDecl | null {
    const list = SLOT_BY_NAME.get(name);
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) {
        const d = list[i];
        if (d.startLine === startLine && d.endLine === endLine) return d;
    }
    return null;
}

// 登记单个局部变量到槽位索引 (增量形式; 用于"新增变量批次"已知且低频重建的热点场景, 如函数调用参数绑定)
function indexSlotVar(v: Variable): void {
    let d = findSlotDecl(v.name, v.startLine, v.endLine);
    // 兜底: 运行时作用域区间与静态表有细微偏差时按行号区间宽松匹配
    if (!d) {
        const bind = lookupSlotBinding(v.name, v.startLine);
        if (bind) d = findSlotDeclByKey(v.name, bind.frameKey, bind.slot);
    }
    if (!d) return;
    const key: string = d.frameKey === 'top' ? 'top' : (v.frameId === undefined ? 'top' : String(v.frameId));
    const m = SLOT_INDEX[key] || (SLOT_INDEX[key] = {});
    m[d.slot] = v;
}

// 从 LOCAL_VARS 重建运行时槽位索引 (所有 LOCAL_VARS 变更点调用; 非热路径, 低频)
function rebuildSlotIndex(): void {
    SLOT_INDEX = {};
    for (let i = 0; i < LOCAL_VARS.length; i++) {
        indexSlotVar(LOCAL_VARS[i]);
    }
}

function findSlotDeclByKey(name: string, frameKey: string, slot: number): SlotDecl | null {
    const list = SLOT_BY_NAME.get(name);
    if (!list) return null;
    for (let i = list.length - 1; i >= 0; i--) {
        const d = list[i];
        if (d.frameKey === frameKey && d.slot === slot) return d;
    }
    return null;
}

// 函数作用域跟踪
var FUNCTION_SCOPES: { [name: string]: { startLine: number, endLine: number } } = {};

// 函数返回值存储池
var RETURN_VALUES: { [functionName: string]: { [variableName: string]: any } } = {};

// 标签存储
var TAGS: { [name: string]: number } = {};

// 函数储存
var FUNCTIONS: { [name: string]: FunctionInfo } = {};

// 异常处理栈
var EXCEPTION_STACK: Exception[] = [];

// 待绑定到 catch 变量的异常 (异常跳转时由主循环设置, executeCatch 消费)
var PENDING_EXCEPTION: Exception | null = null;

// 多行注释状态 (true 表示当前处于 /// 多行注释区间内)
var IN_MULTILINE_COMMENT: boolean = false;

// for 循环更新表达式正在执行的循环变量名 (用于豁免只读检查)
var FOR_UPDATE_VAR: string | null = null;

// 流程控制栈 (用于if/for/while/switch等) 
var CONTROL_FLOW_STACK: ({
    type: 'if';
} | {
    type: 'while';
    start: number;
} | {
    type: 'for';
    start: number;
    updateExpr: string;
    varName: string;
} | {
    type: 'switch';
    condition: number | string;
    hasMatched: boolean;
    inCaseBlock: false | 'case' | 'default';
} | {
    type: 'try';
    start: number;
} | {
    type: 'function';
    funcName: string;             // 函数名
    startLine: number;            // 函数起始行 (:functionName 所在行)
    endLine: number;              // 函数结束行 (:end 所在行)
    callFrom: number;             // 调用者地址 (call 指令所在行)
    returnVarName?: string;       // 接收返回值的变量名 (call ... -> resultVar 中的 resultVar)
    frameId: number;              // 本次调用帧的唯一ID (递归隔离局部变量用)
    frameVarStart: number;        // 调用时 LOCAL_VARS 长度 (返回时截断清理本帧变量, O(1) 替代 O(n) filter)
})[] = [];

// 流程控制跳过块栈 (用于for/while等)
var CONTROL_FLOW_BROKEN_BLOCK_STACK: ({
    type: 'if';
} | {
    type: 'while';
    start: number;
} | {
    type: 'for';
    start: number;
    updateExpr: string;
    varName: string;
} | {
    type: 'switch';
    condition: number | string;
    hasMatched: boolean;
    inCaseBlock: false | 'case' | 'default';
})[] = [];

// 流程控制部分
var currentLinePointer: number = 0;
var programLines: string[] = [];

// 行预处理缓存条目 (与 programLines 一一对应, 仅存静态信息; 多行注释状态为运行期状态, 不进缓存)
interface LineInfo {
    content: string;     // trim 后的行内容
    isEmpty: boolean;    // 空行
    isComment: boolean;  // 以 // 开头
    isEndTag: boolean;   // 恰为 ':end'
    stmt: LineStmt;      // 阶段1行级预编译产物 (加载期构建, 运行时数字类型分发)
}

// ===== 阶段1: 行级预编译 =====
// 语句类型 (数字枚举): 替代运行时"逐行 split + 首关键字字符串 switch" 分发。
// 与 KEYWORD_COMMANDS 一一对应, 加载期把每行分类为结构化语句, 主循环执行走数字 switch。
enum StmtType {
    OP = 0,            // 非关键字行 (赋值/表达式行) → executeOperation(整行)
    GLOBAL,            // global [const] 声明
    LOCAL,             // local [const] 声明
    CALL,              // call func(args) [-> result]
    RETURN,            // return [expr]
    JUMP,              // jump (cond):label
    PRINT,             // print expr
    IF,                // if (cond)
    ELSE,              // else
    ENDIF,             // endif
    WHILE,             // while (cond)
    ENDWHL,            // endwhl
    FOR,               // for (local ...; cond; update)
    ENDFOR,            // endfor
    BREAK,             // break
    CONTINUE,          // continue
    TRY,               // try
    CATCH,             // catch (Exception e)
    ENDTRY,            // endtry
    ASSERT,            // assert (cond)
    ENDASRT,           // endasrt
    SWITCH,            // switch (expr)
    CASE,              // case value
    DEFAULT,           // default
    ENDSWC,            // endswc
    PURGE,             // purge ...
    END_TAG,           // :end
    CONST_PREFIX_ERROR // const global/local 位置错误 (语法错误, 与旧 executeCommand 前置检查一致)
}

// 结构化行对象: 预解析的关键字类型 + 预拼接的参数串 (参数与旧 split(/\s+/).slice(1).join(' ') 完全一致)
interface LineStmt {
    type: StmtType;
    params: string;    // 关键字行参数 (首关键字之后); 非参数类语句为空串
}

// 行预处理缓存: loadProgram 时构建一次, 主循环运行时直接读, 避免每行重复 trim/判断。
// 注意: 与 programLines 严格一一对应, 不删行不改索引, 标签/函数作用域/变量作用域/错误行号语义完全不变。
var LINE_INFO: LineInfo[] = [];

// 函数调用帧计数器 (每次 call 分配唯一 ID, 用于递归隔离各帧局部变量)
var CALL_FRAME_ID: number = 0;

// 数据类型定义
enum DataType {
    NUMBER = 'number',
    INT = 'int',
    FLOAT = 'float',
    STRING = 'string',
    BOOL = 'bool',
    ARRAY = 'array',
    UNDEFINED = 'undefined'
}

// 数组元素接口定义
interface ArrayElement {
    value: any;
    type: DataType;
}

// 变量接口定义
interface Variable {
    name: string;
    value: any;
    type: DataType;
    isGlobal: boolean;
    isConst: boolean;  // 是否为常量
    startLine: number;
    endLine: number;
    frameId?: number;  // 所属函数调用帧ID (用于递归时隔离不同调用帧的局部变量)
    // 数组特有属性
    arrayLength?: number;
    arrayElementType?: DataType;
    arrayElements?: ArrayElement[];
    isReadonlyArray?: boolean;  // 数组只读引用视图 (只读形参), 透过该视图禁止写数组元素
}

// 函数形参接口定义
interface FunctionParameter {
    name: string;
    type: DataType;
    isMutable?: boolean;  // 是否为可变引用参数 (mut 关键字前置, 仅数组有效)
    arrayElementType?: DataType;  // 数组形参元素类型 (arr[]:int 中的 int)
}

// 函数信息接口定义
interface FunctionInfo {
    name: string;
    params: FunctionParameter[];
    returnType: DataType;
    startLine: number;
    endLine: number;
    // 返回值变量名 (函数解析时缓存, 供 executeReturn/结果赋值热路径免重复解析函数定义行)
    returnVarName?: string;
    returnArrayElementType?: DataType;  // 数组返回值元素类型 (-> st[]:int 中的 int)
    // hasReturnStatement: boolean; // 目前弃用的属性

}

// 异常类型定义
enum ExceptionType {
    SYNTAX_ERROR = 'SyntaxError',
    TYPE_ERROR = 'TypeError',
    REFERENCE_ERROR = 'ReferenceError',
    RANGE_ERROR = 'RangeError',
    ASSERTION_ERROR = 'AssertionError',
    TRY_BLOCK = 'TryBlock',
    CATCH_BLOCK = 'CatchBlock',
    UNKNOWN_ERROR = 'UnknownError',
    LOOP_INIT_ERROR = 'LoopInitError',
    LOOP_UPDATE_ERROR = 'LoopUpdateError'
}

// 错误编号映射 (与 ExceptionType 一一对应, 仅用于统一错误输出)
const ERROR_CODES: { [key in ExceptionType]: number } = {
    [ExceptionType.SYNTAX_ERROR]: 1,
    [ExceptionType.TYPE_ERROR]: 2,
    [ExceptionType.REFERENCE_ERROR]: 3,
    [ExceptionType.RANGE_ERROR]: 4,
    [ExceptionType.ASSERTION_ERROR]: 5,
    [ExceptionType.UNKNOWN_ERROR]: 6,
    [ExceptionType.LOOP_INIT_ERROR]: 7,
    [ExceptionType.LOOP_UPDATE_ERROR]: 8,
    [ExceptionType.TRY_BLOCK]: 9,
    [ExceptionType.CATCH_BLOCK]: 10
};

// 错误类型中文名 (用于统一错误输出)
const ERROR_NAMES: { [key in ExceptionType]: string } = {
    [ExceptionType.SYNTAX_ERROR]: '语法错误',
    [ExceptionType.TYPE_ERROR]: '类型错误',
    [ExceptionType.REFERENCE_ERROR]: '引用错误',
    [ExceptionType.RANGE_ERROR]: '范围错误',
    [ExceptionType.ASSERTION_ERROR]: '断言错误',
    [ExceptionType.UNKNOWN_ERROR]: '其他错误',
    [ExceptionType.LOOP_INIT_ERROR]: '循环初始化错误',
    [ExceptionType.LOOP_UPDATE_ERROR]: '循环更新错误',
    [ExceptionType.TRY_BLOCK]: 'Try块',
    [ExceptionType.CATCH_BLOCK]: 'Catch块'
};

// ========== 国际化 (i18n) ==========
// 当前输出语言: 'zh' (中文, 默认) 或 'en' (英文)。通过命令行 --lang en|zh 切换。
var LANG: 'zh' | 'en' = 'zh';

// 错误类型英文名 (英文输出时使用, 与中文 ERROR_NAMES 对应)
const ERROR_NAMES_EN: { [key in ExceptionType]: string } = {
    [ExceptionType.SYNTAX_ERROR]: 'SyntaxError',
    [ExceptionType.TYPE_ERROR]: 'TypeError',
    [ExceptionType.REFERENCE_ERROR]: 'ReferenceError',
    [ExceptionType.RANGE_ERROR]: 'RangeError',
    [ExceptionType.ASSERTION_ERROR]: 'AssertionError',
    [ExceptionType.UNKNOWN_ERROR]: 'Error',
    [ExceptionType.LOOP_INIT_ERROR]: 'LoopInitError',
    [ExceptionType.LOOP_UPDATE_ERROR]: 'LoopUpdateError',
    [ExceptionType.TRY_BLOCK]: 'TryBlock',
    [ExceptionType.CATCH_BLOCK]: 'CatchBlock'
};

// 语言包: 消息模板键 → 各语言文本。占位符使用 {name} 形式, 由 t() 填充。
// 新增语言时只需在此增加一个语言包条目 (l10n 友好), 无需改动业务代码。
const LANG_PACKS: { [lang: string]: { [key: string]: string } } = {
    zh: {
        // 错误/警告/提示消息的简体中文文案 (占位符 {name} 由 t() 替换)
        cli_usage: '用法: node noethingScript-Interpreter.js <文件名>',
        cli_no_debug_level: '未指定调试参数等级, 初始化默认为 0',
        cli_invalid_lang: '无效的语言参数, 仅支持 en 或 zh, 已保持默认中文',
        cli_unknown_args: '未知参数: {args} (以 - 开头的参数仅支持 --debug/--lang/--help/--version, 不支持短参数 (如 -h), 使用 --help 查看用法)',
        cli_cannot_read: '[错误] 无法读取文件 \'{filename}\': {error}',
        cli_node_required: '[错误] 此脚本需要在Node.js环境中运行以支持文件读取',
        internal_error: '[内部错误] [行 {line}] 解释器内部发生错误: {message}',
        internal_error_hint: '   这不是脚本本身的错误, 属于解释器缺陷, 请向开发者反馈',

        // ===== 脚本运行期错误/警告消息 (由 t() 填充 {name} 占位符) =====
        // 变量声明/赋值
        assign_type_mismatch: '不能将值 \'{value}\' 赋值给变量 \'{name}\', 类型为 \'{type}\'',
        name_already_defined: '名称 \'{name}\' 已被定义',
        name_defined_same_scope: '名称 \'{name}\' 在相同作用域内已被定义',
        var_declared_uninitialized: '变量 \'{name}\' 声明但未初始化',
        const_assignment_forbidden: '不能将常量 \'{name}\' 赋值',
        var_undefined: '变量 \'{name}\' 未定义',
        var_decl_global_local_format: '全局/局部变量声明格式应为 "[global/local] [const] 变量名:类型 = 值"',
        var_decl_global_format: '全局变量声明格式应为 "global [const] 变量名:类型 = 值"',
        var_decl_local_format: '局部变量声明格式应为 "local [const] 变量名:类型 = 值"',
        var_name_invalid: '命名错误: 变量名 \'{name}\' 不符合命名规则',
        global_var_in_block: '不可在代码块内声明全局变量',
        local_var_outside_block: '不可在代码块外声明局部变量',
        type_conversion_failed: '类型转换失败: 无法将值\'{value}\'转换为{type}类型',
        loop_var_shadow_forbidden: '循环变量 \'{name}\' 作用域内禁止声明同名变量',
        var_undefined_scope: '未定义的{scope}变量 {name}',
        var_undefined_expr_global: '未定义的全局变量 {name}',
        var_undefined_expr_local: '未定义的变量 {name}',
        expr_null_not_allowed: '表达式中出现 null 值, 不被允许',
        expr_undefined_not_allowed: '表达式中出现 undefined 值, 不被允许',
        var_value_undefined: '变量 {name} 的值为 undefined, 不能被使用',
        loop_var_readonly: '循环变量 {name} 是只读的, 禁止修改',
        // 清除 (purge)
        purge_mode_not_specified: '未指定清除模式',
        purge_scope_no_except: '作用域清除模式不支持排除方法',
        purge_target_not_specified: '未指定清除所有变量且未指定要清除的变量',
        purge_local_outside_func: '函数外不可声明局部变量, 若要清除全局变量请用global关键字',
        except_format_error: 'except关键字使用格式错误',
        except_requires_all: 'except关键字必须正确配合all关键字使用',
        except_requires_var: 'except关键字必须配合变量使用',
        except_local_only: 'except关键字仅适用于局部变量',
        // 函数定义/调用
        func_end_without_def: '函数结束标记错误: 发现函数结束标记, 但没有对应的函数定义',
        func_no_return_stmt: '函数 {name} 期望返回 {type} 类型的值, 但未找到return语句',
        func_unexpected_return: '函数 {name} 期望无返回值, 但找到return语句',
        func_nested_def: '函数定义错误: 发现函数内嵌套函数定义',
        func_name_invalid: '命名错误: 函数名 \'{name}\' 不符合命名规则 (参考C语言规则)',
        func_return_type_required: '函数返回值格式错误: 有返回值的函数必须指定返回值类型',
        func_param_format: '函数参数格式错误: 参数 {param} 格式不正确, 应为 "参数名:类型"',
        func_param_mut_array_only: '函数参数格式错误: 参数 {param}, mut 关键字仅适用于数组类型参数',
        func_param_array_need_elem_type: '函数参数格式错误: 参数 {param}, 数组形参必须声明元素类型, 格式应为 "arr[]:元素类型"',
        func_return_array_need_elem_type: '函数返回值格式错误: 数组返回值必须声明元素类型, 格式应为 "-> st[]:元素类型"',
        array_elem_type_mismatch: '数组类型不匹配: 期望 {expected} 数组, 实际是 {actual} 数组',
        func_unclosed_at_eof: '函数定义错误: 程序结束时仍有未结束的函数',
        unsupported_data_type: '不支持的数据类型: {type}',
        func_undefined: '函数 \'{name}\' 未定义',
        func_result_var_missing: '函数 {name} 有返回值, 但未指定结果变量',
        func_result_var_unexpected: '函数 {name} 无返回值, 但指定了结果变量',
        func_arg_count_insufficient: '传入函数 {name} 的参数数量过少: 期望 {expected}, 实际 {actual}',
        func_extra_args_ignored: '传入函数 {name} 的参数多于定义, 忽略多出的传入参数',
        func_array_arg_format: '函数 {name} 参数 {argIndex} 数组实参格式错误, 应为 "数组名"、"mut 数组名" 或 "copy(数组名)"',
        func_mut_param_requires_mut: '形参 {name} 声明为 mut 可变引用, 实参必须使用 mut 关键字',
        func_readonly_param_no_mut: '形参 {name} 为只读引用, 实参不能使用 mut 关键字',
        func_arg_type_error: '函数 {name} 参数 {argIndex} 类型错误',
        func_arg_count_missing: '函数 {name} 需要 {expected} 个参数, 但未提供',
        call_format: '函数调用格式应为 "call 函数名(参数1, 参数2, ...) -> 结果变量" 或 "call 函数名(参数1, 参数2, ...)"',
        // 类型/值解析
        type_mismatch_str: '类型不匹配: 期望 {expected}, 实际是字符串',
        type_mismatch_bool: '类型不匹配: 期望 {expected}, 实际是布尔值',
        type_mismatch_int: '类型不匹配: 期望整数, 实际是 {value}',
        type_mismatch_num: '类型不匹配: 期望 {expected}, 实际是数字',
        type_mismatch_var_type: '类型不匹配: 期望 {expected}, 实际是 {actual}',
        type_mismatch_expr_result: '类型不匹配: 期望 {expected}, 表达式 \'{expr}\' 求值结果类型不符',
        value_unresolvable: '无法解析值: {value}',
        init_expr_no_var_call: '声明初始化仅允许字面量表达式, 不允许使用变量或函数调用 \'{name}\' (请先声明后赋值)',
        init_literal_only: '声明初始化仅允许字面量, 不允许使用变量或函数调用 \'{expr}\' (请先声明后赋值)',
        // 数组
        array_decl_format: '数组声明格式应为 "array arrName[arrLength]:type = [...]" 或 "array arrName[arrLength]:type = arrfill"',
        array_name_invalid: '命名错误: 数组名 \'{name}\' 不符合命名规则',
        array_length_non_negative: '数组长度必须是非负整数',
        array_length_expr_unresolvable: '无法解析数组长度表达式 \'{expr}\'',
        array_element_type_unsupported: '不支持的数组元素类型 \'{type}\'',
        array_of_array_forbidden: '不允许声明数组的数组',
        array_number_fill_0: 'number类型数组统一填充为0.0, 建议明确声明为int或float类型',
        array_init_count_mismatch: '数组初始化元素数量({actual})与声明长度({expected})不匹配',
        array_element_unresolvable: '无法解析数组元素[{index}]的值 \'{value}\'',
        array_init_format: '数组初始化应使用 \'[...]\' 或 \'arrfill\'',
        local_array_outside_func: '不能在函数外部声明局部数组 \'{name}\'',
        array_literal_element_unresolvable: '数组字面量元素无法解析: {value}',
        array_literal_arg_parse_failed: '数组字面量实参解析失败 ({error})',
        arr_arg_not_array: '实参 {name} 不是数组类型',
        array_undefined: '未定义的数组: {name}',
        not_array_type: '该 {name} 不是数组类型',
        const_array_assignment: '数组 {name} 是常量数组, 不能被赋值',
        readonly_array_assignment: '数组 {name} 是只读引用, 不能被赋值',
        arr_index_out_of_range: '范围错误: 数组索引 {index} 超出范围, 数组长度为 {length}',
        array_element_type_mismatch: '数组元素类型错误: 期望 {expected} 类型, 实际 {actual}',
        const_array_whole_assignment: '常量数组 {name} 不能被整体赋值',
        readonly_array_whole_assignment: '数组 {name} 是只读引用, 不能被整体赋值',
        func_split_overflow: '{func} 结果 {count} 段超出容器容量 {capacity}',
        // return / print
        return_requires_var: 'return语句后必须跟一个变量',
        return_outside_function: '当前返回语句所在行不在函数内',
        return_stack_top_mismatch: '当前返回语句所在行不在控制流栈顶函数中',
        return_var_mismatch: 'return 只能返回函数 {funcName} 声明的返回变量 {defReturnVar}, 不能返回 {returnValue}',
        func_return_value_missing: '函数 {name} 期望返回 {type} 类型的值, 但未提供返回值',
        func_reached_end_no_return: '函数 {name} 期望返回 {type} 类型的值, 但最终执行到函数结束标记',
        return_value_name_mismatch: '函数运行时返回值与流程控制栈中的返回值名称不同',
        print_expr_failed: 'print 无法计算表达式 \'{expr}\'',
        // 条件表达式 / if / while / for
        cond_need_parentheses: '条件表达式必须用括号括起',
        cond_must_be_bool: '条件表达式必须返回布尔值, 但实际返回了 {actualType} 类型',
        cond_invalid: '无效的条件表达式: {expr}',
        for_format: 'for循环格式应为 "for (local 变量名:类型 = 初始值; 条件; 更新表达式)"',
        for_init_failed: 'for循环初始化失败',
        for_update_failed: 'for循环更新表达式执行失败',
        // break / continue
        break_outside_loop_switch: 'break语句不在循环或switch内',
        break_context_unsupported: '不支持的break上下文',
        continue_outside_loop: 'continue语句不在循环内',
        continue_context_unsupported: '不支持的continue上下文',
        matching_end_tag_not_found: '未找到匹配的{tag}',
        // try / catch
        catch_format: 'catch语句格式应为 "catch (Exception ErrorName)"',
        catch_no_try: 'catch语句没有匹配的try块',
        // assert
        assert_need_parentheses: '断言表达式必须用括号括起',
        assert_message_quoted: '断言消息必须用双引号括起',
        assert_condition_invalid: '断言条件无效: {expr}',
        // switch / case
        switch_cond_int_only: 'switch语句的条件表达式只能是int或string类型, 数字必须为整数',
        switch_cond_type: 'switch语句的条件表达式只能是int或string类型',
        switch_cond_invalid: '无效的switch条件表达式: {expr}',
        case_outside_switch: 'case语句必须在switch块内使用',
        case_type_mismatch: 'case值的类型必须与switch条件类型相同',
        case_value_invalid: '无效的case值: {expr}',
        default_outside_switch: 'default语句必须在switch块内使用',
        endswc_outside_switch: 'endswc语句必须在switch块内使用',
        // jump
        jump_format: '必须使用 jump (condition) :标签名 格式 (标签需以字母/下划线开头)',
        cond_expr_empty: '条件表达式不能为空',
        cond_expr_invalid: '条件表达式无效: {expr}',
        tag_undefined: '未定义的标签: {name}',
        // 函数闭合标记
        stray_func_end_tag: '检测到单独的的函数闭合标记',
        unknown_func_end_tag: '未知的函数闭合标记',
        // 其他
        execute_operation_failed: '无法执行操作 \'{command}\': {error}',
        // 表达式求值 (ExpressionEvaluator)
        expr_eval_error: '计算表达式时出错 \'{expr}\': {inner}',
        unexpected_token_after_parse: '意外的标记在处理令牌阶段: {token}',
        unexpected_char: '意外的字符: {char} 位置 {pos}',
        assignment_op_in_call_context: '赋值运算符应在调用上下文中处理 在 {pos} 位置',
        expr_unexpected_end: '表达式意外结束 第 {pos} 个标记',
        missing_right_paren: '缺少右括号 位置 {pos}',
        unexpected_token_primary: '意外的标记在解析基本元素阶段: {token} 位置 {pos}',
        array_index_not_number: '数组索引必须是数字类型 位置 {pos}',
        array_index_not_nonneg_int: '数组索引必须是非负整数 位置 {pos}',
        array_missing_right_bracket: '数组访问缺少右方括号: {name} 位置 {pos}',
        array_var_not_array: '变量 \'{name}\' 不是数组类型 位置 {pos}',
        array_index_out_of_range_access: '数组索引越界: 索引 {index} 超出数组 \'{name}\' 的范围 [0, {max}] 位置 {pos}',
        array_element_access_error: '数组元素访问错误: 无法访问数组 \'{name}\' 的元素 {index} 位置 {pos}',
        invalid_assignment_target: '无效的赋值目标 位置 {pos}',
        func_call_missing_right_paren: '函数调用缺少右括号: {name} 位置 {pos}',
        func_needs_1_arg: '{func} 需要 1 个参数',
        func_needs_2_args: '{func} 需要 2 个参数',
        func_needs_3_args: '{func} 需要 3 个参数',
        func_no_arg_expected: '{func} 不需要参数',
        len_only_str_or_array: 'len 只能用于字符串或数组',
        copy_arg_must_be_array: 'copy 参数必须是数组类型',
        input_unavailable: '当前环境不支持运行时输入 (input)',
        unknown_function: '未知函数: {name} 位置 {pos}',
        op_left_operand_not_number: '运算符 {op} 要求左操作数是数字类型',
        op_right_operand_not_number: '运算符 {op} 要求右操作数是数字类型',
        logic_op_left_operand_not_bool: '逻辑运算符 {op} 要求左操作数是布尔类型',
        logic_op_right_operand_not_bool: '逻辑运算符 {op} 要求右操作数是布尔类型',
        division_by_zero: '除零错误',
        unknown_operator: '未知操作符: {op} 位置 {pos}',
        unknown_unary_operator: '未知一元操作符: {op} 位置 {pos}',
        // 数组返回值绑定 (handleReturnValueAssignment)
        func_no_valid_array_return: '函数 {name} 未返回有效的数组值',
        result_var_not_array: '结果变量 {name} 不是数组类型, 无法接收数组返回值',
        func_no_array_return: '函数 {name} 未返回数组值',
        // ===== 调试输出 (debugLog) 区域A: L790-1600 =====
        dbg_validate_type: '验证数据类型: 值 {value}, 类型 {type}',
        dbg_uninit_var_undefined: '未初始化变量, 存储 undefined',
        dbg_validate_default_branch: '数据类型验证到达默认分支',
        dbg_kind_var: '变量',
        dbg_kind_const: '常量',
        dbg_kind_array: '数组',
        dbg_last_line: '末行',
        dbg_try_add_var: '尝试添加{kind}: {name}, 值: {value}, 类型: {type}, 作用域: {scopeStart}-{scopeEnd}, 是否全局: {isGlobal}',
        dbg_global_var_added: '全局变量 {name} 添加成功',
        dbg_local_var_added: '局部变量 {name} 添加成功',
        dbg_scope_global: '全局',
        dbg_scope_local: '局部',
        dbg_lookup_var: '查找{scope}{kind}: {name} (行 {line})',
        dbg_local_var_count_prefix: '当前局部变量 (含数组) 数量: {count}, ',
        dbg_var_counts: '{localInfo}当前全局变量数量: {globalCount}',
        dbg_array_suffix: ' (数组) ',
        dbg_check_var_scope: '检查 {name}{arraySuffix}: 作用域{scopeStart}-{scopeEnd} 当前行{currentLine} 在范围内: {inScope}',
        dbg_get_var_local: '获取{kind} {name} (局部): 值={value}, 类型={type}, 行号={line}',
        dbg_local_var_details: '局部变量详情:',
        dbg_global_var_details: '全局变量详情:',
        dbg_global_len: '长度={len}',
        dbg_global_val: '值={val}',
        dbg_get_var_global: '获取{kind} {name} (全局): {scopeInfo}, 类型={type}, 行号={line}',
        dbg_warn_var_undefined: '警告: 变量 {name} 未定义 (行 {line})',
        dbg_lookup_var_info: '查找{scope}变量信息: {name} (行 {line})',
        dbg_get_var_info_local: '获取变量信息 {name} (局部): 值={value}, 类型={type}, 作用域={scopeStart}-{scopeEnd}, 行号={line}',
        dbg_get_var_info_global: '获取变量信息 {name} (全局): 值={value}, 类型={type}, 作用域={scopeStart}-{scopeEnd}, 行号={line}',
        dbg_set_var: '设置{scope}变量 {name} (行 {line})',
        dbg_has_var: '查找{scope}变量: {name} (行 {line})',
        dbg_check_var: '  检查 {name}: 作用域{scopeStart}-{scopeEnd} ',
        dbg_in_scope: '当前行{currentLine} 在范围内: {inScope}',
        dbg_found_var: '  找到变量: {name} = {value}',
        dbg_found_global_var: '  找到全局变量: {name} = {value}',
        dbg_func_incomplete: '未完整注册的函数',
        dbg_func_complete: '已完整注册的函数',
        dbg_register_func_status: '{status}: {name}',
        dbg_register_func_scope: '注册函数作用域: {name} (行 {scopeStart}-{scopeEnd})',
        dbg_current_registered_funcs: '当前注册的函数:',
        dbg_find_func_for_line: '查找第 {line} 行所在函数',
        dbg_global_var_cleared: '已清除全局变量 {name}',
        dbg_global_var_not_exists: '全局变量 {name} 不存在',
        dbg_all_local_vars_cleared: '已清除所有局部变量',
        dbg_clear_local_var: '清除指定局部变量 {name}, 作用域: {scopeStart}-{scopeEnd}',
        dbg_clear_local_var_except: '清除指定局部变量 {name} 之外的所有变量, 作用域: {scopeStart}-{scopeEnd}',
        dbg_check_void_func: '检查函数 {name} 是否为 void 函数',
        dbg_scan_start: '开始扫描标签和函数定义',
        dbg_tag_found: '找到标签: {name} (行 {line})',
        dbg_func_end_tag: '检测到函数结束标记, 更新函数信息',
        dbg_updated_func_registry: '更新后的函数注册信息',
        dbg_parse_func: '解析函数: {name}, startLine: {startLine}, params: {params}',
        dbg_scan_end: '扫描标签和函数定义结束',
        dbg_slot_table_built: '槽位符号表构建完成: {count} 个局部声明',
        // ===== 调试输出 (debugLog) 区域B: L1600-3540 =====
        dbg_debug_level_set: 'Debug级别设置为: {level}',
        dbg_doc_debug_lower: '文档内指定调试级别 {docLevel} 低于外部指定调试级别 {extLevel}, 忽略文档内调试级别',
        dbg_exception_caught: '异常被捕获: {message} (行 {line})',
        dbg_program_stopped_error: '程序因错误而停止',
        dbg_program_finished: '程序执行完毕',
        dbg_execute_instr: '执行指令 {content}',
        dbg_exception_msg: '{message}',
        dbg_block_type: '代码块类型',
        dbg_switch_default: 'switch 分支 运行至 default',
        dbg_start_func_call: '开始执行函数调用: {params}',
        dbg_func_info: '函数信息:',
        dbg_func_start_passing: '函数 {funcName} 开始传递参数',
        dbg_param_count: '参数数量: {count}, 实际参数:',
        dbg_param_loop_start: '开始参数传递循环',
        dbg_func_call_args: '函数调用: {funcName}, 参数:',
        dbg_curr_line: '当前行: {line}',
        dbg_loop_index: '循环索引: {i}',
        dbg_set_param: '设置参数: {paramName} (类型: {paramType})',
        dbg_array_param_literal: '数组参数 {paramName} 绑定完成 (模式: literal, 长度: {length}, 只读: true)',
        dbg_array_param_bound: '数组参数 {paramName} 绑定完成 (模式: {mode}, 长度: {length}, 只读: {readonly})',
        dbg_param_bound_slot: '参数 {paramName} 绑定到帧槽位 {slot}',
        dbg_param_loop_end: '参数传递循环结束',
        dbg_current_local_var_details: '当前局部变量详情:',
        dbg_func_param_done: '函数 {funcName} 参数传递完成',
        dbg_check_params_added: '检查参数是否正确添加:',
        dbg_param_index: '参数 {paramName} 的索引: {index}',
        dbg_param_not_found: '参数 {paramName} 未找到',
        dbg_check_params_detail: '详细检查参数:',
        dbg_param_detail: '参数 {paramName} 详情: 索引={index}, 值={value}, 类型={type}, 作用域={scopeStart}-{scopeEnd}',
        dbg_warn_param_type: '警告: 参数 {paramName} 类型不匹配, 期望={expected}, 实际={actual}',
        dbg_func_body_start: '函数体开始行: {line}',
        dbg_func_scope_details: '函数 {funcName} 变量作用域详情:',
        dbg_return_var_scope: '  返回值变量: {name}, 作用域: {scopeStart}-{scopeEnd}',
        dbg_param_scope: '  参数作用域: {scopeStart}-{scopeEnd}',
        dbg_control_flow_stack: '当前流程控制栈:',
        dbg_exec_array_decl: '执行{scope}{kind}数组声明: {params}',
        dbg_array_arrfill: '数组{arrayName}使用arrfill初始化',
        dbg_array_fill_done: '数组填充完毕',
        dbg_array_manual_init: '数组{arrayName}使用手动初始化',
        dbg_exec_op_instr: '执行操作指令: {content}',
        dbg_parse_result: '获得解析结果',
        dbg_detect_array_assign: '侦测到数组赋值 目标:{arrayName} 索引:{index}',
        dbg_array_name: '获得的数组名称: {name}',
        dbg_update_array_elem: '更新数组元素: {oldValue} 为 {newValue}',
        dbg_exec_return: '执行返回语句: {params}',
        dbg_no_return_undefined: '无返回值, 设置为undefined',
        dbg_return_from_var: '从变量获取返回值: {value}',
        dbg_store_return: '存储返回值到RETURN_VALUES[{funcName}][{returnValueStr}]: {returnValue}',
        dbg_return_pool: '当前返回值池内容: ',
        dbg_local_vars_after_cleanup: '函数调用清理后的局部变量表',
        dbg_control_stack_cleaned: '清理后控制流栈:',
        dbg_control_cleaned: '清理后的控制流: ',
        dbg_calc_cond: '计算条件表达式: {expr} (行 {line})',
        dbg_cond_result: '条件表达式结果: {result} (类型: {type})',
        dbg_if_false_line: 'if 条件为假在第 {line} 行',
        dbg_current_control_flow: '当前控制流: ',
        dbg_updated_control_flow: '更新后控制流: ',
        dbg_error_detail: '错误详情: {error}',
        dbg_broken_block_stack: '当前循环结束后控制跳过块栈: ',
        dbg_while_skip: 'while循环条件不满足, 跳过循环, 当前行 {line}, break 标记为 {broken}',
        dbg_control_flow_after_loop: '当前循环结束后控制流: ',
        dbg_for_params: 'for循环参数: {params}',
        dbg_nested_for: '检测到内嵌for循环, 嵌套级别: {level}',
        dbg_matching_endfor: '检测到匹配的endfor语句, 嵌套级别: {level}',
        dbg_endfor_detected: '检测到endfor语句, 嵌套级别: {level}',
        dbg_loop_var_exists: '循环变量已存在 (for重入), 跳过初始化',
        dbg_for_skip: 'for循环条件不满足, 跳过循环, 当前行 {line}, break 标记为 {broken}',
        // ===== 调试输出 (debugLog) 区域C: L3540-4600 =====
        dbg_jump_target: '跳转目标: {targetEndTag}',
        dbg_catch_exception: '捕获异常: {message} (行 {line})',
        dbg_exec_assert: '执行assert语句: {params}',
        dbg_assert_true: '断言条件为真: {expr}',
        dbg_exec_switch: '执行switch语句: {params}',
        dbg_switch_cond_value: 'switch语句的条件表达式值: {value}',
        dbg_handle_case: '处理 case 语句',
        dbg_skip_matched_switch: '跳过已匹配的switch语句: {params}, 嵌套级别: {level}',
        dbg_nested_switch: '嵌套switch语句: {line}, 嵌套级别: {level}',
        dbg_exit_nested_switch: '退出嵌套switch语句: {line}, 嵌套级别: {level}',
        dbg_nested_level_zero: '嵌套层级为0, 当前行指向: {line}',
        dbg_handle_break: '处理break语句: {line}, 嵌套级别: {level}',
        dbg_case_value: 'case语句的条件表达式值: {value}',
        dbg_jump_params: '参数: {params}',
        dbg_jump_cond_false: '不满足jump条件',
        dbg_arr_ref_assign: '数组整体赋值(引用): {newTarget} -> {rhsName}',
        dbg_handle_assign: '处理普通变量赋值 (type: assignment) : {command}',
        dbg_handle_assign_eq: '处理普通变量赋值 (type: =) : {command}',
        dbg_expr_eval_err: '计算表达式时出错 \'{expr}\' 在第 {line} 行: {error}',
        dbg_exec_purge: '执行清除指令: {params}',
        dbg_except_matched: '匹配到except关键字',
        dbg_except_vars: '要排除的变量: {vars}',
        dbg_except_restored: '已将排除的变量恢复, 当前局部变量有: {vars}',
        dbg_purge_all_done: '已清除所有局部变量, 若要清除全局变量请指定清除',
        dbg_purge_var_num: '要被清除的第 {index} 个变量 {name}',
        dbg_purged_var: '已清除变量 {name}, 作用域: {start}-{end}',
        dbg_purge_done: '变量清除完成',
        dbg_func_end_local_vars: '函数 {name} 结束标记后的局部变量表:',
        dbg_func_void_return: '函数 {name} 是无返回值函数, 返回调用位置',
        // ===== 调试输出 (debugLog) 区域D: L4600-6100 =====
        dbg_return_array: '返回{scope}数组: {name} 在第{line}行',
        dbg_return_var_value: '直接返回{scope}变量值: {name} = {value} 在第{line}行',
        dbg_parse_expr: '解析表达式中: {tokens}',
        dbg_parse_not_array_assign: '不是数组赋值, 恢复索引并继续正常解析: {tokens}',
        dbg_parse_logic_or: '解析逻辑或运算中: {tokens}',
        dbg_parse_logic_and: '解析逻辑与运算中: {tokens}',
        dbg_parse_equality: '解析相等性运算中: {tokens}',
        dbg_parse_relational: '解析关系运算中: {tokens}',
        dbg_parse_additive: '解析加法和减法运算中: {tokens}',
        dbg_parse_multiplicative: '解析乘法、除法和取模运算中: {tokens}',
        dbg_parse_power: '解析幂运算中: {tokens}',
        dbg_parse_unary: '解析一元运算符中: {tokens}',
        dbg_parse_primary: '解析基本元素中: {tokens}',
        dbg_check_token: '检查 {token} 是否为变量或函数调用',
        dbg_detect_func_call: '检测到函数调用: {token}',
        dbg_detect_global_prefix: '检测到全局访问前缀',
        dbg_detect_array_access: '检测到数组元素访问: {token}',
        dbg_parse_func_call: '解析函数调用: {funcName}',
        dbg_parse_args: '解析参数',
        dbg_len_arg: '执行 len 传入的 arg: {arg}',
        dbg_arg_string_type: '参数为 string 类型',
        dbg_arg_array_type: '参数为数组类型 {arg}',
        dbg_copy_array: 'copy 深拷贝数组: {name} (长度 {length})',
        dbg_exec_func_call: '执行函数调用: name: {funcName} args:{args}',
        // ===== 调试输出 (debugLog) 区域E: L6100-8500 =====
        dbg_calc_operation: '计算操作: {operator}, 左操作数: {left} (左类型: {leftType}), 右操作数: {right} (右类型: {rightType})',
        dbg_array_ret_new_var: '数组返回值绑定到新变量 {name}',
        dbg_array_ret_existing_var: '数组返回值绑定到已有数组变量 {name}',
        dbg_result_var_undeclared: '结果变量 {name} 未声明, 添加到局部作用域',
        dbg_get_func_return: '获取到函数返回值: {funcName}[{returnVarName}] = {returnValue}',
        dbg_func_no_ret_default: '函数无返回值, 设置默认值: {name} = {value}',
        dbg_nsvm_compile_failed: 'NSVM 编译失败, 回退行解释器: {error}'
    },
    en: {
        // English messages. Placeholders {name} are filled by t().
        cli_usage: 'Usage: node noethingScript-Interpreter.js <filename>',
        cli_no_debug_level: 'Debug level not specified, defaulting to 0',
        cli_invalid_lang: 'Invalid language, only en or zh are supported, keeping default zh',
        cli_unknown_args: 'Unknown arguments: {args} (arguments starting with - only support --debug/--lang/--help/--version; short options (e.g. -h) are NOT supported, use --help for usage)',
        cli_cannot_read: '[Error] Cannot read file \'{filename}\': {error}',
        cli_node_required: '[Error] This script needs a Node.js environment to support file reading',
        internal_error: '[Internal Error] [Line {line}] Interpreter internal error: {message}',
        internal_error_hint: '   This is NOT a script error. It is an interpreter defect, please report it to the developer.',

        // ===== Script runtime error/warning messages (placeholders {name} filled by t()) =====
        // Variable declaration/assignment
        assign_type_mismatch: 'Cannot assign value \'{value}\' to variable \'{name}\', type is \'{type}\'',
        name_already_defined: 'Name \'{name}\' is already defined',
        name_defined_same_scope: 'Name \'{name}\' is already defined in the same scope',
        var_declared_uninitialized: 'Variable \'{name}\' is declared but not initialized',
        const_assignment_forbidden: 'Cannot assign to constant \'{name}\'',
        var_undefined: 'Variable \'{name}\' is not defined',
        var_decl_global_local_format: 'Global/local variable declaration should be "[global/local] [const] name:type = value"',
        var_decl_global_format: 'Global variable declaration should be "global [const] name:type = value"',
        var_decl_local_format: 'Local variable declaration should be "local [const] name:type = value"',
        var_name_invalid: 'Naming error: variable name \'{name}\' does not follow naming rules',
        global_var_in_block: 'Global variables cannot be declared inside a code block',
        local_var_outside_block: 'Local variables cannot be declared outside a code block',
        type_conversion_failed: 'Type conversion failed: cannot convert value \'{value}\' to type {type}',
        loop_var_shadow_forbidden: 'Declaring a variable with the same name \'{name}\' as a loop variable is forbidden in its scope',
        var_undefined_scope: 'Undefined {scope} variable \'{name}\'',
        var_undefined_expr_global: 'Undefined global variable \'{name}\'',
        var_undefined_expr_local: 'Undefined variable \'{name}\'',
        expr_null_not_allowed: 'null value is not allowed in expression',
        expr_undefined_not_allowed: 'undefined value is not allowed in expression',
        var_value_undefined: 'Variable \'{name}\' has the value undefined and cannot be used',
        loop_var_readonly: 'Loop variable {name} is readonly and cannot be modified',
        // Purge
        purge_mode_not_specified: 'No purge mode specified',
        purge_scope_no_except: 'Scope purge mode does not support the except clause',
        purge_target_not_specified: 'Neither "purge all" nor a target variable was specified',
        purge_local_outside_func: 'Local variables cannot be declared outside a function; use the global keyword to purge global variables',
        except_format_error: 'Incorrect usage of the except keyword',
        except_requires_all: 'The except keyword must be used together with the all keyword',
        except_requires_var: 'The except keyword must be used with a variable',
        except_local_only: 'The except keyword only applies to local variables',
        // Function definition/call
        func_end_without_def: 'Function end tag error: found an end tag without a matching function definition',
        func_no_return_stmt: 'Function {name} expects a value of type {type} but no return statement was found',
        func_unexpected_return: 'Function {name} expects no return value but a return statement was found',
        func_nested_def: 'Function definition error: nested function definitions are not allowed',
        func_name_invalid: 'Naming error: function name \'{name}\' does not follow naming rules (C language rules)',
        func_return_type_required: 'Function return value format error: functions with a return value must specify a return type',
        func_param_format: 'Function parameter format error: parameter {param} is invalid, expected "name:type"',
        func_param_mut_array_only: 'Function parameter format error: parameter {param}, the mut keyword only applies to array parameters',
        func_param_array_need_elem_type: 'Function parameter format error: parameter {param}, array parameters must declare an element type, expected "arr[]:elementType"',
        func_return_array_need_elem_type: 'Function return value format error: array return values must declare an element type, expected "-> st[]:elementType"',
        array_elem_type_mismatch: 'Array type mismatch: expected {expected} array, got {actual} array',
        func_unclosed_at_eof: 'Function definition error: an unclosed function remains at the end of the program',
        unsupported_data_type: 'Unsupported data type: {type}',
        func_undefined: 'Function \'{name}\' is not defined',
        func_result_var_missing: 'Function {name} has a return value but no result variable was specified',
        func_result_var_unexpected: 'Function {name} has no return value but a result variable was specified',
        func_arg_count_insufficient: 'Too few arguments passed to function {name}: expected {expected}, got {actual}',
        func_extra_args_ignored: 'More arguments passed to function {name} than defined; extra arguments are ignored',
        func_array_arg_format: 'Function {name} argument {argIndex} has an invalid array argument format; expected "arrayName", "mut arrayName" or "copy(arrayName)"',
        func_mut_param_requires_mut: 'Parameter {name} is declared as a mutable reference (mut); the argument must use the mut keyword',
        func_readonly_param_no_mut: 'Parameter {name} is a readonly reference; the argument cannot use the mut keyword',
        func_arg_type_error: 'Function {name} argument {argIndex} has a type error',
        func_arg_count_missing: 'Function {name} requires {expected} arguments but none were provided',
        call_format: 'Function call should be "call funcName(arg1, arg2, ...) -> resultVar" or "call funcName(arg1, arg2, ...)"',
        // Type/value resolution
        type_mismatch_str: 'Type mismatch: expected {expected} but got a string',
        type_mismatch_bool: 'Type mismatch: expected {expected} but got a boolean',
        type_mismatch_int: 'Type mismatch: expected an integer but got {value}',
        type_mismatch_num: 'Type mismatch: expected {expected} but got a number',
        type_mismatch_var_type: 'Type mismatch: expected {expected} but got {actual}',
        type_mismatch_expr_result: 'Type mismatch: expected {expected}, the result of expression \'{expr}\' has an incompatible type',
        value_unresolvable: 'Cannot resolve value: {value}',
        init_expr_no_var_call: 'Initialization only allows literal expressions; variables or function calls are not allowed \'{name}\' (declare first, then assign)',
        init_literal_only: 'Initialization only allows literals; variables or function calls are not allowed \'{expr}\' (declare first, then assign)',
        // Arrays
        array_decl_format: 'Array declaration should be "array arrName[arrLength]:type = [...]" or "array arrName[arrLength]:type = arrfill"',
        array_name_invalid: 'Naming error: array name \'{name}\' does not follow naming rules',
        array_length_non_negative: 'Array length must be a non-negative integer',
        array_length_expr_unresolvable: 'Cannot resolve array length expression \'{expr}\'',
        array_element_type_unsupported: 'Unsupported array element type \'{type}\'',
        array_of_array_forbidden: 'Arrays of arrays are not allowed',
        array_number_fill_0: 'number arrays are uniformly filled with 0.0; declaring int or float explicitly is recommended',
        array_init_count_mismatch: 'Array initializer element count ({actual}) does not match the declared length ({expected})',
        array_element_unresolvable: 'Cannot resolve value \'{value}\' of array element [{index}]',
        array_init_format: 'Array initialization should use \'[...]\' or \'arrfill\'',
        local_array_outside_func: 'Local arrays cannot be declared outside a function',
        array_literal_element_unresolvable: 'Cannot resolve array literal element: {value}',
        array_literal_arg_parse_failed: 'Array literal argument parse failed ({error})',
        arr_arg_not_array: 'Argument {name} is not an array type',
        array_undefined: 'Undefined array: {name}',
        not_array_type: '{name} is not an array type',
        const_array_assignment: 'Array {name} is a constant array and cannot be assigned',
        readonly_array_assignment: 'Array {name} is a readonly reference and cannot be assigned',
        arr_index_out_of_range: 'Range error: array index {index} out of range, array length is {length}',
        array_element_type_mismatch: 'Array element type error: expected {expected} type but got {actual}',
        const_array_whole_assignment: 'Constant array {name} cannot be assigned as a whole',
        readonly_array_whole_assignment: 'Array {name} is a readonly reference and cannot be assigned as a whole',
        func_split_overflow: '{func} result has {count} segments exceeding container capacity {capacity}',
        // return / print
        return_requires_var: 'The return statement must be followed by a variable',
        return_outside_function: 'The current return statement is not inside a function',
        return_stack_top_mismatch: 'The current return statement is not in the top function of the control flow stack',
        return_var_mismatch: 'return can only return the declared return variable {defReturnVar} of function {funcName}, not {returnValue}',
        func_return_value_missing: 'Function {name} expects a value of type {type} but no return value was provided',
        func_reached_end_no_return: 'Function {name} expects a value of type {type} but reached the end tag without returning',
        return_value_name_mismatch: 'The runtime return value name does not match the return value name in the control flow stack',
        print_expr_failed: 'print cannot evaluate expression \'{expr}\'',
        // Condition expression / if / while / for
        cond_need_parentheses: 'The condition expression must be wrapped in parentheses',
        cond_must_be_bool: 'The condition expression must return a boolean, but it returned type {actualType}',
        cond_invalid: 'Invalid condition expression: {expr}',
        for_format: 'for loop should be "for (local name:type = initialValue; condition; updateExpr)"',
        for_init_failed: 'for loop initialization failed',
        for_update_failed: 'for loop update expression failed',
        // break / continue
        break_outside_loop_switch: 'break statement is not inside a loop or switch',
        break_context_unsupported: 'Unsupported break context',
        continue_outside_loop: 'continue statement is not inside a loop',
        continue_context_unsupported: 'Unsupported continue context',
        matching_end_tag_not_found: 'No matching {tag} found',
        // try / catch
        catch_format: 'catch statement should be "catch (Exception ErrorName)"',
        catch_no_try: 'catch statement has no matching try block',
        // assert
        assert_need_parentheses: 'The assertion expression must be wrapped in parentheses',
        assert_message_quoted: 'The assertion message must be wrapped in double quotes',
        assert_condition_invalid: 'Invalid assertion condition: {expr}',
        // switch / case
        switch_cond_int_only: 'The switch condition expression can only be int or string; numbers must be integers',
        switch_cond_type: 'The switch condition expression can only be int or string',
        switch_cond_invalid: 'Invalid switch condition expression: {expr}',
        case_outside_switch: 'case statement must be used inside a switch block',
        case_type_mismatch: 'The type of the case value must match the switch condition type',
        case_value_invalid: 'Invalid case value: {expr}',
        default_outside_switch: 'default statement must be used inside a switch block',
        endswc_outside_switch: 'endswc statement must be used inside a switch block',
        // jump
        jump_format: 'Must use the format "jump (condition) :labelName" (label must start with a letter or underscore)',
        cond_expr_empty: 'The condition expression cannot be empty',
        cond_expr_invalid: 'Invalid condition expression: {expr}',
        tag_undefined: 'Undefined label: {name}',
        // Function end tag
        stray_func_end_tag: 'Detected a stray function end tag',
        unknown_func_end_tag: 'Unknown function end tag',
        // Others
        execute_operation_failed: 'Cannot execute operation \'{command}\': {error}',
        // Expression evaluation (ExpressionEvaluator)
        expr_eval_error: 'Error evaluating expression \'{expr}\': {inner}',
        unexpected_token_after_parse: 'Unexpected token during token processing: {token}',
        unexpected_char: 'Unexpected character: {char} at position {pos}',
        assignment_op_in_call_context: 'The assignment operator should be handled in the calling context at position {pos}',
        expr_unexpected_end: 'Expression ended unexpectedly at token {pos}',
        missing_right_paren: 'Missing right parenthesis at position {pos}',
        unexpected_token_primary: 'Unexpected token in primary expression parsing: {token} at position {pos}',
        array_index_not_number: 'Array index must be a number at position {pos}',
        array_index_not_nonneg_int: 'Array index must be a non-negative integer at position {pos}',
        array_missing_right_bracket: 'Missing right bracket in array access: {name} at position {pos}',
        array_var_not_array: 'Variable \'{name}\' is not an array type at position {pos}',
        array_index_out_of_range_access: 'Array index out of range: index {index} exceeds the range [0, {max}] of array \'{name}\' at position {pos}',
        array_element_access_error: 'Array element access error: cannot access element {index} of array \'{name}\' at position {pos}',
        invalid_assignment_target: 'Invalid assignment target at position {pos}',
        func_call_missing_right_paren: 'Missing right parenthesis in function call: {name} at position {pos}',
        func_needs_1_arg: '{func} expects 1 argument',
        func_needs_2_args: '{func} expects 2 arguments',
        func_needs_3_args: '{func} expects 3 arguments',
        func_no_arg_expected: '{func} expects no arguments',
        len_only_str_or_array: 'len can only be used on strings or arrays',
        copy_arg_must_be_array: 'The copy argument must be an array type',
        input_unavailable: 'Runtime input (input) is not supported in this environment',
        unknown_function: 'Unknown function: {name} at position {pos}',
        op_left_operand_not_number: 'Operator {op} requires the left operand to be a number',
        op_right_operand_not_number: 'Operator {op} requires the right operand to be a number',
        logic_op_left_operand_not_bool: 'Logical operator {op} requires the left operand to be a boolean',
        logic_op_right_operand_not_bool: 'Logical operator {op} requires the right operand to be a boolean',
        division_by_zero: 'Division by zero',
        unknown_operator: 'Unknown operator: {op} at position {pos}',
        unknown_unary_operator: 'Unknown unary operator: {op} at position {pos}',
        // Array return value binding (handleReturnValueAssignment)
        func_no_valid_array_return: 'Function {name} did not return a valid array value',
        result_var_not_array: 'Result variable {name} is not an array type and cannot receive an array return value',
        func_no_array_return: 'Function {name} did not return an array value',
        // ===== Debug output (debugLog) region A: L790-1600 =====
        dbg_validate_type: 'Validate data type: value {value}, type {type}',
        dbg_uninit_var_undefined: 'Uninitialized variable, storing undefined',
        dbg_validate_default_branch: 'Data type validation reached the default branch',
        dbg_kind_var: 'variable',
        dbg_kind_const: 'constant',
        dbg_kind_array: 'array',
        dbg_last_line: 'last line',
        dbg_try_add_var: 'Trying to add {kind}: {name}, value: {value}, type: {type}, scope: {scopeStart}-{scopeEnd}, isGlobal: {isGlobal}',
        dbg_global_var_added: 'Global variable {name} added successfully',
        dbg_local_var_added: 'Local variable {name} added successfully',
        dbg_scope_global: 'global',
        dbg_scope_local: 'local',
        dbg_lookup_var: 'Looking up {scope}{kind}: {name} (line {line})',
        dbg_local_var_count_prefix: 'Current local variable (incl. arrays) count: {count}, ',
        dbg_var_counts: '{localInfo}Current global variable count: {globalCount}',
        dbg_array_suffix: ' (array) ',
        dbg_check_var_scope: 'Checking {name}{arraySuffix}: scope {scopeStart}-{scopeEnd}, current line {currentLine}, in range: {inScope}',
        dbg_get_var_local: 'Getting {kind} {name} (local): value={value}, type={type}, line={line}',
        dbg_local_var_details: 'Local variable details:',
        dbg_global_var_details: 'Global variable details:',
        dbg_global_len: 'length={len}',
        dbg_global_val: 'value={val}',
        dbg_get_var_global: 'Getting {kind} {name} (global): {scopeInfo}, type={type}, line={line}',
        dbg_warn_var_undefined: 'Warning: variable {name} is not defined (line {line})',
        dbg_lookup_var_info: 'Looking up {scope}variable info: {name} (line {line})',
        dbg_get_var_info_local: 'Getting variable info {name} (local): value={value}, type={type}, scope={scopeStart}-{scopeEnd}, line={line}',
        dbg_get_var_info_global: 'Getting variable info {name} (global): value={value}, type={type}, scope={scopeStart}-{scopeEnd}, line={line}',
        dbg_set_var: 'Setting {scope} variable {name} (line {line})',
        dbg_has_var: 'Looking up {scope}variable: {name} (line {line})',
        dbg_check_var: '  Checking {name}: scope {scopeStart}-{scopeEnd} ',
        dbg_in_scope: 'current line {currentLine} in range: {inScope}',
        dbg_found_var: '  Found variable: {name} = {value}',
        dbg_found_global_var: '  Found global variable: {name} = {value}',
        dbg_func_incomplete: 'Incompletely registered function',
        dbg_func_complete: 'Fully registered function',
        dbg_register_func_status: '{status}: {name}',
        dbg_register_func_scope: 'Registering function scope: {name} (line {scopeStart}-{scopeEnd})',
        dbg_current_registered_funcs: 'Currently registered functions:',
        dbg_find_func_for_line: 'Finding the function containing line {line}',
        dbg_global_var_cleared: 'Cleared global variable {name}',
        dbg_global_var_not_exists: 'Global variable {name} does not exist',
        dbg_all_local_vars_cleared: 'Cleared all local variables',
        dbg_clear_local_var: 'Clearing specified local variable {name}, scope: {scopeStart}-{scopeEnd}',
        dbg_clear_local_var_except: 'Clearing all variables except the specified local variable {name}, scope: {scopeStart}-{scopeEnd}',
        dbg_check_void_func: 'Checking whether function {name} is a void function',
        dbg_scan_start: 'Starting to scan labels and function definitions',
        dbg_tag_found: 'Found label: {name} (line {line})',
        dbg_func_end_tag: 'Detected function end tag, updating function info',
        dbg_updated_func_registry: 'Updated function registration info',
        dbg_parse_func: 'Parsing function: {name}, startLine: {startLine}, params: {params}',
        dbg_scan_end: 'Finished scanning labels and function definitions',
        dbg_slot_table_built: 'Slot symbol table built: {count} local declarations',
        // ===== Debug output (debugLog) region B: L1600-3540 =====
        dbg_debug_level_set: 'Debug level set to: {level}',
        dbg_doc_debug_lower: 'Debug level {docLevel} specified in document is lower than external debug level {extLevel}, ignoring in-document debug level',
        dbg_exception_caught: 'Exception caught: {message} (line {line})',
        dbg_program_stopped_error: 'Program stopped due to an error',
        dbg_program_finished: 'Program finished',
        dbg_execute_instr: 'Executing instruction {content}',
        dbg_exception_msg: '{message}',
        dbg_block_type: 'Code block type',
        dbg_switch_default: 'switch branch reached default',
        dbg_start_func_call: 'Starting function call: {params}',
        dbg_func_info: 'Function info:',
        dbg_func_start_passing: 'Function {funcName} starts passing parameters',
        dbg_param_count: 'Parameter count: {count}, actual arguments:',
        dbg_param_loop_start: 'Starting parameter passing loop',
        dbg_func_call_args: 'Function call: {funcName}, arguments:',
        dbg_curr_line: 'Current line: {line}',
        dbg_loop_index: 'Loop index: {i}',
        dbg_set_param: 'Setting parameter: {paramName} (type: {paramType})',
        dbg_array_param_literal: 'Array parameter {paramName} bound (mode: literal, length: {length}, readonly: true)',
        dbg_array_param_bound: 'Array parameter {paramName} bound (mode: {mode}, length: {length}, readonly: {readonly})',
        dbg_param_bound_slot: 'Parameter {paramName} bound to frame slot {slot}',
        dbg_param_loop_end: 'Parameter passing loop ended',
        dbg_current_local_var_details: 'Current local variable details:',
        dbg_func_param_done: 'Function {funcName} parameter passing completed',
        dbg_check_params_added: 'Checking whether parameters were added correctly:',
        dbg_param_index: 'Index of parameter {paramName}: {index}',
        dbg_param_not_found: 'Parameter {paramName} not found',
        dbg_check_params_detail: 'Detailed parameter check:',
        dbg_param_detail: 'Parameter {paramName} details: index={index}, value={value}, type={type}, scope={scopeStart}-{scopeEnd}',
        dbg_warn_param_type: 'Warning: parameter {paramName} type mismatch, expected={expected}, actual={actual}',
        dbg_func_body_start: 'Function body start line: {line}',
        dbg_func_scope_details: 'Function {funcName} variable scope details:',
        dbg_return_var_scope: '  Return value variable: {name}, scope: {scopeStart}-{scopeEnd}',
        dbg_param_scope: '  Parameter scope: {scopeStart}-{scopeEnd}',
        dbg_control_flow_stack: 'Current control flow stack:',
        dbg_exec_array_decl: 'Executing {scope}{kind} array declaration: {params}',
        dbg_array_arrfill: 'Array {arrayName} initialized with arrfill',
        dbg_array_fill_done: 'Array fill complete',
        dbg_array_manual_init: 'Array {arrayName} initialized manually',
        dbg_exec_op_instr: 'Executing operation instruction: {content}',
        dbg_parse_result: 'Got parse result',
        dbg_detect_array_assign: 'Detected array assignment target:{arrayName} index:{index}',
        dbg_array_name: 'Obtained array name: {name}',
        dbg_update_array_elem: 'Updating array element: {oldValue} to {newValue}',
        dbg_exec_return: 'Executing return statement: {params}',
        dbg_no_return_undefined: 'No return value, setting to undefined',
        dbg_return_from_var: 'Getting return value from variable: {value}',
        dbg_store_return: 'Storing return value to RETURN_VALUES[{funcName}][{returnValueStr}]: {returnValue}',
        dbg_return_pool: 'Current return value pool contents: ',
        dbg_local_vars_after_cleanup: 'Local variable table after function call cleanup',
        dbg_control_stack_cleaned: 'Control flow stack after cleanup:',
        dbg_control_cleaned: 'Control flow after cleanup: ',
        dbg_calc_cond: 'Evaluating condition expression: {expr} (line {line})',
        dbg_cond_result: 'Condition expression result: {result} (type: {type})',
        dbg_if_false_line: 'if condition is false at line {line}',
        dbg_current_control_flow: 'Current control flow: ',
        dbg_updated_control_flow: 'Updated control flow: ',
        dbg_error_detail: 'Error details: {error}',
        dbg_broken_block_stack: 'Broken block stack after loop: ',
        dbg_while_skip: 'while loop condition not met, skipping loop, current line {line}, break flag is {broken}',
        dbg_control_flow_after_loop: 'Control flow after loop: ',
        dbg_for_params: 'for loop parameters: {params}',
        dbg_nested_for: 'Detected nested for loop, nesting level: {level}',
        dbg_matching_endfor: 'Detected matching endfor statement, nesting level: {level}',
        dbg_endfor_detected: 'Detected endfor statement, nesting level: {level}',
        dbg_loop_var_exists: 'Loop variable already exists (for re-entry), skipping initialization',
        dbg_for_skip: 'for loop condition not met, skipping loop, current line {line}, break flag is {broken}',
        // ===== Debug output (debugLog) region C: L3540-4600 =====
        dbg_jump_target: 'Jump target: {targetEndTag}',
        dbg_catch_exception: 'Exception caught: {message} (line {line})',
        dbg_exec_assert: 'Executing assert statement: {params}',
        dbg_assert_true: 'Assertion condition is true: {expr}',
        dbg_exec_switch: 'Executing switch statement: {params}',
        dbg_switch_cond_value: 'Value of switch condition expression: {value}',
        dbg_handle_case: 'Handling case statement',
        dbg_skip_matched_switch: 'Skipping matched switch statement: {params}, nesting level: {level}',
        dbg_nested_switch: 'Nested switch statement: {line}, nesting level: {level}',
        dbg_exit_nested_switch: 'Exiting nested switch statement: {line}, nesting level: {level}',
        dbg_nested_level_zero: 'Nesting level is 0, current line pointer: {line}',
        dbg_handle_break: 'Handling break statement: {line}, nesting level: {level}',
        dbg_case_value: 'Value of case condition expression: {value}',
        dbg_jump_params: 'Parameters: {params}',
        dbg_jump_cond_false: 'jump condition not met',
        dbg_arr_ref_assign: 'Whole array assignment (reference): {newTarget} -> {rhsName}',
        dbg_handle_assign: 'Handling normal variable assignment (type: assignment): {command}',
        dbg_handle_assign_eq: 'Handling normal variable assignment (type: =): {command}',
        dbg_expr_eval_err: 'Error evaluating expression \'{expr}\' at line {line}: {error}',
        dbg_exec_purge: 'Executing purge command: {params}',
        dbg_except_matched: 'Matched the except keyword',
        dbg_except_vars: 'Variables to exclude: {vars}',
        dbg_except_restored: 'Excluded variables restored, current local variables: {vars}',
        dbg_purge_all_done: 'Cleared all local variables; specify global to clear global variables',
        dbg_purge_var_num: 'Purge target #{index}: {name}',
        dbg_purged_var: 'Cleared variable {name}, scope: {start}-{end}',
        dbg_purge_done: 'Variable purge complete',
        dbg_func_end_local_vars: 'Local variable table after the end tag of function {name}:',
        dbg_func_void_return: 'Function {name} is a void function, returning to the call location',
        // ===== Debug output (debugLog) region D: L4600-6100 =====
        dbg_return_array: 'Returning{scope} array: {name} at line {line}',
        dbg_return_var_value: 'Directly returning{scope} variable value: {name} = {value} at line {line}',
        dbg_parse_expr: 'Parsing expression: {tokens}',
        dbg_parse_not_array_assign: 'Not an array assignment, restoring index and continuing normal parsing: {tokens}',
        dbg_parse_logic_or: 'Parsing logical OR operation: {tokens}',
        dbg_parse_logic_and: 'Parsing logical AND operation: {tokens}',
        dbg_parse_equality: 'Parsing equality operation: {tokens}',
        dbg_parse_relational: 'Parsing relational operation: {tokens}',
        dbg_parse_additive: 'Parsing addition and subtraction operation: {tokens}',
        dbg_parse_multiplicative: 'Parsing multiplication, division and modulo operation: {tokens}',
        dbg_parse_power: 'Parsing power operation: {tokens}',
        dbg_parse_unary: 'Parsing unary operator: {tokens}',
        dbg_parse_primary: 'Parsing primary element: {tokens}',
        dbg_check_token: 'Checking whether {token} is a variable or a function call',
        dbg_detect_func_call: 'Detected function call: {token}',
        dbg_detect_global_prefix: 'Detected global access prefix',
        dbg_detect_array_access: 'Detected array element access: {token}',
        dbg_parse_func_call: 'Parsing function call: {funcName}',
        dbg_parse_args: 'Parsing arguments',
        dbg_len_arg: 'Executing len with argument: {arg}',
        dbg_arg_string_type: 'Argument is of string type',
        dbg_arg_array_type: 'Argument is of array type {arg}',
        dbg_copy_array: 'copy deep copies array: {name} (length {length})',
        dbg_exec_func_call: 'Executing function call: name: {funcName} args:{args}',
        // ===== Debug output (debugLog) region E: L6100-8500 =====
        dbg_calc_operation: 'Calculating operation: {operator}, left operand: {left} (left type: {leftType}), right operand: {right} (right type: {rightType})',
        dbg_array_ret_new_var: 'Array return value bound to new variable {name}',
        dbg_array_ret_existing_var: 'Array return value bound to existing array variable {name}',
        dbg_result_var_undeclared: 'Result variable {name} is not declared, adding to local scope',
        dbg_get_func_return: 'Got function return value: {funcName}[{returnVarName}] = {returnValue}',
        dbg_func_no_ret_default: 'Function has no return value, setting default: {name} = {value}',
        dbg_nsvm_compile_failed: 'NSVM compilation failed, falling back to line interpreter: {error}'
    }
};

// 消息翻译函数: t('key', {name: value}) → 当前语言的模板填充文本
// 目标语言缺失时自动回退到中文, 中文缺失时回退为 key 本身 (便于发现遗漏)
function t(key: string, vars?: { [k: string]: any }): string {
    const pack = LANG_PACKS[LANG] || LANG_PACKS.zh;
    let msg = pack[key];
    if (msg === undefined) msg = LANG_PACKS.zh[key];
    if (msg === undefined) msg = key;
    if (vars) {
        for (const k in vars) {
            msg = msg.split(`{${k}}`).join(String(vars[k]));
        }
    }
    return msg;
}

// 统一错误报告入口: 输出格式为 "[ERROR N] [行 X] 类型: 消息" (英文时 [Line X] + 英文类型名)
// line 缺省时取当前执行行 (currentLinePointer + 1)
function reportError(type: ExceptionType, message: string, line?: number): void {
    const lineNum = line !== undefined ? line : currentLinePointer + 1;
    if (LANG === 'en') {
        console.error(`[ERROR ${ERROR_CODES[type]}] [Line ${lineNum}] ${ERROR_NAMES_EN[type]}: ${message}`);
    } else {
        console.error(`[ERROR ${ERROR_CODES[type]}] [行 ${lineNum}] ${ERROR_NAMES[type]}: ${message}`);
    }
}

// 统一警告报告入口: 输出格式为 "[WARN] [行 X] 警告: 消息" (英文时 [Line X] + Warning), 区别于错误
function reportWarn(message: string, line?: number): void {
    const lineNum = line !== undefined ? line : currentLinePointer + 1;
    if (LANG === 'en') {
        console.warn(`[WARN] [Line ${lineNum}] Warning: ${message}`);
    } else {
        console.warn(`[WARN] [行 ${lineNum}] 警告: ${message}`);
    }
}


// 异常接口定义
interface Exception {
    type: ExceptionType;
    message: string;
    lineNumber: number;
}

// 作用域管理类
class ScopeManager {
    // 验证数据类型
    static validateType(value: any, type: DataType): { isValid: boolean, convertedValue: any } {
        DEBUG_LEVEL >= 1 && debugLog(1, () => t('dbg_validate_type', { value: value === "" ? '""' : value, type }));
        // 未初始化变量 (无 = 值 的声明) 或 无返回值函数返回值变量: 值为 undefined
        if (value === undefined) {
            debugLog(1, () => t('dbg_uninit_var_undefined'));
            return { isValid: true, convertedValue: undefined };
        }

        switch (type) {
            case DataType.NUMBER:
                // NUMBER类型应该自动判断是INT还是FLOAT
                if (typeof value === 'number') {
                    return { isValid: true, convertedValue: value };
                }
                const num = Number(value);
                return { isValid: !isNaN(num) && isFinite(num), convertedValue: num };
            case DataType.INT:
                if (typeof value === 'number' && Number.isInteger(value)) {
                    return { isValid: true, convertedValue: value };
                }
                if (String(value).match(/^-?\d+$/)) { // 确保是整数
                    return { isValid: true, convertedValue: parseInt(value, 10) };
                }
                return { isValid: false, convertedValue: undefined };
            case DataType.FLOAT:
                if (typeof value === 'number' && !isNaN(value) && isFinite(value)) {
                    return { isValid: true, convertedValue: value };
                }
                const float = parseFloat(value as string);
                return { isValid: !isNaN(float) && isFinite(float), convertedValue: float };
            case DataType.STRING:
                // 字符串类型可以接受任何值并转换为字符串
                return { isValid: true, convertedValue: String(value) };
            case DataType.BOOL:
                // 布尔类型只接受true或false
                if (value === true || value === false) {
                    return { isValid: true, convertedValue: value };
                }
                // 不接受其他值作为布尔值
                return { isValid: false, convertedValue: undefined };
            case DataType.ARRAY:
                // 数组类型验证
                if (Array.isArray(value)) {
                    return { isValid: true, convertedValue: value };
                }
                return { isValid: false, convertedValue: undefined };
            default:
                debugLog(1, () => t('dbg_validate_default_branch'))
                return { isValid: true, convertedValue: value };
        }
    }

    // 添加变量 (全局或局部)
    // slot 参数 (函数参数/返回值绑定专用): 提供时跳过"同名同作用域"线性查重 (静态建表已保证参数间唯一),
    // 并直接把变量登记到帧槽位 SLOT_INDEX[frameId][slot], 免后续 indexSlotVar 的 Map 查找。
    static addVariable(name: string, value: any, type: DataType, startLine: number, endLine: number, isGlobal: boolean = false, isConst: boolean = false, frameId?: number, slot?: number, arrayElementType?: DataType): boolean {
        // 惰性化: DEBUG_LEVEL 不足时短路, 免闭包创建 (热路径: 函数参数绑定/变量声明每次调用)
        if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_try_add_var', { kind: isConst ? t('dbg_kind_const') : t('dbg_kind_var'), name, value, type, scopeStart: startLine + 1, scopeEnd: endLine === -1 ? t('dbg_last_line') : endLine + 1, isGlobal }));
        // 验证类型
        const validation = ScopeManager.validateType(value, type);
        if (!validation.isValid) {
            reportError(ExceptionType.TYPE_ERROR, t('assign_type_mismatch', {value: value, name: name, type: type}), startLine + 1);
            return false;
        }

        // 未显式指定帧ID时, 自动归属当前最内层函数调用帧 (递归时用于隔离不同调用帧的局部变量)
        if (!isGlobal && frameId === undefined) {
            for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
                if (CONTROL_FLOW_STACK[i].type === 'function') {
                    frameId = (CONTROL_FLOW_STACK[i] as { frameId: number }).frameId;
                    break;
                }
            }
        }

        const variable: Variable = {
            name,
            value: validation.convertedValue,
            type,
            isGlobal,
            isConst,  // 添加常量标识
            startLine,
            endLine,
            frameId,
            ...(type === DataType.ARRAY && arrayElementType !== undefined ? { arrayElementType } : {})
        };

        if (isGlobal) {
            if (GLOBAL_VARS.hasOwnProperty(name)) {
                reportError(ExceptionType.REFERENCE_ERROR, t('name_already_defined', {name: name}));
                // currentLinePointer = programLines.length;
                // throw { type: ExceptionType.REFERENCE_ERROR, message: `引用错误: 名称 '${name}' 已被定义` } as Exception;
                return false;
            }
            GLOBAL_VARS[name] = variable;
            if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_global_var_added', { name }));
        } else {
            if (slot === undefined) {
                // 检查是否存在名称、作用域和调用帧完全相同的局部变量 (不同调用帧允许同名, 以支持递归)
                for (const localVar of LOCAL_VARS) {
                    if (localVar.name === name && localVar.frameId === variable.frameId && localVar.startLine === variable.startLine && localVar.endLine === variable.endLine) {
                        reportError(ExceptionType.REFERENCE_ERROR, t('name_defined_same_scope', {name: name}));
                        // currentLinePointer = programLines.length;
                        // throw { type: ExceptionType.REFERENCE_ERROR, message: `引用错误: 名称 '${name}' 在相同作用域内已被定义` } as Exception;
                        return false;
                    }
                }
            }
            LOCAL_VARS.push(variable);
            // 帧槽位写入: 静态建表已保证该 slot 属于当前函数帧 (参数/返回值变量)
            if (slot !== undefined && frameId !== undefined) {
                const m = SLOT_INDEX[String(frameId)] || (SLOT_INDEX[String(frameId)] = {});
                m[slot] = variable;
            }
            if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_local_var_added', { name }));
        }
        // 注意: 不再在此处同步槽位索引 — 由各调用方在"声明批次"结束后统一调用 rebuildSlotIndex(),
        // 避免函数参数绑定等连续多次 addVariable 时重复全量重建 (热路径开销)。

        // 如果未赋初值, 发出警告 (默认静默, 调试级别 >= 1 时显示, 避免先声明后赋值如 input() 场景刷屏)
        if (value === undefined && DEBUG_LEVEL >= 1) {
            reportWarn(t('var_declared_uninitialized', {name: name}), startLine + 1);
        }

        return true;
    }

    // 获取变量值 (考虑行号作用域) 
    static getVariable(vname: string, currentLine: number, isArray: boolean = false, isGlobal: boolean = false): any {
        let name: string = vname;
        // 惰性化: DEBUG_LEVEL 不足时短路, 免闭包创建 (热路径: 表达式求值/parseValue 每次变量读取都走这里)
        if (DEBUG_LEVEL >= 2) {
            debugLog(2, () => t('dbg_lookup_var', { scope: isGlobal ? t('dbg_scope_global') : '', kind: isArray ? t('dbg_kind_array') : t('dbg_kind_var'), name, line: currentLine + 1 }));
            debugLog(2, () => t('dbg_var_counts', { localInfo: isGlobal ? '' : t('dbg_local_var_count_prefix', { count: LOCAL_VARS.length }), globalCount: Object.keys(GLOBAL_VARS).length }));
        }
        if (isGlobal) {
            if (name.startsWith('global.')) {
                name = name.slice('global.'.length);
            }
        }

        if (!isGlobal) {
            // 添加详细的作用域检查
            for (let i = LOCAL_VARS.length - 1; i >= 0; i--) {
                const varInfo = LOCAL_VARS[i];
                const inScope = currentLine >= varInfo.startLine &&
                    (currentLine <= varInfo.endLine || varInfo.endLine === -1);

                if (DEBUG_LEVEL >= 3) debugLog(3, () => t('dbg_check_var_scope', { name: varInfo.name, arraySuffix: isArray ? t('dbg_array_suffix') : '', scopeStart: varInfo.startLine + 1, scopeEnd: varInfo.endLine === -1 ? t('dbg_last_line') : varInfo.endLine + 1, currentLine: currentLine + 1, inScope }));

                if (varInfo.name === name && inScope) {
                    if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_get_var_local', { kind: isArray ? t('dbg_kind_array') : t('dbg_kind_var'), name, value: varInfo.value, type: varInfo.type, line: currentLine + 1 }));
                    return isArray ? varInfo : varInfo.value;
                }
            }

            if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_local_var_details'), LOCAL_VARS);
        }

        if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_global_var_details'), GLOBAL_VARS);
        // 2. 再检查全局变量
        if (GLOBAL_VARS.hasOwnProperty(name)) {
            if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_get_var_global', { kind: isArray ? t('dbg_kind_array') : t('dbg_kind_var'), name, scopeInfo: isArray ? t('dbg_global_len', { len: GLOBAL_VARS[name].arrayLength }) : t('dbg_global_val', { val: GLOBAL_VARS[name].value }), type: GLOBAL_VARS[name].type, line: currentLine + 1 }));
            return isArray ? GLOBAL_VARS[name] : GLOBAL_VARS[name].value;

        }

        if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_warn_var_undefined', { name, line: currentLine + 1 }));
        return undefined;
    }

    // 获取变量信息 (考虑行号作用域) 
    static getVariableInfo(vname: string, currentLine: number, isGlobal: boolean = false): Variable | null {
        let name: string = vname;
        // 惰性化: DEBUG_LEVEL 不足时短路, 免闭包创建 (热路径: executeReturn 返回值查找回退路径)
        if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_lookup_var_info', { scope: isGlobal ? t('dbg_scope_global') : '', name, line: currentLine + 1 }));

        if (isGlobal) {
            if (name.startsWith('global.')) {
                name = name.slice('global.'.length);
            }
        }
        if (!isGlobal) {
            // 1. 先检查局部变量
            for (let i = LOCAL_VARS.length - 1; i >= 0; i--) {
                const varInfo = LOCAL_VARS[i];
                // 检查变量名是否匹配
                if (varInfo.name === name) {
                    // 检查变量是否在作用域内
                    // 对于函数参数, 作用域从startLine到endLine
                    // 特殊处理: 如果endLine为-1, 表示这是一个函数返回值变量, 作用域从startLine到函数结束
                    if (currentLine >= varInfo.startLine && (currentLine <= varInfo.endLine || varInfo.endLine === -1)) {
                        if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_get_var_info_local', { name, value: varInfo.value, type: varInfo.type, scopeStart: varInfo.startLine + 1, scopeEnd: varInfo.endLine === -1 ? t('dbg_last_line') : varInfo.endLine + 1, line: currentLine + 1 }));
                        return varInfo;
                    }
                }
            }
        }

        // 2. 再检查全局变量 (直接访问代替 hasOwnProperty 方法调用: GLOBAL_VARS 值恒为 Variable 对象,
        //    不存在时(未声明/purge 已 delete)为 undefined, 与 hasOwnProperty 语义完全等价)
        const globalVar = GLOBAL_VARS[name];
        if (globalVar !== undefined) {
            if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_get_var_info_global', { name, value: globalVar.value, type: globalVar.type, scopeStart: globalVar.startLine + 1, scopeEnd: globalVar.endLine === -1 ? t('dbg_last_line') : globalVar.endLine + 1, line: currentLine + 1 }));
            return globalVar;
        }

        if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_warn_var_undefined', { name, line: currentLine + 1 }));
        return null;
    }

    // 获取变量类型
    static getVariableType(vname: string, currentLine: number, isGlobal: boolean = false): DataType {
        let name: string = vname;
        if (isGlobal) {
            if (name.startsWith('global.')) {
                name = name.slice('global.'.length);
            }
        }
        if (!isGlobal) {
            // 1. 先检查局部变量
            for (let i = LOCAL_VARS.length - 1; i >= 0; i--) {
                const varInfo = LOCAL_VARS[i];
                if (varInfo.name === name &&
                    currentLine >= varInfo.startLine &&
                    (currentLine <= varInfo.endLine || varInfo.endLine === -1)) {
                    return varInfo.type;
                }
            }
        }

        // 2. 再检查全局变量
        if (GLOBAL_VARS.hasOwnProperty(name)) {
            return GLOBAL_VARS[name].type;
        }

        return DataType.UNDEFINED;
    }

    // 设置变量值
    static setVariable(vname: string, value: any, currentLine: number, isGlobal: boolean = false): boolean {
        let name: string = vname;
        debugLog(2, () => t('dbg_set_var', { scope: isGlobal ? t('dbg_scope_global') : t('dbg_scope_local'), name, line: currentLine + 1 }));

        if (isGlobal) {
            if (name.startsWith('global.')) {
                name = name.slice('global.'.length);
            }
        }
        if (!isGlobal) {
            // 1. 先检查局部变量
            for (let i = LOCAL_VARS.length - 1; i >= 0; i--) {
                const varInfo = LOCAL_VARS[i];
                if (varInfo.name === name && currentLine >= varInfo.startLine && (currentLine <= varInfo.endLine || varInfo.endLine === -1)) {
                    // 检查是否为常量
                    if (varInfo.isConst) {
                        reportError(ExceptionType.TYPE_ERROR, t('const_assignment_forbidden', {name: name}), currentLine + 1);
                        return false;
                    }
                    // 验证类型
                    const validation = ScopeManager.validateType(value, varInfo.type);
                    if (!validation.isValid) {
                        reportError(ExceptionType.TYPE_ERROR, t('assign_type_mismatch', {value: value, name: name, type: varInfo.type}), currentLine + 1);
                        return false;
                    }
                    LOCAL_VARS[i].value = validation.convertedValue;
                    return true;
                }
            }
        }

        // 2. 再检查全局变量
        if (GLOBAL_VARS.hasOwnProperty(name)) {
            // 检查是否为常量
            if (GLOBAL_VARS[name].isConst) {
                reportError(ExceptionType.TYPE_ERROR, t('const_assignment_forbidden', {name: name}), currentLine + 1);
                return false;
            }
            // 验证类型
            const validation = ScopeManager.validateType(value, GLOBAL_VARS[name].type);
            if (!validation.isValid) {
                reportError(ExceptionType.TYPE_ERROR, t('assign_type_mismatch', {value: value, name: name, type: GLOBAL_VARS[name].type}), currentLine + 1);
                return false;
            }
            GLOBAL_VARS[name].value = validation.convertedValue;
            return true;
        }

        reportError(ExceptionType.REFERENCE_ERROR, t('var_undefined', {name: name}), currentLine + 1);
        return false;
    }

    // 检查变量是否存在
    static hasVariable(vname: string, currentLine: number, isGlobal: boolean = false): boolean {
        let name: string = vname;
        debugLog(2, () => t('dbg_has_var', { scope: isGlobal ? t('dbg_scope_global') : '', name, line: currentLine + 1 }));
        let foundVar = null;

        if (isGlobal) {
            if (name.startsWith('global.')) {
                name = name.slice('global.'.length);
            }
        }
        if (!isGlobal) {
            // 检查局部变量
            for (let i = LOCAL_VARS.length - 1; i >= 0; i--) {
                const varInfo = LOCAL_VARS[i];
                const inScope = currentLine >= varInfo.startLine &&
                    (currentLine <= varInfo.endLine || varInfo.endLine === -1);

                debugLog(3, () => t('dbg_check_var', { name: varInfo.name, scopeStart: varInfo.startLine + 1, scopeEnd: varInfo.endLine === -1 ? t('dbg_last_line') : varInfo.endLine + 1 }) + t('dbg_in_scope', { currentLine: currentLine + 1, inScope }));

                if (varInfo.name === name && inScope) {
                    debugLog(2, () => t('dbg_found_var', { name, value: varInfo.value === "" ? '""' : varInfo.value }));
                    foundVar = varInfo;
                    return true; // 优先返回最近声明的变量
                }
            }
        }

        // 检查全局变量
        const globalExists = GLOBAL_VARS.hasOwnProperty(name);
        if (globalExists) {
            debugLog(2, () => t('dbg_found_global_var', { name, value: GLOBAL_VARS[name].value === "" ? '""' : GLOBAL_VARS[name].value }));
        }
        return globalExists;
    }

    // 注册函数
    static registerFunction(funcInfo: FunctionInfo): void {
        debugLog(2, () => t('dbg_register_func_status', { status: funcInfo.endLine === -1 ? t('dbg_func_incomplete') : t('dbg_func_complete'), name: funcInfo.name }));
        debugLog(3, () => t('dbg_register_func_scope', { name: funcInfo.name, scopeStart: funcInfo.startLine + 1, scopeEnd: funcInfo.endLine === -1 ? t('dbg_last_line') : funcInfo.endLine + 1 }));

        FUNCTIONS[funcInfo.name] = funcInfo; // 直接覆盖同名函数定义，不支持函数重载
        debugLog(2, () => t('dbg_current_registered_funcs'), FUNCTIONS);
    }

    // 获取当前行所在的函数名
    static getCurrentFunction(currentLine: number): string | null {
        debugLog(3, () => t('dbg_find_func_for_line', { line: currentLine + 1 }));
        for (const funcName in FUNCTIONS) {
            const funcInfo = FUNCTIONS[funcName];
            if (currentLine >= funcInfo.startLine && currentLine <= funcInfo.endLine) {
                return funcName;
            }
        }
        return null;
    }

    // 从函数信息中提取函数定义的返回值变量名
    static getReturnVarName(funcInfo: FunctionInfo): string | undefined {
        // 函数解析时已缓存返回值变量名, 避免每次返回都重复正则解析函数定义行
        if (funcInfo.returnVarName !== undefined) return funcInfo.returnVarName;
        const funcDefLine = programLines[funcInfo.startLine].trim();
        const funcMatch = funcDefLine.match(/^:([a-zA-Z0-9_]+)\s*\((.*)\)\s*->\s*(:?[a-zA-Z0-9_]*(?:\[\])?)(?:\s*:([a-zA-Z0-9_]+))?$/);
        if (funcMatch) {
            const returnVarNameOrVoid = funcMatch[3];
            if (returnVarNameOrVoid !== ':void') {
                const name = returnVarNameOrVoid.startsWith(':') ? returnVarNameOrVoid.substring(1) : returnVarNameOrVoid;
                return name.endsWith('[]') ? name.slice(0, -2) : name;
            }
        }
        return undefined;
    }

    //  (可能) 实现垃圾回收机制后使用
    // // 清理超出范围的局部变量 (用于优化内存) 
    // static cleanupVariables(currentLine: number): void {
    //     debugLog(2, () => `清理超出范围的局部变量: 行 ${currentLine + 1}`);
    //     LOCAL_VARS = LOCAL_VARS.filter(varInfo => currentLine <= varInfo.endLine);
    // }

    // 清理指定全局变量 (手动管理)
    static cleanupGlobalVariable(varName: string) {
        if (GLOBAL_VARS.hasOwnProperty(varName)) {
            delete GLOBAL_VARS[varName];
            debugLog(1, () => t('dbg_global_var_cleared', { name: varName }));
        }
        else {
            debugLog(1, () => t('dbg_global_var_not_exists', { name: varName }));
        }
    }

    // 清理指定局部变量 (手动管理, 必须手动指定作用域范围) 
    static cleanupLocalVariable(cleanAll: Boolean = false, exceptMode?: Boolean, varName?: string, startLine?: number, endLine?: number, frameId?: number) {
        if (cleanAll) {
            LOCAL_VARS = [];
            rebuildSlotIndex();
            debugLog(1, () => t('dbg_all_local_vars_cleared'));
            return;
        }
        if (!cleanAll && exceptMode === undefined) {
            reportError(ExceptionType.SYNTAX_ERROR, t('purge_mode_not_specified'));
            return;
        }
        if (!cleanAll && varName && startLine !== undefined && endLine !== undefined && !exceptMode) {
            debugLog(2, () => t('dbg_clear_local_var', { name: varName, scopeStart: startLine + 1, scopeEnd: endLine === -1 ? t('dbg_last_line') : endLine + 1 }));
            LOCAL_VARS = LOCAL_VARS.filter(varInfo => !(varInfo.name === varName && varInfo.startLine === startLine && varInfo.endLine === endLine && varInfo.frameId === frameId));
            rebuildSlotIndex();
            return;
        }
        if (!cleanAll && varName && startLine !== undefined && endLine !== undefined && exceptMode) {
            debugLog(2, () => t('dbg_clear_local_var_except', { name: varName, scopeStart: startLine + 1, scopeEnd: endLine === -1 ? t('dbg_last_line') : endLine + 1 }));
            LOCAL_VARS = LOCAL_VARS.filter(varInfo => (varInfo.name === varName && varInfo.startLine === startLine && varInfo.endLine === endLine && varInfo.frameId === frameId));
            rebuildSlotIndex();
            return;
        }
        if (!cleanAll && !varName && startLine !== undefined && endLine !== undefined) {
            if (exceptMode) {
                reportWarn(t('purge_scope_no_except'));
            }
            LOCAL_VARS = LOCAL_VARS.filter(varInfo => !(varInfo.startLine >= startLine && varInfo.endLine <= endLine));
            rebuildSlotIndex();
            return;
        }
        else {
            reportError(ExceptionType.SYNTAX_ERROR, t('purge_target_not_specified'));
            return;
        }
    }

    // 检查函数返回类型是否为undefined (void函数) 
    static isVoidFunction(funcInfo: FunctionInfo): boolean {
        debugLog(3, () => t('dbg_check_void_func', { name: funcInfo.name }));
        return funcInfo.returnType === DataType.UNDEFINED;
    }
}

// 解释器类
class Interpreter {
    // // 隐藏变量, 用于存储函数返回值
    // private static lastReturnValue: any = undefined;
    // private static lastReturnType: DataType = DataType.UNDEFINED;

    // 加载程序
    static loadProgram(code: string): void {
        programLines = code.split('\n');
        // 构建行预处理缓存 (与 programLines 严格一一对应, 行号/标签/作用域索引不受影响)
        // 同时完成阶段1行级预编译: 每行分类为结构化语句 (数字类型 + 预拼接参数), 运行时免 split/关键字判定
        LINE_INFO = programLines.map(raw => {
            const content = raw.trim();
            return {
                content,
                isEmpty: content === '',
                isComment: content.indexOf('//') === 0,
                isEndTag: content === ':end',
                stmt: Interpreter.classifyLine(content)
            };
        });
        currentLinePointer = 0;
        TAGS = {};
        FUNCTIONS = {};
        GLOBAL_VARS = {};
        LOCAL_VARS = [];
        IN_MULTILINE_COMMENT = false;

        // 程序指纹递增: 表达式树缓存按程序隔离 (树节点携带静态槽位绑定, 跨程序不可共享)
        PROGRAM_ID++;
        SLOT_INDEX = {};

        // 第一次扫描: 解析标签和函数定义
        Interpreter.scanTagsAndFunctions();
        // 构建局部变量静态符号表 (槽位映射)
        Interpreter.buildSlotSymbolTable();

        // 重置 NSVM (寄存器虚拟机) 状态: 新程序必须重新编译, 旧程序执行现场全部作废
        NSVMExecutor.active = false;
        NSVMExecutor.globalBlock = null;
        NSVMExecutor.funcBlocks = new Map();
        NSVMExecutor.frames = [];
        NSVMExecutor.vmTryStack = [];
        NSVMExecutor.switchStack = [];
    }

    // 扫描标签和函数定义
    static scanTagsAndFunctions(): void {
        debugLog(1, () => t('dbg_scan_start'));
        TAGS = {};
        FUNCTIONS = {};
        let currentFunction: FunctionInfo | null = null;
        let inFunction = false;

        for (let i = 0; i < programLines.length; i++) {
            const line = programLines[i].trim();

            // 多行注释: 仅整行恰为 "///" 的独立行作为开始/结束标志 (就近闭合), 内容行中的 /// 前缀不参与切换
            // 避免多行注释区间内的 :end / 标签 / 函数定义行被误解析
            if (line === '///') {
                IN_MULTILINE_COMMENT = !IN_MULTILINE_COMMENT;
                continue;
            }
            if (IN_MULTILINE_COMMENT) continue;
            if (line === '') continue;

            // 检查标签
            // debugLog(0, () => `检查标签: ${line}`);
            // 检查行是否不是 ":end", 并且匹配标签格式。正则解释: 
            // ^: 匹配以冒号开头
            // ([a-zA-Z_]\w*) 捕获组, 匹配以字母或下划线开头, 后跟零个或多个单词字符 (字母、数字、下划线) 
            // $ 匹配字符串结束位置
            if (line !== ':end' && line.match(/^:([a-zA-Z_]\w*)$/)) {
                const tagName = line.substring(1).trim();
                TAGS[tagName] = i;
                debugLog(1, () => t('dbg_tag_found', { name: tagName, line: i + 1 }));
                continue;
            }

            // 检查函数定义或结束
            // debugLog(0, () => `检查函数定义或结束: ${line}`);
            if (line.indexOf(':') === 0) {
                // 检查是否是函数结束标记
                if (line === ':end') {
                    if (!inFunction) {
                        reportError(ExceptionType.SYNTAX_ERROR, t('func_end_without_def'), i + 1);
                        return;
                    }
                    if (currentFunction) {
                        // 更新FUNCTION中的函数作用域信息
                        debugLog(2, () => t('dbg_func_end_tag'));
                        let funcInfo = currentFunction;
                        funcInfo.endLine = i;
                        ScopeManager.registerFunction(funcInfo);
                        debugLog(2, () => t('dbg_updated_func_registry'), FUNCTIONS);
                        // 检查非void函数是否包含return语句
                        if (currentFunction.returnType !== DataType.UNDEFINED) {
                            let hasReturn = false;
                            for (let j = currentFunction.startLine + 1; j < i; j++) {
                                const funcLine = programLines[j].trim();
                                if (funcLine.toLowerCase().indexOf('return') === 0) {
                                    hasReturn = true;
                                    break;
                                }
                            }
                            if (!hasReturn) {
                                reportError(ExceptionType.TYPE_ERROR, t('func_no_return_stmt', {name: currentFunction.name, type: currentFunction.returnType}), i + 1);
                            }
                        } else {
                            // void函数, 检查是否有return语句
                            let hasReturn = false;
                            let returnLine = 0;
                            for (let j = currentFunction.startLine + 1; j < i; j++) {
                                const funcLine = programLines[j].trim();
                                if (funcLine.toLowerCase().indexOf('return') === 0) {
                                    hasReturn = true;
                                    returnLine = j;
                                    break;
                                }
                            }
                            if (hasReturn) {
                                reportError(ExceptionType.TYPE_ERROR, t('func_unexpected_return', {name: currentFunction.name}), returnLine + 1);
                            }
                        }
                    }
                    inFunction = false;
                    currentFunction = null;
                    continue;
                }
                // 检查是否是其他函数相关标记
                if (inFunction) {
                    reportError(ExceptionType.SYNTAX_ERROR, t('func_nested_def'), i + 1);
                    return;
                }

                // 解析函数定义: :函数名 (参数列表) -> 返回值变量名:返回值类型
                // 支持两种格式:
                // 1. 有返回值: :函数名 (参数列表) -> 返回值变量名:返回值类型
                // 2. 无返回值: :函数名 (参数列表) -> :void
                // 数组返回值: :函数名 (参数列表) -> 返回值变量名[]:元素类型
                const funcMatch = line.match(/^:([a-zA-Z0-9_]+)\s*\((.*)\)\s*->\s*(:?[a-zA-Z0-9_]*(?:\[\])?)(?:\s*:([a-zA-Z0-9_]+))?$/);
                if (funcMatch) {
                    const funcName = funcMatch[1];

                    // 检查函数名是否符合C语言命名规则
                    if (!Interpreter.isValidIdentifier(funcName)) {
                        reportError(ExceptionType.REFERENCE_ERROR, t('func_name_invalid', {name: funcName}), i + 1);
                        return;
                    }
                    const paramsStr = funcMatch[2];
                    const returnVarNameOrVoid = funcMatch[3]; // 返回值变量名(可带[]表示数组)或:void
                    const returnTypeStr = funcMatch[4]; // 返回值类型 (如果有)

                    // 处理返回值类型
                    let returnType: DataType;
                    let returnVarName: string | null = null;
                    let returnArrayElementType: DataType | undefined = undefined;
                    // 检查是否是无返回值函数 (:void)
                    if (returnVarNameOrVoid === ':void') {
                        returnType = DataType.UNDEFINED; // 使用UNDEFINED表示void类型
                    } else if (returnVarNameOrVoid.endsWith('[]')) {
                        // 数组返回值: -> st[]:元素类型
                        if (!returnTypeStr) {
                            reportError(ExceptionType.SYNTAX_ERROR, t('func_return_array_need_elem_type'), i + 1);
                            return;
                        }
                        const arrElemType = Interpreter.getDataTypeFromString(returnTypeStr);
                        if (arrElemType === DataType.UNDEFINED) {
                            return; // getDataTypeFromString 已报错
                        }
                        if (arrElemType === DataType.ARRAY) {
                            reportError(ExceptionType.SYNTAX_ERROR, t('array_of_array_forbidden'), i + 1);
                            return;
                        }
                        returnType = DataType.ARRAY;
                        returnArrayElementType = arrElemType;
                        returnVarName = returnVarNameOrVoid.slice(0, -2);
                    } else {
                        // 有返回值函数, returnVarNameOrVoid是返回值变量名, returnTypeStr是返回值类型
                        if (!returnTypeStr) {
                            reportError(ExceptionType.SYNTAX_ERROR, t('func_return_type_required'), i + 1);
                            return;
                        }
                        returnType = Interpreter.getDataTypeFromString(returnTypeStr);
                        // 旧语法 -> st:array 已废弃, 数组返回值必须声明元素类型
                        if (returnType === DataType.ARRAY) {
                            reportError(ExceptionType.SYNTAX_ERROR, t('func_return_array_need_elem_type'), i + 1);
                            return;
                        }
                        // 处理带冒号前缀的返回值变量名
                        returnVarName = returnVarNameOrVoid.startsWith(':') ? returnVarNameOrVoid.substring(1) : returnVarNameOrVoid;
                    }

                    // 解析参数列表: param1:type1, param2:type2, ...
                    const params: FunctionParameter[] = [];
                    if (paramsStr.trim()) {
                        const paramMatches = paramsStr.split(',');
                        for (const paramMatch of paramMatches) {
                            const parts = paramMatch.trim().split(':');
                            if (parts.length !== 2) {
                                reportError(ExceptionType.SYNTAX_ERROR, t('func_param_format', {param: paramMatch}), i + 1);
                                return;
                            }
                            // 解析 mut 前置关键字 (仅数组参数有意义)
                            let isMutable = false;
                            let paramName = parts[0].trim();
                            if (paramName.startsWith('mut ')) {
                                isMutable = true;
                                paramName = paramName.substring(4).trim();
                            }
                            const paramTypeStr = parts[1].trim();
                            let paramType = Interpreter.getDataTypeFromString(paramTypeStr);
                            if (paramType === DataType.UNDEFINED) {
                                return; // getDataTypeFromString 已报错
                            }
                            let paramArrayElementType: DataType | undefined = undefined;
                            if (paramName.endsWith('[]')) {
                                // 数组形参: arr[]:元素类型
                                paramName = paramName.slice(0, -2);
                                if (paramType === DataType.ARRAY) {
                                    reportError(ExceptionType.SYNTAX_ERROR, t('array_of_array_forbidden'), i + 1);
                                    return;
                                }
                                paramArrayElementType = paramType; // 元素类型 (int/float/string/bool/number)
                                paramType = DataType.ARRAY;
                            } else if (paramType === DataType.ARRAY) {
                                // 旧语法 arr:array 已废弃, 数组形参必须声明元素类型
                                reportError(ExceptionType.SYNTAX_ERROR, t('func_param_array_need_elem_type', {param: paramMatch}), i + 1);
                                return;
                            }
                            if (isMutable && paramType !== DataType.ARRAY) {
                                reportError(ExceptionType.SYNTAX_ERROR, t('func_param_mut_array_only', {param: paramMatch}), i + 1);
                                return;
                            }
                            params.push({
                                name: paramName,
                                type: paramType,
                                isMutable: isMutable,
                                ...(paramArrayElementType !== undefined ? { arrayElementType: paramArrayElementType } : {})
                            });
                        }
                    }

                    currentFunction = {
                        name: funcName,
                        params: params,
                        returnType: returnType,
                        startLine: i,
                        endLine: -1,
                        returnVarName: returnVarName || undefined,
                        ...(returnArrayElementType !== undefined ? { returnArrayElementType: returnArrayElementType } : {})
                        // hasReturnStatement: false
                    };
                    debugLog(3, () => t('dbg_parse_func', { name: funcName, startLine: i, params: JSON.stringify(params) }));
                    inFunction = true;
                    ScopeManager.registerFunction(currentFunction);
                }
            }
        }

        if (inFunction) {
            reportError(ExceptionType.SYNTAX_ERROR, t('func_unclosed_at_eof'));
        }
        debugLog(1, () => t('dbg_scan_end'));
    }

    // 构建局部变量静态符号表 (槽位映射): 程序加载时一次性执行。
    // 与运行时行号作用域规则保持一致: 普通局部变量作用域=所在最内层块; 局部数组作用域=所在函数;
    // 函数参数/返回值变量作用域=整个函数体; for 循环变量作用域=for块。
    static buildSlotSymbolTable(): void {
        SLOT_DECLS = [];
        SLOT_BY_NAME = new Map();
        SLOT_INDEX = {};

        // 第一遍: 构建块区间表 (start/end, 含函数块)
        const blocks: { start: number; end: number; type: string; funcKey?: string }[] = [];
        const stack: { start: number; type: string; funcKey?: string }[] = [];
        let inMultiComment = false;
        for (let i = 0; i < programLines.length; i++) {
            const line = programLines[i].trim();
            if (line === '///') { inMultiComment = !inMultiComment; continue; }
            if (inMultiComment || line === '' || line.indexOf('//') === 0) continue;
            // 标签行 (非函数定义/非:end)
            if (line !== ':end' && line.match(/^:([a-zA-Z_]\w*)$/)) continue;
            if (line.indexOf(':') === 0) {
                if (line === ':end') {
                    const b = stack.pop();
                    if (b) blocks.push({ start: b.start, end: i, type: b.type, funcKey: b.funcKey });
                } else if (line.match(/^:[a-zA-Z0-9_]+\s*\(.*\)/)) {
                    const funcMatch = line.match(/^:([a-zA-Z0-9_]+)\s*\(/);
                    stack.push({ start: i, type: 'function', funcKey: 'f:' + (funcMatch ? funcMatch[1] : '') + ':' + i });
                }
                continue;
            }
            const first = line.split(/\s+/)[0];
            if (first === 'if' || first === 'while' || first === 'for' || first === 'switch' || first === 'try') {
                stack.push({ start: i, type: first });
            } else if (first === 'endif' || first === 'endwhl' || first === 'endfor' || first === 'endswc' || first === 'endtry') {
                const b = stack.pop();
                if (b) blocks.push({ start: b.start, end: i, type: b.type, funcKey: b.funcKey });
            }
            // else/case/default/catch: 不推不弹, 归属当前块
        }
        while (stack.length) {
            const b = stack.pop();
            if (b) blocks.push({ start: b.start, end: programLines.length - 1, type: b.type, funcKey: b.funcKey });
        }

        // 辅助: 行所属的最内层块 (含函数块)
        const deepestBlock = (line: number): { start: number; end: number; type: string; funcKey?: string } | null => {
            let best: { start: number; end: number; type: string; funcKey?: string } | null = null;
            for (const b of blocks) {
                if (b.start <= line && line <= b.end) {
                    if (!best || b.end < best.end) best = b;
                }
            }
            return best;
        };
        // 辅助: 行所属的最近函数块
        const funcBlock = (line: number): { start: number; end: number; funcKey?: string } | null => {
            let best: { start: number; end: number; funcKey?: string } | null = null;
            for (const b of blocks) {
                if (b.type === 'function' && b.start <= line && line <= b.end) {
                    if (!best || b.end < best.end) best = b;
                }
            }
            return best;
        };

        // 第二遍: 声明行登记 + 槽位分配
        const frameSlots: Map<string, number> = new Map();
        const registerDecl = (name: string, startLine: number, endLine: number, isArray: boolean, isConst: boolean, forcedKey?: string) => {
            const fb = funcBlock(startLine);
            const frameKey = forcedKey !== undefined ? forcedKey : (fb ? fb.funcKey! : 'top');
            let slot = frameSlots.get(frameKey) || 0;
            frameSlots.set(frameKey, slot + 1);
            const decl: SlotDecl = {
                name, startLine, endLine,
                type: isArray ? DataType.ARRAY : DataType.UNDEFINED,
                isConst, isArray, frameKey, slot
            };
            SLOT_DECLS.push(decl);
            let list = SLOT_BY_NAME.get(name);
            if (!list) { list = []; SLOT_BY_NAME.set(name, list); }
            list.push(decl);
        };

        let multiComment = false;
        for (let i = 0; i < programLines.length; i++) {
            const line = programLines[i].trim();
            if (line === '///') { multiComment = !multiComment; continue; }
            if (multiComment || line === '' || line.indexOf('//') === 0) continue;
            if (line !== ':end' && line.match(/^:([a-zA-Z_]\w*)$/)) continue;

            // 函数定义: 参数 + 返回值变量 (帧槽位从0开始)
            if (line.indexOf(':') === 0 && line.match(/^:[a-zA-Z0-9_]+\s*\(.*\)/)) {
                const funcMatch = line.match(/^:([a-zA-Z0-9_]+)\s*\((.*)\)\s*->\s*(:?[a-zA-Z0-9_]*(?:\[\])?)(?:\s*:([a-zA-Z0-9_]+))?$/);
                if (!funcMatch) continue;
                const frameKey = 'f:' + funcMatch[1] + ':' + i;
                const fb = blocks.find(b => b.type === 'function' && b.funcKey === frameKey);
                if (!fb) continue;
                const bodyStart = fb.start + 1;
                const bodyEnd = fb.end;
                let slot = 0;
                if (funcMatch[2].trim()) {
                    for (const pm of funcMatch[2].split(',')) {
                        const parts = pm.trim().split(':');
                        if (parts.length !== 2) continue;
                        let pname = parts[0].trim();
                        if (pname.startsWith('mut ')) pname = pname.substring(4).trim();
                        if (!pname) continue;
                        const isArray = pname.endsWith('[]') || parts[1].trim().toLowerCase() === 'array';
                        if (pname.endsWith('[]')) pname = pname.slice(0, -2);
                        registerDecl(pname, bodyStart, bodyEnd, isArray, false, frameKey);
                        slot++;
                    }
                }
                const ret = funcMatch[3];
                if (ret && ret !== ':void') {
                    let retName = ret.startsWith(':') ? ret.substring(1) : ret;
                    if (retName.endsWith('[]')) retName = retName.slice(0, -2);
                    registerDecl(retName, bodyStart, bodyEnd, false, false, frameKey);
                    slot++;
                }
                frameSlots.set(frameKey, slot);
                continue;
            }

            const first = line.split(/\s+/)[0];
            // for 循环变量: for (local x:int = ...; ...; ...)
            if (first === 'for') {
                const fm = line.match(/^for\s*\(?local\s+([a-zA-Z0-9_]+):/);
                if (fm) {
                    const fb = blocks.find(b => b.type === 'for' && b.start === i);
                    registerDecl(fm[1], i, fb ? fb.end : i, false, false);
                }
                continue;
            }
            // 局部变量/常量/数组声明 (local [const] name:type / local array name[len]:type)
            if (first === 'local') {
                let declStr = line.substring(5).trim();
                let isConst = false;
                if (declStr.startsWith('const ')) { isConst = true; declStr = declStr.substring(6).trim(); }
                const db = deepestBlock(i);
                const declEnd = db ? db.end : -1;
                if (declStr.startsWith('array ')) {
                    // 局部数组: 作用域=所在函数帧 (与 executeArrayDeclaration 一致)
                    const am = declStr.substring(6).trim().match(/^([a-zA-Z0-9_]+)\[/);
                    if (am) {
                        const fb = funcBlock(i);
                        registerDecl(am[1], i, fb ? fb.end : declEnd, true, isConst, undefined);
                    }
                } else {
                    const vm = declStr.match(/^([a-zA-Z0-9_]+):/);
                    if (vm) registerDecl(vm[1], i, declEnd, false, isConst, undefined);
                }
            }
        }
        debugLog(1, () => t('dbg_slot_table_built', { count: SLOT_DECLS.length }));
    }


    // 辅助方法: 将字符串类型转换为DataType枚举 (阶段3 NSVM 复用)
    static getDataTypeFromString(typeStr: string): DataType {
        switch (typeStr.toLowerCase()) {
            case 'number':
                return DataType.NUMBER;
            case 'int':
                return DataType.INT;
            case 'float':
                return DataType.FLOAT;
            case 'string':
                return DataType.STRING;
            case 'bool':
                return DataType.BOOL;
            case 'array':
                return DataType.ARRAY;
            default:
                reportError(ExceptionType.SYNTAX_ERROR, t('unsupported_data_type', {type: typeStr}));
                return DataType.UNDEFINED;
        }
    }

    // 数组元素类型兼容判断: from 元素类型能否装入 to 元素类型的数组 (与标量 validateType 语义一致:
    // NUMBER/FLOAT 接受任意数字, INT 只接受整数, STRING/BOOL 严格相等)
    static canArrayElementFit(from: DataType, to: DataType): boolean {
        if (to === DataType.NUMBER || to === DataType.FLOAT) {
            return from === DataType.INT || from === DataType.FLOAT || from === DataType.NUMBER;
        }
        if (to === DataType.INT) {
            return from === DataType.INT;
        }
        return from === to;
    }

    // 辅助方法: 从值推断数据类型
    private static inferTypeFromValue(value: any): DataType {
        if (typeof value === 'number') {
            // 检查是否为整数
            if (Number.isInteger(value)) {
                return DataType.INT;
            } else {
                return DataType.FLOAT;
            }
        } else if (typeof value === 'string') {
            return DataType.STRING;
        } else if (typeof value === 'boolean') {
            return DataType.BOOL;
        } else if (Array.isArray(value)) {
            return DataType.ARRAY;
        } else {
            return DataType.UNDEFINED;
        }
    }

    // 辅助方法: 解析值并进行类型检查
    // 解析字面量/变量引用为指定类型的值 (阶段3 NSVM 的 FORINIT 复用)
    static parseValue(valueStr: string, expectedType: DataType): any {
        // 处理字符串 (必须带双引号) 
        if (valueStr.startsWith('"') && valueStr.endsWith('"')) {
            const strValue = valueStr.substring(1, valueStr.length - 1);

            if (expectedType !== DataType.STRING) {
                throw { type: ExceptionType.TYPE_ERROR, message: t('type_mismatch_str', {expected: expectedType}) } as Exception;
            }
            return strValue;
        }

        // 处理布尔值
        if (valueStr === 'true' || valueStr === 'false') {
            const boolValue = valueStr === 'true';
            if (expectedType !== DataType.BOOL) {
                throw { type: ExceptionType.TYPE_ERROR, message: t('type_mismatch_bool', {expected: expectedType}) } as Exception;
            }
            return boolValue;
        }

        // 处理数字 (包括十六进制、二进制、八进制) 
        // 修复正则表达式, 确保能正确匹配各种数字格式
        // 重新排列正则表达式, 确保更具体的模式优先匹配
        if (/^(-?0[xX][0-9a-fA-F]+|-?0[bB][01]+|-?0[oO][0-7]+|-?\d+\.\d+|-?\d+)$/.test(valueStr)) {
            let numValue: number;
            if (valueStr.startsWith('0x') || valueStr.startsWith('0X')) {
                // 十六进制
                numValue = parseInt(valueStr, 16);
            } else if (valueStr.startsWith('0b') || valueStr.startsWith('0B')) {
                // 二进制
                numValue = parseInt(valueStr.slice(2), 2);
            } else if (valueStr.startsWith('0o') || valueStr.startsWith('0O')) {
                // 八进制
                numValue = parseInt(valueStr.slice(2), 8);
            } else {
                // 十进制
                numValue = Number(valueStr);
            }

            if (expectedType === DataType.NUMBER) {
                return numValue;
            } else if (expectedType === DataType.INT) {
                if (!Number.isInteger(numValue)) {
                    throw { type: ExceptionType.TYPE_ERROR, message: t('type_mismatch_int', {value: numValue}) } as Exception;
                }
                // 直接返回整数值, 不需要Math.floor
                return numValue;
            } else if (expectedType === DataType.FLOAT) {
                return numValue;
            } else {
                throw { type: ExceptionType.TYPE_ERROR, message: t('type_mismatch_num', {expected: expectedType}) } as Exception;
            }
        }

        // 处理变量引用
        const varValue = ScopeManager.getVariable(valueStr, currentLinePointer);
        if (varValue !== undefined) {
            const varType = ScopeManager.getVariableType(valueStr, currentLinePointer);
            if (varType !== expectedType) {
                throw { type: ExceptionType.TYPE_ERROR, message: t('type_mismatch_var_type', {expected: expectedType, actual: varType}) } as Exception;
            }
            return varValue;
        }

        throw { type: ExceptionType.SYNTAX_ERROR, message: t('value_unresolvable', {value: valueStr}) } as Exception;
    }

    // 解析声明初始化值: 支持字面量表达式 (仅允许字面量参与运算, 不允许变量引用/函数调用)
    private static parseInitValue(valueExpr: string, expectedType: DataType): any {
        // 纯字符串字面量直接走原逻辑 (避免字符串内部包含运算符被误判为表达式)
        const quoteCount = (valueExpr.match(/"/g) || []).length;
        if (valueExpr.startsWith('"') && valueExpr.endsWith('"') && quoteCount === 2) {
            return Interpreter.parseValue(valueExpr, expectedType);
        }
        // 含运算符/括号 → 按字面量表达式处理
        if (/[+\-*/%<>=!&|()]/.test(valueExpr)) {
            // 剔除字符串字面量后检查标识符, 仅允许 true/false/null/undefined 字面量关键字
            const stripped = valueExpr.replace(/"([^"\\]|\\.)*"/g, '""');
            const words = stripped.match(/[a-zA-Z_]\w*/g) || [];
            const allowedWords = ['true', 'false', 'null', 'undefined'];
            const forbidden = words.filter(w => !allowedWords.includes(w));
            if (forbidden.length > 0) {
                throw {
                    type: ExceptionType.SYNTAX_ERROR,
                    message: t('init_expr_no_var_call', {name: forbidden[0]}),
                    lineNumber: currentLinePointer + 1
                } as Exception;
            }
            // 求值纯字面量表达式并做类型验证
            const literalValue = Interpreter.evaluateExpression(valueExpr);
            const validation = ScopeManager.validateType(literalValue, expectedType);
            if (!validation.isValid) {
                throw {
                    type: ExceptionType.TYPE_ERROR,
                    message: t('type_mismatch_expr_result', {expected: expectedType, expr: valueExpr}),
                    lineNumber: currentLinePointer + 1
                } as Exception;
            }
            return validation.convertedValue;
        }
        // 无运算符 → 仅允许字面量 (数字/布尔/字符串), 不允许变量引用
        if (/^(-?0[xX][0-9a-fA-F]+|-?0[bB][01]+|-?0[oO][0-7]+|-?\d+\.\d+|-?\d+)$|^(true|false)$/.test(valueExpr)) {
            return Interpreter.parseValue(valueExpr, expectedType);
        }
        // 非字面量 (变量引用等) → 报错
        throw {
            type: ExceptionType.SYNTAX_ERROR,
            message: t('init_literal_only', {expr: valueExpr}),
            lineNumber: currentLinePointer + 1
        } as Exception;
    }

    // 执行程序
    static run(): void {
        if (!INPUT_SUSPENDED) {
            // 首次执行: 重置执行现场
            currentLinePointer = 0;
            CONTROL_FLOW_STACK = [];
            EXCEPTION_STACK = [];
            PENDING_EXCEPTION = null;
            IN_MULTILINE_COMMENT = false;
            CALL_FRAME_ID = 0;

            // 检查第一行是否包含debug关键字 (命令行 --debug 已显式指定时, 命令行优先级最高, 忽略脚本内 debug 指令)
            if (!CLI_DEBUG_SET && programLines.length > 0) {
                const firstLine = programLines[0].trim();
                if (firstLine.startsWith('debug ')) {
                    const debugLevelStr = firstLine.substring(6).trim();
                    const debugLevel = parseInt(debugLevelStr);
                    if (!isNaN(debugLevel)) {
                        DEBUG_LEVEL = debugLevel;
                        debugLog(1, () => t('dbg_debug_level_set', { level: DEBUG_LEVEL }));
                    } else {
                        debugLog(1, () => t('dbg_doc_debug_lower', { docLevel: debugLevel, extLevel: DEBUG_LEVEL }));
                    }
                    // 跳过debug行
                    currentLinePointer = 1;
                }
            }

            // 首次执行: 尝试 NSVM (寄存器虚拟机) 加速; 编译失败整体回退行解释器 (双模式回退)
            if (NSVMExecutor.prepare()) {
                NSVMExecutor.run();
                return;
            }
        } else {
            // 恢复执行 (NSI.resumeInput 从挂起处继续): 保留行指针/控制流栈/局部变量等执行现场
            INPUT_SUSPENDED = false;
            // 若挂起发生在 NSVM 内 (input() 于 VM 指令执行中), 继续 VM 执行; 否则行解释器
            if (NSVMExecutor.active && NSVMExecutor.frames.length > 0) {
                NSVMExecutor.run();
                return;
            }
        }

        while (currentLinePointer < programLines.length) {
            try {
                const info = LINE_INFO[currentLinePointer];
                const line = info.content;

                // 多行注释: 仅整行恰为 "///" 的独立行作为开始/结束标志 (就近闭合), 内容行中的 /// 前缀不参与切换
                if (line === '///') {
                    IN_MULTILINE_COMMENT = !IN_MULTILINE_COMMENT;
                    currentLinePointer++;
                    continue;
                }
                // 多行注释区间内的任意行 (即使不以 // 开头) 一律忽略
                if (IN_MULTILINE_COMMENT) {
                    currentLinePointer++;
                    continue;
                }

                if (info.isEmpty || info.isComment) {
                    currentLinePointer++;
                    continue;
                }

                // 跳过标签行 (已在扫描阶段处理) 
                if (line.indexOf(':') === 0) {
                    // 检查是否是函数定义, 如果是则跳转到:end标记
                    // 函数定义格式: :函数名(参数列表) -> 返回值
                    if (line.match(/^:[a-zA-Z0-9_]+\s*\(.*\)/)) {  // 是函数定义
                        // 查找对应的:end标记
                        let endLine = -1;
                        for (let i = currentLinePointer + 1; i < programLines.length; i++) {
                            if (LINE_INFO[i].isEndTag) {
                                endLine = i;
                                break;
                            }
                        }

                        if (endLine !== -1) {
                            // 跳转到:end标记的下一行
                            currentLinePointer = endLine + 1;
                            continue;
                        }
                    } else if (info.isEndTag) {
                        Interpreter.executeCommand(info.stmt, line); // 先遇到函数结束标签可能处于无返回值函数中, 需要特殊处理
                    }

                    currentLinePointer++;
                    continue;
                }

                // 执行指令 (阶段1: 数字类型分发的结构化语句)
                Interpreter.executeCommand(info.stmt, line);
                currentLinePointer++;
            } catch (error) {
                // input 挂起信号: 交还控制权给宿主等待下一次输入 (不报错不终止)
                if (isInputSuspend(error)) {
                    INPUT_SUSPENDED = true;
                    return;
                }
                // 处理异常
                const exception = error as Exception;
                if (exception.lineNumber === undefined) {
                    exception.lineNumber = currentLinePointer;
                }

                // 查找激活的 try 块 (从控制流栈栈顶向下找最近的 try 帧)
                let tryIdx = -1;
                for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
                    if (CONTROL_FLOW_STACK[i].type === 'try') {
                        tryIdx = i;
                        break;
                    }
                }

                if (tryIdx !== -1) {
                    const tryFrame = CONTROL_FLOW_STACK[tryIdx] as { type: 'try', start: number };
                    // 从 try 起始行向后查找对应的 catch 行 (跳过嵌套 try)
                    const catchLine = Interpreter.findCatchLine(tryFrame.start);
                    if (catchLine !== -1) {
                        // 弹出 try 帧之上的所有控制流帧 (函数帧/循环帧/if帧等), 保留 try 帧本身
                        CONTROL_FLOW_STACK.length = tryIdx + 1;
                        // 同步清理异常栈中该 try 块之上的标记
                        let excIdx = -1;
                        for (let i = EXCEPTION_STACK.length - 1; i >= 0; i--) {
                            if (EXCEPTION_STACK[i].type === ExceptionType.TRY_BLOCK && EXCEPTION_STACK[i].lineNumber === tryFrame.start) {
                                excIdx = i;
                                break;
                            }
                        }
                        if (excIdx !== -1) {
                            EXCEPTION_STACK.length = excIdx;
                        }
                        // 记录待绑定的异常, 供 executeCatch 使用
                        PENDING_EXCEPTION = exception;
                        debugLog(1, () => t('dbg_exception_caught', { message: exception.message, line: currentLinePointer + 1 }));
                        // 跳转到 catch 行, 让主循环执行 executeCatch 绑定异常变量
                        currentLinePointer = catchLine;
                        continue;
                    }
                }

                // 未被捕获的异常: 必须对用户可见 (不受 debug 级别控制)
                if (Object.values(ExceptionType).includes(exception.type)) {
                    // 脚本抛出的异常: 统一错误格式输出并终止
                    reportError(exception.type, exception.message);
                    currentLinePointer = programLines.length; // 终止执行
                } else {
                    // 解释器内部错误 (原生 JS 异常/未识别的异常): 与脚本错误明确区分
                    const nativeMsg = error instanceof Error ? error.message : String(error);
                    console.error(t('internal_error', { line: currentLinePointer + 1, message: nativeMsg }));
                    console.error(t('internal_error_hint'));
                    currentLinePointer = programLines.length; // 内部错误终止, 避免级联执行
                }
            }
        }

        if (EXCEPTION_STACK.length > 0) {
            debugLog(1, () => t('dbg_program_stopped_error'));
        } else {
            debugLog(1, () => t('dbg_program_finished'));
        }
    }

    // 执行指令
    // executeCommand 中 switch 的全部命令关键字 (小写), 用于快速判断是否需要走完整 split/分发逻辑。
    // 含 'const' (const 位置检查用); 纯赋值/表达式行 (首 token 不在集合) 直接进 executeOperation。
    private static readonly KEYWORD_COMMANDS: string[] = [
        'global', 'local', 'const', 'call', 'return', 'jump', 'print',
        'if', 'else', 'endif', 'while', 'endwhl', 'for', 'endfor',
        'break', 'continue', 'try', 'catch', 'endtry', 'assert', 'endasrt',
        'switch', 'case', 'default', 'endswc', 'purge', ':end'
    ];
    // 关键字集合: Set.has O(1), 替代每行执行时对数组的线性 indexOf (行分发热路径)
    private static readonly KEYWORD_SET: Set<string> = new Set(Interpreter.KEYWORD_COMMANDS);

    // 判断一行命令是否以关键字开头 (需走完整 switch 分发)
    private static isKeywordCommand(command: string): boolean {
        const sp = command.indexOf(' ');
        const first = sp === -1 ? command : command.substring(0, sp);
        return Interpreter.KEYWORD_SET.has(first.toLowerCase());
    }

    // 阶段1行级预编译: 加载期把一行命令分类为结构化语句 (数字类型 + 预拼接参数)。
    // 分类判定与旧 isKeywordCommand 完全一致 (indexOf(' ') 取首 token, 兼容制表符行为);
    // 关键字行参数与旧 switch 的 split(/\s+/).slice(1).join(' ') 完全一致。
    private static classifyLine(content: string): LineStmt {
        const sp = content.indexOf(' ');
        const first = sp === -1 ? content : content.substring(0, sp);
        if (!Interpreter.KEYWORD_SET.has(first.toLowerCase())) {
            return { type: StmtType.OP, params: '' };
        }
        const parts = content.split(/\s+/);
        const cmd = parts[0].toLowerCase();
        const params = parts.slice(1).join(' ');
        switch (cmd) {
            case 'global': return { type: StmtType.GLOBAL, params };
            case 'local': return { type: StmtType.LOCAL, params };
            case 'call': return { type: StmtType.CALL, params };
            case 'return': return { type: StmtType.RETURN, params };
            case 'jump': return { type: StmtType.JUMP, params };
            case 'print': return { type: StmtType.PRINT, params };
            case 'if': return { type: StmtType.IF, params };
            case 'else': return { type: StmtType.ELSE, params: '' };
            case 'endif': return { type: StmtType.ENDIF, params: '' };
            case 'while': return { type: StmtType.WHILE, params };
            case 'endwhl': return { type: StmtType.ENDWHL, params: '' };
            case 'for': return { type: StmtType.FOR, params };
            case 'endfor': return { type: StmtType.ENDFOR, params: '' };
            case 'break': return { type: StmtType.BREAK, params: '' };
            case 'continue': return { type: StmtType.CONTINUE, params: '' };
            case 'try': return { type: StmtType.TRY, params: '' };
            case 'catch': return { type: StmtType.CATCH, params };
            case 'endtry': return { type: StmtType.ENDTRY, params: '' };
            case 'assert': return { type: StmtType.ASSERT, params };
            case 'endasrt': return { type: StmtType.ENDASRT, params: '' };
            case 'switch': return { type: StmtType.SWITCH, params };
            case 'case': return { type: StmtType.CASE, params };
            case 'default': return { type: StmtType.DEFAULT, params: '' };
            case 'endswc': return { type: StmtType.ENDSWC, params: '' };
            case 'purge': return { type: StmtType.PURGE, params };
            case ':end': return { type: StmtType.END_TAG, params: '' };
            case 'const':
                // const + global/local → 语法错误 (与旧 executeCommand 前置检查一致); 其他 const 前缀行 → OP (executeOperation 整行)
                if (parts.length > 1 && (parts[1].toLowerCase() === 'global' || parts[1].toLowerCase() === 'local')) {
                    return { type: StmtType.CONST_PREFIX_ERROR, params: '' };
                }
                return { type: StmtType.OP, params: '' };
            default:
                // 集合内但未显式列出的关键字: 与旧 switch 的 default 分支一致 → executeOperation(整行)
                return { type: StmtType.OP, params: '' };
        }
    }

    static executeCommand(stmt: LineStmt, content: string): void {
        DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_execute_instr', { content }));
        // 数字类型分发 (阶段1: 行级预编译), 替代旧"split + 首关键字字符串 switch"路径
        switch (stmt.type) {
            case StmtType.OP:
                Interpreter.executeOperation(content);
                return;
            case StmtType.GLOBAL:
                Interpreter.executeGlobal(stmt.params);
                return;
            case StmtType.LOCAL:
                Interpreter.executeLocal(stmt.params);
                return;
            case StmtType.CALL:
                Interpreter.executeCall(stmt.params);
                return;
            case StmtType.RETURN:
                Interpreter.executeReturn(stmt.params);
                return;
            case StmtType.JUMP:
                Interpreter.executeJump(stmt.params);
                return;
            case StmtType.PRINT:
                Interpreter.executePrint(stmt.params);
                return;
            case StmtType.IF:
                Interpreter.executeIf(stmt.params);
                return;
            case StmtType.ELSE:
                Interpreter.executeElse();
                return;
            case StmtType.ENDIF:
                // 弹出if控制块
                if (CONTROL_FLOW_STACK.length > 0 && CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1].type === 'if') {
                    CONTROL_FLOW_STACK.pop();
                }
                return;
            case StmtType.WHILE:
                Interpreter.executeWhile(stmt.params);
                return;
            case StmtType.ENDWHL:
                Interpreter.executeEndWhile();
                return;
            case StmtType.FOR:
                Interpreter.executeFor(stmt.params);
                return;
            case StmtType.ENDFOR:
                Interpreter.executeEndFor();
                return;
            case StmtType.BREAK:
                Interpreter.executeBreak();
                return;
            case StmtType.CONTINUE:
                Interpreter.executeContinue();
                return;
            case StmtType.TRY:
                Interpreter.executeTry();
                return;
            case StmtType.CATCH:
                Interpreter.executeCatch(stmt.params);
                return;
            case StmtType.ENDTRY:
                Interpreter.executeEndTry();
                return;
            case StmtType.ASSERT:
                Interpreter.executeAssert(stmt.params);
                return;
            case StmtType.ENDASRT:
                return; // 无需特殊处理
            case StmtType.SWITCH:
                Interpreter.executeSwitch(stmt.params);
                return;
            case StmtType.CASE:
                Interpreter.executeCase(stmt.params);
                return;
            case StmtType.DEFAULT:
                Interpreter.executeDefault();
                return;
            case StmtType.ENDSWC:
                Interpreter.executeEndSwitch();
                return;
            case StmtType.PURGE:
                Interpreter.executePurge(stmt.params);
                return;
            case StmtType.END_TAG:
                Interpreter.executeFunctionEndTag();
                return;
            case StmtType.CONST_PREFIX_ERROR:
                reportError(ExceptionType.SYNTAX_ERROR, t('var_decl_global_local_format'));
                return;
            default:
                // 兜底: 与旧 default 分支一致 (变量赋值/表达式)
                Interpreter.executeOperation(content);
                return;
        }
    }

    // 执行全局变量声明
    static executeGlobal(params: string): void {
        // 检查是否是常量, const必须在global后面
        let isConst = false;
        let remainingParams = params;

        // 匹配格式: [const] 变量名:类型 = 值
        const constMatch = params.match(/^const\s+(.+)$/);
        if (constMatch) {
            isConst = true;
            remainingParams = constMatch[1];
        }

        // 检查是否是数组声明
        if (remainingParams.startsWith('array ')) {
            Interpreter.executeArrayDeclaration(remainingParams.substring(6).trim(), true, isConst);
            return;
        }

        // 匹配格式: 变量名:类型 = 值 (值可选, 未赋初值则为 undefined)
        const match = remainingParams.match(/^([a-zA-Z0-9_]+):([a-zA-Z0-9_]+)\s*(?:=\s*(.+))?$/);
        if (!match) {
            reportError(ExceptionType.SYNTAX_ERROR, t('var_decl_global_format'));
            return;
        }

        const varName = match[1];

        // 检查变量名是否符合C语言命名规则
        if (!Interpreter.isValidIdentifier(varName)) {
            reportError(ExceptionType.REFERENCE_ERROR, t('var_name_invalid', {name: varName}));
            return;
        }
        const typeStr = match[2];
        const valueExpr = match[3];
        const type = Interpreter.getDataTypeFromString(typeStr);

        // 检查是否在代码块内
        if (CONTROL_FLOW_STACK.length !== 0) {
            reportError(ExceptionType.REFERENCE_ERROR, t('global_var_in_block'));
            return;
        }

        try {
            let value: any = undefined;
            if (valueExpr !== undefined) {
                value = Interpreter.parseInitValue(valueExpr, type);
                if (value === undefined || value === null) {
                    throw {
                        type: ExceptionType.TYPE_ERROR,
                        message: t('type_conversion_failed', {value: valueExpr, type: typeStr}),
                        lineNumber: currentLinePointer + 1
                    } as Exception;
                }
            }

            ScopeManager.addVariable(varName, value, type, currentLinePointer, -1, true, isConst);
        } catch (error) {
            const exception = error as Exception;
            debugLog(1, () => t('dbg_exception_msg', { message: exception.message }));
            return;
        }
    }

    // 执行局部变量声明
    static executeLocal(params: string): void {
        // 检查是否是常量, const必须在local后面
        let isConst = false;
        let remainingParams = params;

        // 匹配格式: [const] 变量名:类型 = 值
        const constMatch = params.match(/^const\s+(.+)$/);
        if (constMatch) {
            isConst = true;
            remainingParams = constMatch[1];
        }

        // 检查是否是数组声明
        if (remainingParams.startsWith('array ')) {
            Interpreter.executeArrayDeclaration(remainingParams.substring(6).trim(), false, isConst);
            return;
        }

        // 匹配格式: 变量名:类型 = 值 (值可选, 未赋初值则为 undefined)
        const match = remainingParams.match(/^([a-zA-Z0-9_]+):([a-zA-Z0-9_]+)\s*(?:=\s*(.+))?$/);
        if (!match) {
            reportError(ExceptionType.SYNTAX_ERROR, t('var_decl_local_format'));
            return;
        }

        const varName = match[1];

        // 检查变量名是否符合C语言命名规则
        if (!Interpreter.isValidIdentifier(varName)) {
            reportError(ExceptionType.REFERENCE_ERROR, t('var_name_invalid', {name: varName}));
            return;
        }
        const typeStr = match[2];
        const valueExpr = match[3];
        const type = Interpreter.getDataTypeFromString(typeStr);
        const value = valueExpr !== undefined ? Interpreter.parseInitValue(valueExpr, type) : undefined;

        const startLine = currentLinePointer;
        let endLine = startLine;
        // 检查所在的代码块
        let targetEndTag: string;
        if (CONTROL_FLOW_STACK.length === 0) {
            reportError(ExceptionType.REFERENCE_ERROR, t('local_var_outside_block'));
            return;
        }
        const block = CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1];
        debugLog(1, () => t('dbg_block_type'), block.type);
        switch (block.type) {
            case 'if':
                targetEndTag = 'endif';
                break;
            case 'for':
                targetEndTag = 'endfor';
                break;
            case 'while':
                targetEndTag = 'endwhl';
                break;
            case 'switch':
                targetEndTag = 'endswc';
                break;
            case 'try':
                targetEndTag = 'endtry';
                break;
            case 'function':
                targetEndTag = ':end';
                break;
            default:
                targetEndTag = '';
                debugLog(1, () => t('dbg_switch_default'));
                break;
        }
        let j = currentLinePointer + 1;
        let nestedLevel = 1;
        while (j < programLines.length) {
            const line = programLines[j].trim();
            if (line.startsWith(block.type + ' ')) {
                nestedLevel++;
            } else if (line === targetEndTag) { // 用全等是这些标签后无参数
                nestedLevel--;
                if (nestedLevel === 0) {
                    endLine = j; // 返回标签位置无需减1
                }
            }
            j++;
        }

        // 循环变量作用域内禁止声明同名变量 (doc规则2)
        // 从栈顶向下查找: 先遇到 function 帧说明声明位于函数内, 不受外层循环约束; 否则遇到匹配的 for 帧即报错
        for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
            const block = CONTROL_FLOW_STACK[i];
            if (block.type === 'function') break;
            if (block.type === 'for' && block.varName === varName) {
                reportError(ExceptionType.REFERENCE_ERROR, t('loop_var_shadow_forbidden', {name: varName}));
                return;
            }
        }

        try {
            ScopeManager.addVariable(varName, value, type, startLine, endLine, false, isConst);
        } catch (error) {
            const exception = error as Exception;
            debugLog(1, () => t('dbg_exception_msg', { message: exception.message }));
            return;
        }
        rebuildSlotIndex(); // 槽位索引同步 (局部变量声明批次完成)
    }

    // 执行函数调用
    static executeCall(params: string): void {
        debugLog(1, () => t('dbg_start_func_call', { params }));
        // 匹配格式: 函数名(参数1, 参数2, ...) -> 结果变量 或 函数名(参数1, 参数2, ...)
        // 用 indexOf('->') 预判分支, 只跑一个正则 (热路径: 每次调用都做)
        let funcName: string;
        let argsStr: string;
        let resultVar: string | undefined;
        if (params.indexOf('->') !== -1) {
            // 支持点分函数名 (String.split / 未来模块函数 xxx.func)
            const matchWithResult = params.match(/^([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\((.*)\)\s*->\s*([a-zA-Z0-9_]+)$/);
            if (matchWithResult) {
                funcName = matchWithResult[1];
                argsStr = matchWithResult[2];
                resultVar = matchWithResult[3];
            } else {
                reportError(ExceptionType.SYNTAX_ERROR, t('call_format'));
                return;
            }
        } else {
            const matchWithoutResult = params.match(/^([a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)*)\((.*)\)$/);
            if (matchWithoutResult) {
                funcName = matchWithoutResult[1];
                argsStr = matchWithoutResult[2];
                resultVar = undefined;
            } else {
                reportError(ExceptionType.SYNTAX_ERROR, t('call_format'));
                return;
            }
        }

        if (!FUNCTIONS[funcName]) {
            // 内置点分函数快速通道: 当前仅 String.split (定长容器填充语义, 需 mut 数组容器 + 段数返回, 表达式路径无法承载)
            if (funcName === 'String.split') {
                Interpreter.executeBuiltinSplit(argsStr, resultVar);
                return;
            }
            // 函数未定义: 抛引用错误 (可被try-catch捕获)
            throw {
                type: ExceptionType.REFERENCE_ERROR,
                message: t('func_undefined', {name: funcName}),
                lineNumber: currentLinePointer
            } as Exception;
        }

        const funcInfo = FUNCTIONS[funcName];
        debugLog(2, () => t('dbg_func_info'), funcInfo);

        // 检查返回值变量
        if (resultVar === undefined && funcInfo.returnType !== DataType.UNDEFINED) {
            reportError(ExceptionType.TYPE_ERROR, t('func_result_var_missing', {name: funcName}));
            return;
        }

        if (resultVar !== undefined && funcInfo.returnType === DataType.UNDEFINED) {
            reportError(ExceptionType.TYPE_ERROR, t('func_result_var_unexpected', {name: funcName}));
            return;
        }

        // 解析参数
        const args: any[] = [];
        // 数组实参辅助: 支持 数组名 / mut 数组名 / copy(数组名) / [元素字面量] 四种形式
        const parseArrayArgument = (argStr: string): { mode: 'ref' | 'mut' | 'copy' | 'literal'; name: string } | null => {
            const trimmed = argStr.trim();
            if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                return { mode: 'literal', name: trimmed };
            }
            const copyMatch = trimmed.match(/^copy\s*\(\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\)$/);
            if (copyMatch) return { mode: 'copy', name: copyMatch[1] };
            const mutMatch = trimmed.match(/^mut\s+([a-zA-Z_][a-zA-Z0-9_.]*)$/);
            if (mutMatch) return { mode: 'mut', name: mutMatch[1] };
            const refMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_.]*)$/);
            if (refMatch) return { mode: 'ref', name: refMatch[1] };
            return null;
        };
        // 推断数组字面量元素的值与类型
        const inferLiteralElement = (elementStr: string): ArrayElement => {
            const es = elementStr.trim();
            if (es.startsWith('"') && es.endsWith('"')) {
                return { value: es.slice(1, -1), type: DataType.STRING };
            }
            if (es === 'true') return { value: true, type: DataType.BOOL };
            if (es === 'false') return { value: false, type: DataType.BOOL };
            const num = Number(es);
            // 整数字面量推断 INT, 小数推断 FLOAT (与语言 int/float 显式区分一致)
            if (es !== '' && !isNaN(num) && isFinite(num)) return { value: num, type: Number.isInteger(num) ? DataType.INT : DataType.FLOAT };
            throw { type: ExceptionType.SYNTAX_ERROR, message: t('array_literal_element_unresolvable', {value: es}) } as Exception;
        };
        // 拆分调用实参: 正确忽略数组字面量 [...] 内部与字符串内部的逗号
        const splitCallArguments = (s: string): string[] => {
            const parts: string[] = [];
            let depth = 0;
            let cur = '';
            let inString = false;
            let delimiter = '';
            for (let i = 0; i < s.length; i++) {
                const c = s[i];
                if (!inString && (c === '"' || c === "'")) { inString = true; delimiter = c; cur += c; }
                else if (inString && c === delimiter) { inString = false; cur += c; }
                else if (!inString && c === '[') { depth++; cur += c; }
                else if (!inString && c === ']') { depth--; cur += c; }
                else if (!inString && c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
                else cur += c;
            }
            if (cur.trim()) parts.push(cur.trim());
            return parts;
        };
        if (argsStr.trim()) {
            const argValues = splitCallArguments(argsStr);
            if (argValues.length < funcInfo.params.length) {
                reportError(ExceptionType.TYPE_ERROR, t('func_arg_count_insufficient', {name: funcName, expected: funcInfo.params.length, actual: argValues.length}));
                return;
            } else if (argValues.length > funcInfo.params.length) {
                reportWarn(t('func_extra_args_ignored', {name: funcName}));
            }

            // 只解析前 funcInfo.params.length 个实参 (多余参数已被忽略, 避免越界)
            const argCount = Math.min(argValues.length, funcInfo.params.length);
            for (let i = 0; i < argCount; i++) {
                const param = funcInfo.params[i];
                const paramType = param.type;
                try {
                    if (paramType === DataType.ARRAY) {
                        const arrArg = parseArrayArgument(argValues[i]);
                        if (!arrArg) {
                            reportError(ExceptionType.TYPE_ERROR, t('func_array_arg_format', {name: funcName, argIndex: i + 1}));
                            return;
                        }
                        // mut 匹配检查: 形参与实参必须一致
                        if (param.isMutable && arrArg.mode !== 'mut' && arrArg.mode !== 'copy') {
                            reportError(ExceptionType.TYPE_ERROR, t('func_mut_param_requires_mut', {name: param.name}));
                            return;
                        }
                        if (!param.isMutable && arrArg.mode === 'mut') {
                            reportError(ExceptionType.TYPE_ERROR, t('func_readonly_param_no_mut', {name: param.name}));
                            return;
                        }
                        args.push(arrArg);
                    } else {
                        const value = Interpreter.parseValue(argValues[i], paramType);
                        args.push(value);
                    }
                } catch (error) {
                    // 实参表达式中的 input() 挂起信号穿透 (如 call f(input()))
                    if (isInputSuspend(error)) throw error;
                    reportError(ExceptionType.TYPE_ERROR, t('func_arg_type_error', {name: funcName, argIndex: i + 1}));
                    return;
                }
            }
        } else if (funcInfo.params.length > 0) {
            reportError(ExceptionType.TYPE_ERROR, t('func_arg_count_missing', {name: funcName, expected: funcInfo.params.length}));
            return;
        }

        // 保存调用所在行号
        const oldLinePointer = currentLinePointer;

        // 为本次调用分配唯一帧ID (递归时用于隔离各调用帧的局部变量)
        const frameId = ++CALL_FRAME_ID;

        // 传递参数 - 修正行号范围
        debugLog(2, () => t('dbg_func_start_passing', { funcName }));
        debugLog(2, () => t('dbg_func_info'), funcInfo);
        debugLog(2, () => t('dbg_param_count', { count: funcInfo.params.length }), args);
        debugLog(2, () => t('dbg_param_loop_start'));
        debugLog(2, () => t('dbg_func_call_args', { funcName }), args, () => t('dbg_curr_line', { line: currentLinePointer + 1 }));
        // 记录本帧首个局部变量位置 (返回时截断 LOCAL_VARS 到该位置清理本帧变量)
        const callVarStart = LOCAL_VARS.length;
        for (let i = 0; i < funcInfo.params.length; i++) {
            debugLog(3, () => t('dbg_loop_index', { i }));
            const param = funcInfo.params[i];
            const paramName = param.name;
            debugLog(2, () => t('dbg_set_param', { paramName, paramType: param.type }));

            if (param.type === DataType.ARRAY) {
                // 数组参数: 绑定引用/副本/字面量
                const arrArg = args[i] as { mode: 'ref' | 'mut' | 'copy' | 'literal'; name: string };

                if (arrArg.mode === 'literal') {
                    // 从字面量创建临时数组 (只读视图)
                    const elementsStr = arrArg.name.slice(1, -1);
                    const elementStrs = Interpreter.splitArrayElements(elementsStr);
                    let literalElements: ArrayElement[] = [];
                    try {
                        literalElements = elementStrs.map(es => inferLiteralElement(es));
                    } catch (e) {
                        reportError(ExceptionType.TYPE_ERROR, t('array_literal_arg_parse_failed', {error: (e as Error).message}));
                        LOCAL_VARS = LOCAL_VARS.filter(v => v.frameId !== frameId);
                        rebuildSlotIndex();
                        return;
                    }
                    // 元素类型校验: 字面量推断类型须与形参声明一致 (数组形参声明了元素类型时)
                    if (param.arrayElementType !== undefined && literalElements.length > 0) {
                        const actualElemType = literalElements[0].type;
                        if (!Interpreter.canArrayElementFit(actualElemType, param.arrayElementType)) {
                            reportError(ExceptionType.TYPE_ERROR, t('array_elem_type_mismatch', { expected: param.arrayElementType, actual: actualElemType }));
                            LOCAL_VARS = LOCAL_VARS.filter(v => v.frameId !== frameId);
                            rebuildSlotIndex();
                            return;
                        }
                    }
                    const literalVar: Variable = {
                        name: paramName,
                        value: "请使用arrayElements属性访问数组元素",
                        type: DataType.ARRAY,
                        isGlobal: false,
                        isConst: false,
                        startLine: funcInfo.startLine + 1,
                        endLine: funcInfo.endLine,
                        frameId: frameId,
                        arrayLength: literalElements.length,
                        arrayElementType: literalElements.length > 0 ? literalElements[0].type : DataType.NUMBER,
                        arrayElements: literalElements,
                        isReadonlyArray: true
                    };
                    LOCAL_VARS.push(literalVar);
                    (SLOT_INDEX[String(frameId)] || (SLOT_INDEX[String(frameId)] = {}))[i] = literalVar;
                    debugLog(2, () => t('dbg_array_param_literal', { paramName, length: literalElements.length }));
                    continue;
                }

                const arrVar = ScopeManager.getVariable(arrArg.name, currentLinePointer, true, arrArg.name.startsWith('global.'));
                if (!arrVar || arrVar.type !== DataType.ARRAY) {
                    reportError(ExceptionType.TYPE_ERROR, t('arr_arg_not_array', {name: arrArg.name}));
                    LOCAL_VARS = LOCAL_VARS.filter(v => v.frameId !== frameId);
                    rebuildSlotIndex();
                    return;
                }
                // 元素类型校验: 实参数组元素类型须与形参声明一致
                if (param.arrayElementType !== undefined && arrVar.arrayElementType !== undefined &&
                    !Interpreter.canArrayElementFit(arrVar.arrayElementType, param.arrayElementType)) {
                    reportError(ExceptionType.TYPE_ERROR, t('array_elem_type_mismatch', { expected: param.arrayElementType, actual: arrVar.arrayElementType }));
                    LOCAL_VARS = LOCAL_VARS.filter(v => v.frameId !== frameId);
                    rebuildSlotIndex();
                    return;
                }
                const paramVar: Variable = {
                    name: paramName,
                    value: "请使用arrayElements属性访问数组元素",
                    type: DataType.ARRAY,
                    isGlobal: false,
                    isConst: false,
                    startLine: funcInfo.startLine + 1,
                    endLine: funcInfo.endLine,
                    frameId: frameId,
                    arrayLength: arrVar.arrayLength,
                    arrayElementType: arrVar.arrayElementType,
                    // copy 模式深拷贝元素; 引用模式共享同一数组对象
                    arrayElements: arrArg.mode === 'copy'
                        ? arrVar.arrayElements!.map((e: ArrayElement) => ({ value: e.value, type: e.type }))
                        : arrVar.arrayElements,
                    // copy 模式: 副本独立于调用方, 视图恒可写; 引用模式: 只读形参 → 只读视图, mut形参 → 可变视图
                    isReadonlyArray: arrArg.mode === 'copy' ? false : !param.isMutable
                };
                LOCAL_VARS.push(paramVar);
                (SLOT_INDEX[String(frameId)] || (SLOT_INDEX[String(frameId)] = {}))[i] = paramVar;
                debugLog(2, () => t('dbg_array_param_bound', { paramName, mode: arrArg.mode, length: arrVar.arrayLength, readonly: paramVar.isReadonlyArray }));
                continue;
            }

            const argValue = args[i] !== undefined ? args[i] : null;
            // 槽位绑定: 参数槽位 = 参数顺序索引 (与静态建表一致), 跳过线性查重 + 免后续 indexSlotVar
            ScopeManager.addVariable(paramName, argValue, param.type, funcInfo.startLine + 1, funcInfo.endLine, false, false, frameId, i);
            debugLog(2, () => t('dbg_param_bound_slot', { paramName, slot: i }));
        }
        debugLog(2, () => t('dbg_param_loop_end'));

        // 如果是有返回值的函数, 在调用位置声明返回值变量
        // 设置currentLinePointer为函数体开始行, 准备执行函数
        // 函数体开始行是函数定义行后的第一行非标签行
        let functionBodyStartLine = funcInfo.startLine + 1;
        // 跳过可能存在的标签行或其他非执行行
        while (functionBodyStartLine < funcInfo.endLine) {
            const checkLine = programLines[functionBodyStartLine].trim();
            // 如果是标签行或空行, 继续下一行
            if (checkLine === '' || checkLine.indexOf(':') === 0) {
                functionBodyStartLine++;
                continue;
            }
            break;
        }

        let returnVarName: string | undefined;
        if (funcInfo.returnType !== DataType.UNDEFINED) {
            // 返回值变量名在函数解析时已缓存 (funcInfo.returnVarName), 免每次调用重复正则解析定义行
            returnVarName = funcInfo.returnVarName;
            if (returnVarName !== undefined) {
                // 将返回值变量添加到函数的局部作用域中
                // 初始化为 undefined (doc规则13: 函数返回值变量会被初始化为undefined)
                // 作用域从函数体开始行到函数结束行; 槽位 = 参数个数 (与静态建表一致, 跳过线性查重)
                ScopeManager.addVariable(returnVarName, undefined, funcInfo.returnType, functionBodyStartLine, funcInfo.endLine, false, false, frameId, funcInfo.params.length, funcInfo.returnArrayElementType);
            }
        }
        debugLog(3, () => t('dbg_current_local_var_details'), LOCAL_VARS);
        debugLog(2, () => t('dbg_func_param_done', { funcName }));

        // 额外的调试信息, 检查参数是否真的被添加
        debugLog(3, () => t('dbg_check_params_added'));
        for (let i = 0; i < funcInfo.params.length; i++) {
            const paramName = funcInfo.params[i].name;
            let found = false;
            for (let j = 0; j < LOCAL_VARS.length; j++) {
                if (LOCAL_VARS[j].name === paramName) {
                    debugLog(3, () => t('dbg_param_index', { paramName, index: j }));
                    found = true;
                    break;
                }
            }
            if (!found) {
                debugLog(3, () => t('dbg_param_not_found', { paramName }));
            }
        }

        // 进一步调试: 检查每个参数在LOCAL_VARS中的详细信息
        debugLog(3, () => t('dbg_check_params_detail'));
        for (let i = 0; i < funcInfo.params.length; i++) {
            const paramName = funcInfo.params[i].name;
            const paramType = funcInfo.params[i].type;
            let paramFound = false;
            for (let j = 0; j < LOCAL_VARS.length; j++) {
                if (LOCAL_VARS[j].name === paramName) {
                    debugLog(3, () => t('dbg_param_detail', { paramName, index: j, value: LOCAL_VARS[j].value, type: LOCAL_VARS[j].type, scopeStart: LOCAL_VARS[j].startLine + 1, scopeEnd: LOCAL_VARS[j].endLine === -1 ? t('dbg_last_line') : LOCAL_VARS[j].endLine + 1 }));
                    // 验证类型是否匹配
                    if (LOCAL_VARS[j].type !== paramType) {
                        debugLog(3, () => t('dbg_warn_param_type', { paramName, expected: paramType, actual: LOCAL_VARS[j].type }));
                    }
                    paramFound = true;
                    break;
                }
            }
            if (!paramFound) {
                debugLog(3, () => t('dbg_param_not_found', { paramName }));
            }
        }

        currentLinePointer = funcInfo.startLine; // 主循环会自动加一执行函数体内部的代码
        debugLog(2, () => t('dbg_func_body_start', { line: functionBodyStartLine + 1 }));
        // 添加作用域调试信息
        debugLog(2, () => t('dbg_func_scope_details', { funcName }));
        debugLog(2, () => t('dbg_return_var_scope', { name: returnVarName, scopeStart: functionBodyStartLine + 1, scopeEnd: funcInfo.endLine === -1 ? t('dbg_last_line') : funcInfo.endLine + 1 }));
        debugLog(2, () => t('dbg_param_scope', { scopeStart: functionBodyStartLine + 1, scopeEnd: funcInfo.endLine === -1 ? t('dbg_last_line') : funcInfo.endLine + 1 }));
        CONTROL_FLOW_STACK.push({
            type: 'function',
            funcName: funcInfo.name,
            startLine: funcInfo.startLine,
            endLine: funcInfo.endLine,
            callFrom: oldLinePointer,
            returnVarName: resultVar,
            frameId: frameId,
            frameVarStart: callVarStart
        });
        debugLog(2, () => t('dbg_control_flow_stack'), CONTROL_FLOW_STACK);
    }

    // ============ String.split 定长容器填充 (call 语句专属通道) ============
    // 形态: call String.split(源串, 分隔符, mut 容器数组) -> 段数
    // 语言无动态数组且表达式仅返回标量, 故 split 不走表达式; 容器由调用方声明定长 (容量=段数上限),
    // split 填充容器并返回实际段数, 段数超容量抛 RangeError (可被 try-catch 捕获)。
    // 与栈模块元数据槽模式同构 (design.md §8/§9.3 方案 A)。
    private static executeBuiltinSplit(argsStr: string, resultVar: string | undefined): void {
        if (resultVar === undefined) {
            reportError(ExceptionType.TYPE_ERROR, t('func_result_var_missing', {name: 'String.split'}));
            return;
        }
        // 拆分实参: 忽略字符串字面量内部的逗号
        const parts: string[] = [];
        let cur = '';
        let inString = false;
        for (let i = 0; i < argsStr.length; i++) {
            const c = argsStr[i];
            if (c === '"') { inString = !inString; cur += c; }
            else if (c === ',' && !inString) { parts.push(cur.trim()); cur = ''; }
            else cur += c;
        }
        if (cur.trim()) parts.push(cur.trim());
        if (parts.length !== 3) {
            throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_3_args', {func: 'String.split'}), lineNumber: currentLinePointer } as Exception;
        }
        // 源字符串与分隔符: 字面量或 string 变量
        let source: string;
        let delim: string;
        try {
            source = String(Interpreter.parseValue(parts[0], DataType.STRING));
            delim = String(Interpreter.parseValue(parts[1], DataType.STRING));
        } catch (e) {
            throw { type: ExceptionType.TYPE_ERROR, message: t('func_arg_type_error', {name: 'String.split', argIndex: 1}), lineNumber: currentLinePointer } as Exception;
        }
        // 容器数组: 仅接受 mut 数组名 (写穿容器)
        const arrMatch = parts[2].match(/^mut\s+([a-zA-Z_][a-zA-Z0-9_.]*)$/);
        if (!arrMatch) {
            throw { type: ExceptionType.TYPE_ERROR, message: t('func_array_arg_format', {name: 'String.split', argIndex: 3}), lineNumber: currentLinePointer } as Exception;
        }
        const container = ScopeManager.getVariable(arrMatch[1], currentLinePointer, true, arrMatch[1].startsWith('global.'));
        if (!container || container.type !== DataType.ARRAY) {
            reportError(ExceptionType.TYPE_ERROR, t('arr_arg_not_array', {name: arrMatch[1]}));
            return;
        }
        if (container.arrayElementType !== undefined && container.arrayElementType !== DataType.STRING) {
            reportError(ExceptionType.TYPE_ERROR, t('array_elem_type_mismatch', { expected: DataType.STRING, actual: container.arrayElementType }));
            return;
        }
        if (container.isConst) {
            throw { type: ExceptionType.TYPE_ERROR, message: t('const_array_assignment', {name: container.name}), lineNumber: currentLinePointer } as Exception;
        }
        if (container.isReadonlyArray) {
            throw { type: ExceptionType.TYPE_ERROR, message: t('readonly_array_assignment', {name: container.name}), lineNumber: currentLinePointer } as Exception;
        }
        const segs = source.split(delim);
        const capacity = container.arrayLength || 0;
        if (segs.length > capacity) {
            throw { type: ExceptionType.RANGE_ERROR, message: t('func_split_overflow', {func: 'String.split', count: segs.length, capacity}), lineNumber: currentLinePointer } as Exception;
        }
        container.arrayElements = segs.map(s => ({ value: s, type: DataType.STRING }));
        container.arrayLength = segs.length;
        // 段数写回结果变量 (未声明则自动创建 int, 与用户函数返回值路径一致)
        if (!ScopeManager.hasVariable(resultVar, currentLinePointer)) {
            const rvIdx = LOCAL_VARS.length;
            ScopeManager.addVariable(resultVar, 0, DataType.INT, currentLinePointer, -1, false);
            if (LOCAL_VARS.length > rvIdx) indexSlotVar(LOCAL_VARS[rvIdx]);
        }
        ScopeManager.setVariable(resultVar, segs.length, currentLinePointer);
    }

    // 执行数组声明
    static executeArrayDeclaration(params: string, isGlobal: boolean, isConst: boolean): void {
        debugLog(3, () => t('dbg_exec_array_decl', { scope: isGlobal ? t('dbg_scope_global') : t('dbg_scope_local'), kind: isConst ? t('dbg_kind_const') : t('dbg_kind_var'), params }));
        // 匹配格式: arrName[arrLength]:type = {...} 或 arrName[arrLength]:type = arrfill
        const arrayMatch = params.match(/^([a-zA-Z0-9_]+)\[([^\]]+)\]:([a-zA-Z0-9_]+)\s*=\s*(.+)$/);
        if (!arrayMatch) {
            reportError(ExceptionType.SYNTAX_ERROR, t('array_decl_format'));
            return;
        }

        const arrayName = arrayMatch[1];

        // 检查数组名是否符合C语言命名规则
        if (!Interpreter.isValidIdentifier(arrayName)) {
            reportError(ExceptionType.REFERENCE_ERROR, t('array_name_invalid', {name: arrayName}));
            return;
        }

        const lengthExpr = arrayMatch[2];
        const elementTypeStr = arrayMatch[3];
        const initValue = arrayMatch[4].trim();

        // 获取数组长度
        let arrayLength: number;
        try {
            // 尝试解析长度表达式 (支持数字字面量、全局常量或表达式, 如 ROWS * COLS)
            const lengthValue = Interpreter.evaluateExpression(lengthExpr);
            if (typeof lengthValue !== 'number' || !Number.isInteger(lengthValue) || lengthValue < 0) {
                reportError(ExceptionType.RANGE_ERROR, t('array_length_non_negative'));
                return;
            }
            arrayLength = lengthValue;
        } catch (error) {
            // 长度表达式中的 input() 挂起信号穿透 (如 global array a[input()]:int)
            if (isInputSuspend(error)) throw error;
            reportError(ExceptionType.SYNTAX_ERROR, t('array_length_expr_unresolvable', {expr: lengthExpr}));
            return;
        }

        // 获取元素类型
        const elementType = Interpreter.getDataTypeFromString(elementTypeStr);

        // 检查元素类型是否有效
        if (elementType === DataType.UNDEFINED) {
            reportError(ExceptionType.SYNTAX_ERROR, t('array_element_type_unsupported', {type: elementTypeStr}));
            return;
        }

        // 检查元素类型是否为不允许的类型
        if (elementType === DataType.ARRAY) {
            reportError(ExceptionType.SYNTAX_ERROR, t('array_of_array_forbidden'));
            return;
        }

        // 初始化数组元素
        const arrayElements: ArrayElement[] = [];

        // 处理arrfill关键字
        if (initValue === 'arrfill') {
            debugLog(2, () => t('dbg_array_arrfill', { arrayName }));
            let fillValue: any;
            switch (elementType) {
                case DataType.NUMBER:
                    reportWarn(t('array_number_fill_0'));
                    fillValue = 0.0;
                    break;
                case DataType.INT:
                    fillValue = 0;
                    break;
                case DataType.FLOAT:
                    fillValue = 0.0;
                    break;
                case DataType.STRING:
                    fillValue = "";
                    break;
                case DataType.BOOL:
                    fillValue = false;
                    break;
                default:
                    reportError(ExceptionType.SYNTAX_ERROR, t('array_element_type_unsupported', {type: elementTypeStr}));
                    return;
            }

            // 填充数组
            for (let i = 0; i < arrayLength; i++) {
                arrayElements.push({
                    value: fillValue,
                    type: elementType
                });
            }
            debugLog(2, () => t('dbg_array_fill_done'));
        } else if (initValue.startsWith('[') && initValue.endsWith(']')) {
            debugLog(2, () => t('dbg_array_manual_init', { arrayName }));
            // 处理手动初始化
            const elementsStr = initValue.substring(1, initValue.length - 1).trim();
            let elementValues: string[] = [];

            if (elementsStr) {
                // 分割元素, 考虑字符串中的逗号
                elementValues = Interpreter.splitArrayElements(elementsStr);
            }

            // 检查元素数量是否匹配
            if (elementValues.length !== arrayLength) {
                reportError(ExceptionType.RANGE_ERROR, t('array_init_count_mismatch', {actual: elementValues.length, expected: arrayLength}));
                return;
            }

            // 解析每个元素
            for (let i = 0; i < elementValues.length; i++) {
                try {
                    const elementValue = Interpreter.parseInitValue(elementValues[i].trim(), elementType);
                    arrayElements.push({
                        value: elementValue,
                        type: elementType
                    });
                } catch (error) {
                    reportError(ExceptionType.SYNTAX_ERROR, t('array_element_unresolvable', {index: i, value: elementValues[i]}));
                    return;
                }
            }
        } else {
            reportError(ExceptionType.SYNTAX_ERROR, t('array_init_format'));
            return;
        }

        // 创建数组变量
        // 局部数组: 从控制流栈取最近函数帧的结束行与帧ID (递归时隔离不同调用帧; FUNCTION_SCOPES已废弃不可用)
        let localEndLine = -1;
        let localFrameId: number | undefined;
        if (!isGlobal) {
            for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
                const block = CONTROL_FLOW_STACK[i];
                if (block.type === 'function') {
                    localEndLine = block.endLine;
                    localFrameId = block.frameId;
                    break;
                }
            }
        }
        const arrayVariable: Variable = {
            name: arrayName,
            value: "请使用arrayElements属性访问数组元素", // 数组变量的值不适用直接访问
            type: DataType.ARRAY,
            isGlobal: isGlobal,
            isConst: isConst,
            startLine: currentLinePointer,
            endLine: isGlobal ? -1 : localEndLine,
            frameId: localFrameId,
            arrayLength: arrayLength,
            arrayElementType: elementType,
            arrayElements: arrayElements
        };

        // 添加到作用域管理器
        if (isGlobal) {
            // 检查全局变量是否已存在
            if (GLOBAL_VARS.hasOwnProperty(arrayName)) {
                reportError(ExceptionType.REFERENCE_ERROR, t('name_already_defined', {name: arrayName}));
                return;
            }
            GLOBAL_VARS[arrayName] = arrayVariable;
        } else {
            // 检查是否在函数内
            const currentFunc = ScopeManager.getCurrentFunction(currentLinePointer);
            if (!currentFunc) {
                reportError(ExceptionType.REFERENCE_ERROR, t('local_array_outside_func', {name: arrayName}));
                return;
            }
            // 循环变量作用域内禁止声明同名数组 (doc规则2, 与普通局部变量一致)
            for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
                const block = CONTROL_FLOW_STACK[i];
                if (block.type === 'function') break;
                if (block.type === 'for' && block.varName === arrayName) {
                    reportError(ExceptionType.REFERENCE_ERROR, t('loop_var_shadow_forbidden', {name: arrayName}));
                    return;
                }
            }
            // 检查相同作用域与调用帧内是否已存在同名数组 (与普通局部变量一致: 同名+同作用域+同帧判定重复, 不同调用帧允许同名以支持递归)
            for (const localVar of LOCAL_VARS) {
                if (localVar.name === arrayName &&
                    localVar.frameId === arrayVariable.frameId &&
                    localVar.startLine === arrayVariable.startLine &&
                    localVar.endLine === arrayVariable.endLine) {
                    reportError(ExceptionType.REFERENCE_ERROR, t('name_defined_same_scope', {name: arrayName}));
                    return;
                }
            }
            LOCAL_VARS.push(arrayVariable);
            rebuildSlotIndex(); // 槽位索引同步 (局部数组已添加)
        }
    }

    // NEWARRAY 执行器: 复刻 executeArrayDeclaration 完整语义 (格式正则/标识符/元素拆分已在编译期预解析进 meta,
    // 错误消息/调试输出/作用域检查与注册时机逐字节一致)
    static executeArrayDeclarationCompiled(meta: NSVMArrayDeclMeta): void {
        const { arrayName, lengthExpr, elementTypeStr, initValue, elementValues, isGlobal, isConst, params } = meta;
        debugLog(3, () => t('dbg_exec_array_decl', { scope: isGlobal ? t('dbg_scope_global') : t('dbg_scope_local'), kind: isConst ? t('dbg_kind_const') : t('dbg_kind_var'), params }));

        // 获取数组长度
        let arrayLength: number;
        try {
            // 尝试解析长度表达式 (支持数字字面量、全局常量或表达式, 如 ROWS * COLS)
            const lengthValue = Interpreter.evaluateExpression(lengthExpr);
            if (typeof lengthValue !== 'number' || !Number.isInteger(lengthValue) || lengthValue < 0) {
                reportError(ExceptionType.RANGE_ERROR, t('array_length_non_negative'));
                return;
            }
            arrayLength = lengthValue;
        } catch (error) {
            // 长度表达式中的 input() 挂起信号穿透 (如 global array a[input()]:int)
            if (isInputSuspend(error)) throw error;
            reportError(ExceptionType.SYNTAX_ERROR, t('array_length_expr_unresolvable', {expr: lengthExpr}));
            return;
        }

        // 获取元素类型
        const elementType = Interpreter.getDataTypeFromString(elementTypeStr);

        // 检查元素类型是否有效
        if (elementType === DataType.UNDEFINED) {
            reportError(ExceptionType.SYNTAX_ERROR, t('array_element_type_unsupported', {type: elementTypeStr}));
            return;
        }

        // 检查元素类型是否为不允许的类型
        if (elementType === DataType.ARRAY) {
            reportError(ExceptionType.SYNTAX_ERROR, t('array_of_array_forbidden'));
            return;
        }

        // 初始化数组元素
        const arrayElements: ArrayElement[] = [];

        if (elementValues === null) {
            // 处理arrfill关键字
            debugLog(2, () => t('dbg_array_arrfill', { arrayName }));
            let fillValue: any;
            switch (elementType) {
                case DataType.NUMBER:
                    reportWarn(t('array_number_fill_0'));
                    fillValue = 0.0;
                    break;
                case DataType.INT:
                    fillValue = 0;
                    break;
                case DataType.FLOAT:
                    fillValue = 0.0;
                    break;
                case DataType.STRING:
                    fillValue = "";
                    break;
                case DataType.BOOL:
                    fillValue = false;
                    break;
                default:
                    reportError(ExceptionType.SYNTAX_ERROR, t('array_element_type_unsupported', {type: elementTypeStr}));
                    return;
            }

            // 填充数组
            for (let i = 0; i < arrayLength; i++) {
                arrayElements.push({
                    value: fillValue,
                    type: elementType
                });
            }
            debugLog(2, () => t('dbg_array_fill_done'));
        } else {
            debugLog(2, () => t('dbg_array_manual_init', { arrayName }));
            // 检查元素数量是否匹配
            if (elementValues.length !== arrayLength) {
                reportError(ExceptionType.RANGE_ERROR, t('array_init_count_mismatch', {actual: elementValues.length, expected: arrayLength}));
                return;
            }

            // 解析每个元素
            for (let i = 0; i < elementValues.length; i++) {
                try {
                    const elementValue = Interpreter.parseInitValue(elementValues[i].trim(), elementType);
                    arrayElements.push({
                        value: elementValue,
                        type: elementType
                    });
                } catch (error) {
                    reportError(ExceptionType.SYNTAX_ERROR, t('array_element_unresolvable', {index: i, value: elementValues[i]}));
                    return;
                }
            }
        }

        // 创建数组变量
        // 局部数组: 从控制流栈取最近函数帧的结束行与帧ID (递归时隔离不同调用帧; FUNCTION_SCOPES已废弃不可用)
        let localEndLine = -1;
        let localFrameId: number | undefined;
        if (!isGlobal) {
            for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
                const block = CONTROL_FLOW_STACK[i];
                if (block.type === 'function') {
                    localEndLine = block.endLine;
                    localFrameId = block.frameId;
                    break;
                }
            }
        }
        const arrayVariable: Variable = {
            name: arrayName,
            value: "请使用arrayElements属性访问数组元素", // 数组变量的值不适用直接访问
            type: DataType.ARRAY,
            isGlobal: isGlobal,
            isConst: isConst,
            startLine: currentLinePointer,
            endLine: isGlobal ? -1 : localEndLine,
            frameId: localFrameId,
            arrayLength: arrayLength,
            arrayElementType: elementType,
            arrayElements: arrayElements
        };

        // 添加到作用域管理器
        if (isGlobal) {
            // 检查全局变量是否已存在
            if (GLOBAL_VARS.hasOwnProperty(arrayName)) {
                reportError(ExceptionType.REFERENCE_ERROR, t('name_already_defined', {name: arrayName}));
                return;
            }
            GLOBAL_VARS[arrayName] = arrayVariable;
        } else {
            // 检查是否在函数内
            const currentFunc = ScopeManager.getCurrentFunction(currentLinePointer);
            if (!currentFunc) {
                reportError(ExceptionType.REFERENCE_ERROR, t('local_array_outside_func', {name: arrayName}));
                return;
            }
            // 循环变量作用域内禁止声明同名数组 (doc规则2, 与普通局部变量一致)
            for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
                const block = CONTROL_FLOW_STACK[i];
                if (block.type === 'function') break;
                if (block.type === 'for' && block.varName === arrayName) {
                    reportError(ExceptionType.REFERENCE_ERROR, t('loop_var_shadow_forbidden', {name: arrayName}));
                    return;
                }
            }
            // 检查相同作用域与调用帧内是否已存在同名数组 (与普通局部变量一致: 同名+同作用域+同帧判定重复, 不同调用帧允许同名以支持递归)
            for (const localVar of LOCAL_VARS) {
                if (localVar.name === arrayName &&
                    localVar.frameId === arrayVariable.frameId &&
                    localVar.startLine === arrayVariable.startLine &&
                    localVar.endLine === arrayVariable.endLine) {
                    reportError(ExceptionType.REFERENCE_ERROR, t('name_defined_same_scope', {name: arrayName}));
                    return;
                }
            }
            LOCAL_VARS.push(arrayVariable);
            rebuildSlotIndex(); // 槽位索引同步 (局部数组已添加)
        }
    }

    // SETARRAY 执行器: 复刻 executeOperation 数组赋值分支完整语义 (编译期预解析整行表达式树, 运行期以整表达式
    // token 上下文直接求值; 索引检查先于右值求值, 错误消息/调试输出/槽位快速路径逐字节一致)。
    // 独立方法: 主分发循环 SETARRAY case 仅一句委托调用, 复杂逻辑外提避免内联拖累循环的 V8 优化
    // (BISECT: SETARRAY case 内联完整实现时 2048 端到端慢 ~20%, 与 GETARRAY 同因)。
    static executeArrayAssignmentCompiled(meta: NSVMSetArrayMeta, currentLine: number): void {
        const { tree, nTokens, content } = meta;
        DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_execute_instr', { content }));
        debugLog(1, () => t('dbg_exec_op_instr', { content }));
        const result = ExpressionEvaluator.evalTreeWithContext(tree, nTokens, currentLine);
        debugLog(1, () => t('dbg_parse_result'));
        const { target, value, binding } = result as { target: { arrayName: string, index: number }, value: any, binding?: { frameKey: string, slot: number } };
        debugLog(1, () => t('dbg_detect_array_assign', { arrayName: target.arrayName, index: target.index }));
        // 处理 global. 前缀 (与整体赋值分支一致)
        let targetName: string = target.arrayName;
        let isGlobal: boolean = false;
        if (targetName.startsWith('global.')) {
            targetName = targetName.slice('global.'.length);
            isGlobal = true;
        }
        // 槽位快速路径: 局部数组 O(1) 读取; 槽位为空 (被 purge 等移除) 或无绑定 (全局/未注册) 回退原查找
        let arrayVar: Variable | null;
        if (binding) {
            arrayVar = ExpressionEvaluator.readSlot(binding);
            if (arrayVar === null) {
                arrayVar = ScopeManager.getVariable(targetName, currentLine, true, isGlobal);
            }
        } else {
            arrayVar = ScopeManager.getVariable(targetName, currentLine, true, isGlobal);
        }
        // 检查变量是否存在且是数组类型
        if (!arrayVar) {
            throw { type: ExceptionType.REFERENCE_ERROR, message: t('array_undefined', {name: targetName}), lineNumber: currentLine } as Exception;
        }
        debugLog(1, () => t('dbg_array_name', { name: arrayVar.name }));

        if (arrayVar.type !== DataType.ARRAY) {
            throw { type: ExceptionType.TYPE_ERROR, message: t('not_array_type', {name: targetName}), lineNumber: currentLine } as Exception;
        }

        if (arrayVar.isConst) {
            throw { type: ExceptionType.TYPE_ERROR, message: t('const_array_assignment', {name: targetName}), lineNumber: currentLine } as Exception;
        }

        if (arrayVar.isReadonlyArray) {
            throw { type: ExceptionType.TYPE_ERROR, message: t('readonly_array_assignment', {name: targetName}), lineNumber: currentLine } as Exception;
        }

        // 检查索引是否在数组范围内
        if (target.index >= arrayVar.arrayLength!) {
            throw { type: ExceptionType.RANGE_ERROR, message: t('arr_index_out_of_range', {index: target.index, length: arrayVar.arrayLength}), lineNumber: currentLine } as Exception;
        }

        // 更新数组元素
        // 检查元素类型是否匹配
        const elementType = arrayVar.arrayElementType!;
        // 快速类型兼容路径: 原生值类型与目标类型直接匹配时免 validateType 调用 (每次调用分配结果对象)
        if ((elementType === DataType.INT && typeof value === 'number' && Number.isInteger(value)) ||
            ((elementType === DataType.FLOAT || elementType === DataType.NUMBER) && typeof value === 'number') ||
            (elementType === DataType.STRING && typeof value === 'string') ||
            (elementType === DataType.BOOL && typeof value === 'boolean')) {
            arrayVar.arrayElements![target.index].value = value;
            return;
        }
        const validation = ScopeManager.validateType(value, elementType);
        if (!validation.isValid) {
            throw { type: ExceptionType.TYPE_ERROR, message: t('array_element_type_mismatch', {expected: elementType, actual: typeof value}), lineNumber: currentLine } as Exception;
        }

        // 更新数组元素
        debugLog(2, () => t('dbg_update_array_elem', { oldValue: arrayVar.arrayElements![target.index].value, newValue: validation.convertedValue }));
        arrayVar.arrayElements![target.index].value = validation.convertedValue;
    }

    // 辅助方法: 分割数组元素, 正确处理字符串中的逗号
    static splitArrayElements(elementsStr: string): string[] {
        const elements: string[] = [];
        let currentElement = '';
        let inString = false;
        let stringDelimiter = '';

        for (let i = 0; i < elementsStr.length; i++) {
            const char = elementsStr[i];

            if (!inString && char === '"') {
                inString = true;
                stringDelimiter = char;
                currentElement += char;
            } else if (inString && char === stringDelimiter) {
                inString = false;
                currentElement += char;
            } else if (!inString && char === ',') {
                elements.push(currentElement.trim());
                currentElement = '';
            } else {
                currentElement += char;
            }
        }

        // 添加最后一个元素
        if (currentElement.trim()) {
            elements.push(currentElement.trim());
        }

        return elements;
    }

    // 执行返回语句
    static executeReturn(params: string): void {
        DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_exec_return', { params }));
        // 根据用户需求修改返回值处理逻辑
        // return语句后只能是单个变量
        const returnValueStr = params.trim();

        // 检查是否有返回值
        if (returnValueStr === '') {
            reportError(ExceptionType.SYNTAX_ERROR, t('return_requires_var'));
            return;
        }

        // 获取当前函数名
        // 逆向查找控制流栈中最近的函数调用
        for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
            const block = CONTROL_FLOW_STACK[i];
            if (block.type === 'function') {
                // 快速校验: 正常执行路径当前行必在函数区间内, 无需遍历 FUNCTIONS;
                // 仅当当前行已跳出函数区间 (如函数体内 jump 到函数外标签) 时走原完整校验, 语义一致
                if (currentLinePointer < block.startLine || currentLinePointer > block.endLine) {
                    const funcName = ScopeManager.getCurrentFunction(currentLinePointer);
                    if (funcName === null) {
                        reportError(ExceptionType.SYNTAX_ERROR, t('return_outside_function'));
                        return;
                    } else if (funcName !== block.funcName) {
                        reportError(ExceptionType.UNKNOWN_ERROR, t('return_stack_top_mismatch'));
                        return;
                    }
                }
                const funcInfo = FUNCTIONS[block.funcName];

                // 规则: return 只能返回函数声明的返回变量
                const defReturnVar = ScopeManager.getReturnVarName(funcInfo);
                if (defReturnVar !== undefined && returnValueStr !== defReturnVar) {
                    reportError(ExceptionType.TYPE_ERROR, t('return_var_mismatch', {funcName: block.funcName, defReturnVar: defReturnVar, returnValue: returnValueStr}));
                    return;
                }

                let returnValue: any;
                // 从当前作用域获取返回变量
                // 注意: 需区分"变量不存在"与"变量存在但值为undefined"(如未赋初值的返回值变量)
                // 槽位快速路径: 返回变量 (函数帧返回值槽位) O(1) 读取; 槽位为空 (purge等) 回退原线性查找
                let returnVarInfo: Variable | null = null;
                const slotBinding = lookupSlotBinding(returnValueStr, currentLinePointer);
                if (slotBinding) {
                    returnVarInfo = ExpressionEvaluator.readSlot(slotBinding);
                }
                if (returnVarInfo === null) {
                    returnVarInfo = ScopeManager.getVariableInfo(returnValueStr, currentLinePointer);
                }
                if (returnVarInfo === null) {
                    // 变量不存在 → 视为无返回值
                    if (!ScopeManager.isVoidFunction(funcInfo)) {
                        reportError(ExceptionType.TYPE_ERROR, t('func_return_value_missing', {name: block.funcName, type: funcInfo.returnType}));
                        return;
                    }
                    returnValue = undefined;
                    if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_no_return_undefined'));
                    return;
                }
                // 数组返回: 捕获整个数组结构引用 (含 arrayElements), 标量返回捕获值
                if (returnVarInfo.type === DataType.ARRAY) {
                    returnValue = returnVarInfo;
                } else {
                    returnValue = returnVarInfo.value;
                }
                if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_return_from_var', { value: returnValue }));

                // 将返回值存储到RETURN_VALUES池中并做好标记
                if (!RETURN_VALUES.hasOwnProperty(block.funcName)) {
                    RETURN_VALUES[block.funcName] = {};
                }
                if (returnValueStr) {
                    // 优先存储 return 语句中的变量名
                    RETURN_VALUES[block.funcName][returnValueStr] = returnValue;
                    // 同时存储函数定义中的返回值变量名（两者可能不同）
                    const defReturnVar = ScopeManager.getReturnVarName(funcInfo);
                    if (defReturnVar && defReturnVar !== returnValueStr) {
                        RETURN_VALUES[block.funcName][defReturnVar] = returnValue;
                    }
                } else {
                    reportError(ExceptionType.UNKNOWN_ERROR, t('return_value_name_mismatch'));
                    return;
                }
                if (DEBUG_LEVEL >= 2) {
                    debugLog(2, () => t('dbg_store_return', { funcName: block.funcName, returnValueStr, returnValue }));
                    debugLog(2, () => t('dbg_return_pool'), RETURN_VALUES);
                }

                // 弹出函数帧（必须先弹出，防止后续遍历到残留的旧函数帧）
                CONTROL_FLOW_STACK.pop();
                // 清理本帧局部变量: 帧变量按 LIFO 连续位于 LOCAL_VARS 尾部, 截断到调用时位置即可 (O(1), 替代 O(n) filter)
                // 注意: 无需重建槽位索引 — 函数帧ID单调递增不复用, 被清理帧的陈旧槽位条目不可达 (readSlot 仅经活动控制流栈查找)
                LOCAL_VARS.length = block.frameVarStart;
                // 回收该帧的槽位索引条目, 防止 SLOT_INDEX 随调用次数无限增长 (内存 + 帧缓存失效)
                delete SLOT_INDEX[String(block.frameId)];
                if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_local_vars_after_cleanup'), LOCAL_VARS);
                // 再处理返回值赋值（此时局部变量已清理，返回变量安全添加）
                // 注意: 用调用行 (block.callFrom) 而非当前 return 行作为结果变量作用域起点,
                // 否则递归时 return 行晚于调用点, 结果变量会被误判为"未声明"而创建隐式重复变量, 遮蔽静态声明。
                handleReturnValueAssignment(block.funcName, funcInfo, block.returnVarName, block.callFrom);
                if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_control_stack_cleaned'), CONTROL_FLOW_STACK);
                currentLinePointer = block.callFrom;
                break; // 停止遍历, 防止处理残留函数帧
            } else {
                CONTROL_FLOW_STACK.pop();
                if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_control_cleaned'), CONTROL_FLOW_STACK);
            }
        }


    }

    // 执行输出语句
    static executePrint(params: string): void {
        try {
            // 使用表达式求值器处理参数
            const value = Interpreter.evaluateExpression(params);
            console.log(value);
        } catch (error) {
            // 自定义异常 (如ReferenceError) 重新抛出, 供try-catch捕获
            if (error && typeof error === 'object' && (error as Exception).type !== undefined) {
                throw error;
            }
            reportError(ExceptionType.TYPE_ERROR, t('print_expr_failed', {expr: params}));
            // 如果表达式计算失败, 则返回
            return;
        }
    }

    // 执行if语句
    static executeIf(params: string): void {
        // 检查条件表达式是否用括号括起
        const trimmedParams = params.trim();
        if (!trimmedParams.startsWith('(') || !trimmedParams.endsWith(')')) {
            reportError(ExceptionType.SYNTAX_ERROR, t('cond_need_parentheses'));
            return;
        }

        // 提取括号内的表达式
        const conditionExpr = trimmedParams.substring(1, trimmedParams.length - 1);

        debugLog(2, () => t('dbg_calc_cond', { expr: conditionExpr, line: currentLinePointer + 1 }));
        try {
            const condition = Interpreter.evaluateExpression(conditionExpr);
            debugLog(2, () => t('dbg_cond_result', { result: condition, type: typeof condition }));

            // 检查条件表达式的返回值是否为布尔类型
            if (typeof condition !== 'boolean') {
                reportError(ExceptionType.TYPE_ERROR, t('cond_must_be_bool', {actualType: typeof condition}));
                return;
            }

            // 先将if信息压栈, 防止break等语句出错
            CONTROL_FLOW_STACK.push({
                type: 'if'
            })

            if (!condition) {
                // 跳过if块
                debugLog(1, () => t('dbg_if_false_line', { line: currentLinePointer + 1 }));
                let nestedLevel = 1;
                let i = currentLinePointer + 1;
                while (i < programLines.length && nestedLevel > 0) {
                    const line = programLines[i].trim();
                    if (line.toLowerCase().startsWith('if ')) {
                        nestedLevel++;
                    } else if (line === 'else' || line === 'endif') {
                        nestedLevel--;
                        if (nestedLevel === 0) {
                            currentLinePointer = i; // 不减1是因为主循环会加1跳过 execElse 避免无法正常执行 else 块
                            debugLog(2, () => t('dbg_current_control_flow'), CONTROL_FLOW_STACK);
                            if (line === 'endif') {
                                CONTROL_FLOW_STACK.pop();
                            }
                            debugLog(2, () => t('dbg_updated_control_flow'), CONTROL_FLOW_STACK);
                            break;
                        }
                    }
                    i++;
                }
            }
        } catch (error) {
            // 自定义异常 (如ReferenceError) 重新抛出, 供try-catch捕获
            if (error && typeof error === 'object' && (error as Exception).type !== undefined) {
                throw error;
            }
            reportError(ExceptionType.SYNTAX_ERROR, t('cond_invalid', {expr: conditionExpr}));
            debugLog(1, () => t('dbg_error_detail', { error }));
        }
    }

    // 执行else语句
    static executeElse(): void {
        // 执行到else说明if条件为真且if块体已执行完毕, 弹出if帧
        // (条件为假时由executeIf直接跳转到else行, 主循环会跳过else命令; 该帧由后续endif弹出)
        if (CONTROL_FLOW_STACK.length > 0 && CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1].type === 'if') {
            CONTROL_FLOW_STACK.pop();
        }
        // 跳过else块
        let nestedLevel = 1;
        let i = currentLinePointer + 1;
        while (i < programLines.length && nestedLevel > 0) {
            const line = programLines[i].trim();
            if (line.toLowerCase().startsWith('if ')) {
                nestedLevel++;
            } else if (line === 'endif') {
                nestedLevel--;
                if (nestedLevel === 0) {
                    currentLinePointer = i; // 是否减1目前影响不大, endif语句仅用于静态闭合检查, 为避免无用判断不做减1处理
                    break;
                }
            }
            i++;
        }
    }

    // 执行while语句
    static executeWhile(params: string): void {
        // 检查条件表达式是否用括号括起
        const trimmedParams = params.trim();
        if (!trimmedParams.startsWith('(') || !trimmedParams.endsWith(')')) {
            reportError(ExceptionType.SYNTAX_ERROR, t('cond_need_parentheses'));
            return;
        }

        // 提取括号内的表达式
        const conditionExpr = trimmedParams.substring(1, trimmedParams.length - 1);

        try {
            // break/continue 标记检查: 空栈快路径 (绝大多数循环无 break/continue, 避免 .some 闭包扫描)
            const brokenexists = CONTROL_FLOW_BROKEN_BLOCK_STACK.length > 0 && CONTROL_FLOW_BROKEN_BLOCK_STACK.some(item =>
                item.type === 'while' && item.start === currentLinePointer
            );
            DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_broken_block_stack'), CONTROL_FLOW_BROKEN_BLOCK_STACK);

            const condition = Interpreter.evaluateExpression(conditionExpr) && !brokenexists;

            // 检查条件表达式的返回值是否为布尔类型
            if (typeof condition !== 'boolean') {
                reportError(ExceptionType.TYPE_ERROR, t('cond_must_be_bool', {actualType: typeof condition}));
                return;
            }

            DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_current_control_flow'), CONTROL_FLOW_STACK);
            // 先将while循环信息压栈, 防止首次循环条件不满足。
            // exists 判断: 栈顶 O(1) 快路径 (while 帧在循环体执行时即栈顶), 不命中再回退线性扫描,
            // 且本次结果供条件真假两个分支共用, 去掉原 else 分支中重复的第二次扫描。
            let exists: boolean;
            const topBlock = CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1];
            if (topBlock && topBlock.type === 'while' && topBlock.start === currentLinePointer) {
                exists = true;
            } else {
                exists = CONTROL_FLOW_STACK.some(item =>
                    item.type === 'while' && item.start === currentLinePointer
                );
            }
            if (!exists) {
                CONTROL_FLOW_STACK.push({
                    type: 'while',
                    start: currentLinePointer
                });
            }

            if (!condition) {
                DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_while_skip', { line: currentLinePointer + 1, broken: brokenexists }))

                // 跳过while块
                let nestedLevel = 1;
                let i = currentLinePointer + 1;
                while (i < programLines.length && nestedLevel > 0) {
                    const line = programLines[i].trim();
                    if (line.toLowerCase().startsWith('while ')) {
                        nestedLevel++;
                    } else if (line === 'endwhl') {
                        nestedLevel--;
                        if (nestedLevel === 0) {
                            currentLinePointer = i; // 不减1是因为主循环会加1跳过 endWhile 的执行避免死循环
                            CONTROL_FLOW_STACK.pop();
                            if (brokenexists) {
                                CONTROL_FLOW_BROKEN_BLOCK_STACK.pop();
                                DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_broken_block_stack'), CONTROL_FLOW_BROKEN_BLOCK_STACK);
                            }
                            break;
                        }
                    }
                    i++;
                }
            }
        } catch (error) {
            // 自定义异常 (如ReferenceError) 重新抛出, 供try-catch捕获
            if (error && typeof error === 'object' && (error as Exception).type !== undefined) {
                throw error;
            }
            reportError(ExceptionType.SYNTAX_ERROR, t('cond_invalid', {expr: conditionExpr}));
        }
        DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_control_flow_after_loop'), CONTROL_FLOW_STACK);
    }

    // 执行endwhl语句
    static executeEndWhile(): void {
        DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_current_control_flow'), CONTROL_FLOW_STACK);
        // 栈顶快路径: endwhl 执行时本循环的 while 帧必然在栈顶 (内层块均已弹栈), O(1) 回跳,
        // 免去向后逐行扫描 (programLines[i].trim() 每行分配字符串)。
        const topBlock = CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1];
        if (topBlock && topBlock.type === 'while' && topBlock.start < currentLinePointer) {
            currentLinePointer = topBlock.start - 1; // 减1是因为主循环会加1
            return;
        }
        // 回退路径: 与原始逻辑一致, 向后扫描匹配的 while 行
        let i = currentLinePointer - 1;
        let nestedLevel = 1;
        while (i >= 0 && nestedLevel > 0) {
            const line = programLines[i].trim();
            if (line === 'endwhl') {
                nestedLevel++;
            } else if (line.toLowerCase().startsWith('while ')) {
                nestedLevel--;
                if (nestedLevel === 0) {
                    currentLinePointer = i - 1; // 减1是因为主循环会加1
                    break;
                }
            }
            i--;
        }
    }

    // 执行for语句
    static executeFor(params: string): void {
        params = params.replace(/^\(|\)$/g, '');
        DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_for_params', { params }));
        // 匹配格式: local 变量名:类型 = 初始值; 条件; 更新表达式
        let match = params.match(/^local\s+([a-zA-Z0-9_]+):([a-zA-Z0-9_]+)\s*=\s*(.+)\s*;\s*(.+)\s*;\s*(.+)$/);

        if (!match) {
            reportError(ExceptionType.SYNTAX_ERROR, t('for_format'));
            return;
        }

        const varName = match[1];
        const typeStr = match[2];
        const initialValueStr = match[3];
        const condition = match[4];
        const updateExpr = match[5];
        const type = Interpreter.getDataTypeFromString(typeStr);

        try {
            // 获取对应的endfor位置
            let endForLine = currentLinePointer;
            let nestedLevel = 1;
            for (let i = currentLinePointer + 1; i < programLines.length; i++) {
                if (programLines[i].trim().split(/\s+/)[0] === 'for') {
                    nestedLevel++;
                    debugLog(2, () => t('dbg_nested_for', { level: nestedLevel }));
                } else if (programLines[i].trim() === 'endfor') {
                    if (nestedLevel === 1) {
                        debugLog(2, () => t('dbg_matching_endfor', { level: nestedLevel }));
                        endForLine = i;
                        break;
                    }
                    nestedLevel--;
                    debugLog(2, () => t('dbg_endfor_detected', { level: nestedLevel }));
                }
            }
            // 初始化循环变量
            const initialValue = Interpreter.parseValue(initialValueStr, type);
            // 检查作用域: 从栈顶向下查找同名 for 帧 (遇到 function 帧停止, 函数内作用域独立)
            // 避免误伤: 函数内 for 与外层循环使用同名循环变量是允许的
            let conflictForStart: number | null = null;
            for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
                const block = CONTROL_FLOW_STACK[i];
                if (block.type === 'function') break;
                if (block.type === 'for' && block.varName === varName) {
                    conflictForStart = block.start;
                    break;
                }
            }

            if (conflictForStart !== null && conflictForStart !== currentLinePointer) {
                // 循环变量作用域内禁止声明同名变量 (如内层for与外层for同名循环变量)
                reportError(ExceptionType.REFERENCE_ERROR, t('loop_var_shadow_forbidden', {name: varName}));
                return;
            }

            if (conflictForStart === currentLinePointer) {
                // 当前 for 自身重入 (如 jump 跳回): 复用循环变量, 跳过初始化
                debugLog(2, () => t('dbg_loop_var_exists'));
            } else {
                // 创建循环变量 (若与全局变量同名则自动遮蔽, 局部查找优先)
                ScopeManager.addVariable(varName, initialValue, type, currentLinePointer, endForLine, false);
                rebuildSlotIndex(); // 槽位索引同步 (循环变量已声明)
            }

            const brokenexists = CONTROL_FLOW_BROKEN_BLOCK_STACK.some(item =>
                item.type === 'for' &&
                item.start === currentLinePointer &&
                item.updateExpr === updateExpr &&
                item.varName === varName
            );
            debugLog(2, () => t('dbg_broken_block_stack'), CONTROL_FLOW_BROKEN_BLOCK_STACK);

            // 评估条件
            const result = Interpreter.evaluateExpression(condition) && !brokenexists;

            // 检查条件表达式的返回值是否为布尔类型
            if (typeof result !== 'boolean') {
                reportError(ExceptionType.TYPE_ERROR, t('cond_must_be_bool', {actualType: typeof result}));
                return;
            }

            debugLog(2, () => t('dbg_current_control_flow'), CONTROL_FLOW_STACK);
            // 先将for循环信息压栈, 防止首次循环条件不满足
            // 检查CONTROL_FLOW_STACK中是否已存在相同的for循环信息
            const exists = CONTROL_FLOW_STACK.some(item =>
                item.type === 'for' &&
                item.start === currentLinePointer &&
                item.updateExpr === updateExpr &&
                item.varName === varName
            );

            if (!exists) {
                CONTROL_FLOW_STACK.push({
                    type: 'for',
                    start: currentLinePointer,
                    updateExpr: updateExpr,
                    varName: varName
                });
            }

            if (!result) {
                debugLog(2, () => t('dbg_for_skip', { line: currentLinePointer + 1, broken: brokenexists }));
                // 跳过for块
                let nestedLevel = 1;
                let i = currentLinePointer + 1;
                while (i < programLines.length && nestedLevel > 0) {
                    const line = programLines[i].trim();
                    if (line.toLowerCase().startsWith('for ')) {
                        nestedLevel++;
                    } else if (line === 'endfor') {
                        nestedLevel--;
                        if (nestedLevel === 0) {
                            currentLinePointer = i; // 不减1是因为主循环会加1并跳过endfor避免闭合标签对应错误
                            CONTROL_FLOW_STACK.pop();
                            if (brokenexists) {
                                CONTROL_FLOW_BROKEN_BLOCK_STACK.pop();
                                debugLog(2, () => t('dbg_broken_block_stack'), CONTROL_FLOW_BROKEN_BLOCK_STACK);
                            }
                            const varInfo = ScopeManager.getVariableInfo(varName, currentLinePointer);
                            if (varInfo) {
                                ScopeManager.cleanupLocalVariable(false, false, varInfo.name, varInfo.startLine, varInfo.endLine, varInfo.frameId);
                            }
                            break;
                        }
                    }
                    i++;
                }
            } else {
                // 记录循环开始位置和更新表达式
                // 检查CONTROL_FLOW_STACK中是否已存在相同的for循环信息
                const exists = CONTROL_FLOW_STACK.some(item =>
                    item.type === 'for' &&
                    item.start === currentLinePointer &&
                    item.updateExpr === updateExpr &&
                    item.varName === varName
                );

                if (!exists) {
                    CONTROL_FLOW_STACK.push({
                        type: 'for',
                        start: currentLinePointer,
                        updateExpr: updateExpr,
                        varName: varName
                    });
                }
            }
        } catch (error) {
            // 自定义异常 (如ReferenceError) 重新抛出, 供try-catch捕获
            if (error && typeof error === 'object' && (error as Exception).type !== undefined) {
                throw error;
            }
            // console.error(`错误: for循环初始化失败`);
            throw { type: ExceptionType.LOOP_INIT_ERROR, message: t('for_init_failed'), lineNumber: currentLinePointer } as Exception;
        }
        debugLog(2, () => t('dbg_control_flow_after_loop'), CONTROL_FLOW_STACK);
    }

    // 执行endfor语句
    static executeEndFor(): void {
        debugLog(2, () => t('dbg_current_control_flow'), CONTROL_FLOW_STACK);
        // 执行更新表达式
        if (CONTROL_FLOW_STACK.length > 0 && CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1].type === 'for') {
            const forInfo = CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1];
            try {
                // 执行更新表达式 (设置豁免标志, 允许修改循环变量)
                if ('updateExpr' in forInfo) {
                    FOR_UPDATE_VAR = forInfo.varName;
                    try {
                        Interpreter.executeOperation(forInfo.updateExpr);
                    } finally {
                        FOR_UPDATE_VAR = null;
                    }
                }
                // 返回到条件判断
                if ('start' in forInfo) {
                    currentLinePointer = forInfo.start - 1; // 减1是因为主循环会加1
                }
            } catch (error) {
                // 自定义异常 (如ReferenceError) 重新抛出, 供try-catch捕获
                if (error && typeof error === 'object' && (error as Exception).type !== undefined) {
                    throw error;
                }
                // console.error(`错误: for循环更新表达式执行失败`);
                // 跳过循环
                throw { type: ExceptionType.LOOP_UPDATE_ERROR, message: t('for_update_failed'), lineNumber: currentLinePointer } as Exception;
            }
        }
    }

    // 执行break语句
    static executeBreak(): void {
        // 1. 检查是否在合法的控制块内
        if (CONTROL_FLOW_STACK.length === 0) {
            reportError(ExceptionType.SYNTAX_ERROR, t('break_outside_loop_switch'));
            return;
        }

        // 2. 逆向查找最近的循环 (而非只看栈顶)
        for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
            const block = CONTROL_FLOW_STACK[i];
            if (block.type === 'for' || block.type === 'switch' || block.type === 'while') {
                // 3. 根据类型决定跳转目标
                let targetEndTag: string;
                switch (block.type) {
                    case 'switch':
                        targetEndTag = 'endswc';
                        break;
                    case 'for':
                        targetEndTag = 'endfor';
                        CONTROL_FLOW_BROKEN_BLOCK_STACK.push(block);
                        break;
                    case 'while':
                        targetEndTag = 'endwhl';
                        CONTROL_FLOW_BROKEN_BLOCK_STACK.push(block);
                        break;
                    default:
                        reportError(ExceptionType.SYNTAX_ERROR, t('break_context_unsupported'));
                        return;
                }
                debugLog(2, () => t('dbg_jump_target', { targetEndTag }));
                debugLog(2, () => t('dbg_broken_block_stack'), CONTROL_FLOW_BROKEN_BLOCK_STACK);

                // 4. 跳到对应的结束标记
                let i = currentLinePointer + 1;
                let nestedLevel = 1;  // 用于处理嵌套结构
                while (i < programLines.length) {
                    const line = programLines[i].trim();

                    // 遇到同类控制结构时增加嵌套层级
                    if (line.startsWith(block.type + ' ')) {
                        nestedLevel++;
                    }
                    // 遇到目标结束标记时减少层级
                    else if (line === targetEndTag) { // 用全等是这些标签后无参数
                        nestedLevel--;
                        if (nestedLevel === 0) {
                            currentLinePointer = i - 1; // 减1是因为主循环会加1, 自动落到闭合标签前让闭合标签能够执行处理
                            return;
                        }
                    }

                    i++;
                }
                reportError(ExceptionType.SYNTAX_ERROR, t('matching_end_tag_not_found', {tag: targetEndTag}));
            } else {
                CONTROL_FLOW_STACK.pop();
                debugLog(2, () => t('dbg_control_cleaned'), CONTROL_FLOW_STACK);
            }
        }
    }

    // 执行continue语句
    static executeContinue(): void {
        // 1. 检查是否在合法的控制块内
        if (CONTROL_FLOW_STACK.length === 0) {
            reportError(ExceptionType.SYNTAX_ERROR, t('continue_outside_loop'));
            return;
        }

        // 2. 逆向查找最近的循环 (而非只看栈顶) 
        for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
            const block = CONTROL_FLOW_STACK[i];
            if (block.type === 'for' || block.type === 'while') {
                // 3. 根据类型决定跳转目标
                // let targetStartLine: number = block.start;
                let targetEndTag: string;
                switch (block.type) {
                    case 'for':
                        targetEndTag = 'endfor';
                        break;
                    case 'while':
                        targetEndTag = 'endwhl';
                        break;
                    default:
                        reportError(ExceptionType.SYNTAX_ERROR, t('continue_context_unsupported'));
                        return;
                }
                debugLog(2, () => t('dbg_jump_target', { targetEndTag }));

                // 4. 跳到对应的结束标记
                let i = currentLinePointer + 1;
                let nestedLevel = 1;  // 用于处理嵌套结构
                while (i < programLines.length) {
                    const line = programLines[i].trim();

                    // 遇到同类控制结构时增加嵌套层级
                    if (line.startsWith(block.type + ' ')) {
                        nestedLevel++;
                    }
                    // 遇到目标结束标记时减少层级
                    else if (line === targetEndTag) {
                        nestedLevel--;
                        if (nestedLevel === 0) {
                            currentLinePointer = i - 1; // 减1是因为主循环会加1, 自动落到闭合标签前让闭合标签能够执行处理
                            return;
                        }
                    }

                    i++;
                }
                reportError(ExceptionType.SYNTAX_ERROR, t('matching_end_tag_not_found', {tag: targetEndTag}));
            } else {
                CONTROL_FLOW_STACK.pop();
                debugLog(2, () => t('dbg_control_cleaned'), CONTROL_FLOW_STACK);
            }
        }

        // 如果没有找到循环, 输出错误信息
        reportError(ExceptionType.SYNTAX_ERROR, t('continue_outside_loop'));
    }

    // 执行try语句
    static executeTry(): void {
        // 记录try块标记 (供异常跳转时匹配)
        EXCEPTION_STACK.push({
            type: ExceptionType.TRY_BLOCK,
            message: '',
            lineNumber: currentLinePointer
        });
        // 同时压入控制流栈, 以便异常跳转时清理嵌套帧, 并让catch块内的局部变量声明能找到所属代码块
        CONTROL_FLOW_STACK.push({
            type: 'try',
            start: currentLinePointer
        });
    }

    // 从 try 起始行向后查找匹配的 catch 行 (跳过嵌套 try 结构), 找不到返回 -1
    static findCatchLine(tryLine: number): number {
        let nestedLevel = 0;
        for (let i = tryLine + 1; i < programLines.length; i++) {
            const line = programLines[i].trim();
            if (line === 'try') {
                nestedLevel++;
            } else if (line.startsWith('catch ')) {
                if (nestedLevel === 0) {
                    return i;
                }
            } else if (line === 'endtry') {
                if (nestedLevel === 0) {
                    return -1; // try 后没有对应的 catch
                }
                nestedLevel--;
            }
        }
        return -1;
    }

    // 执行catch语句
    static executeCatch(params: string): void {
        // 解析catch参数, 格式为 (Exception ErrorName)
        const match = params.match(/^\(\s*Exception\s+([a-zA-Z0-9_]+)\s*\)$/);
        if (!match) {
            reportError(ExceptionType.SYNTAX_ERROR, t('catch_format'));
            return;
        }

        const errorName = match[1];

        // 情况一: 异常跳转进入catch块 (主循环设置了PENDING_EXCEPTION)
        if (PENDING_EXCEPTION !== null) {
            const exception = PENDING_EXCEPTION;
            PENDING_EXCEPTION = null;

            // 查找本try-catch结构的endtry行, 用于确定异常变量的作用域
            let endtryLine = -1;
            let nestedLevel = 1;
            let i = currentLinePointer + 1;
            while (i < programLines.length && nestedLevel > 0) {
                const line = programLines[i].trim();
                if (line === 'try') {
                    nestedLevel++;
                } else if (line === 'endtry') {
                    nestedLevel--;
                    if (nestedLevel === 0) {
                        endtryLine = i;
                    }
                }
                i++;
            }

            // 将异常绑定为string类型的局部变量 (值为错误消息)
            if (endtryLine !== -1) {
                ScopeManager.addVariable(errorName, exception.message, DataType.STRING, currentLinePointer, endtryLine, false, false);
                rebuildSlotIndex(); // 槽位索引同步 (catch 异常变量已绑定)
            }
            debugLog(1, () => t('dbg_catch_exception', { message: exception.message, line: exception.lineNumber + 1 }));

            // 记录catch块位置 (供endtry清理)
            EXCEPTION_STACK.push({
                type: ExceptionType.CATCH_BLOCK,
                message: errorName, // 存储异常变量名
                lineNumber: currentLinePointer
            });
            return; // 继续执行catch块体
        }

        // 情况二: 正常流程 (try块无异常) 执行到catch行, 跳过catch块体
        if (EXCEPTION_STACK.length > 0 && EXCEPTION_STACK[EXCEPTION_STACK.length - 1].type === ExceptionType.TRY_BLOCK) {
            // 清除try块标记
            EXCEPTION_STACK.pop();
            // 弹出控制流栈中的try帧
            if (CONTROL_FLOW_STACK.length > 0 && CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1].type === 'try') {
                CONTROL_FLOW_STACK.pop();
            }
            // 跳过catch块体直到endtry
            let nestedLevel = 1;
            let i = currentLinePointer + 1;
            while (i < programLines.length && nestedLevel > 0) {
                const line = programLines[i].trim();
                if (line === 'try') {
                    nestedLevel++;
                } else if (line === 'endtry') {
                    nestedLevel--;
                    if (nestedLevel === 0) {
                        currentLinePointer = i; // 主循环会+1, 落到endtry下一行
                        break;
                    }
                }
                i++;
            }
            return;
        }

        // 情况三: 没有匹配的try块
        reportError(ExceptionType.SYNTAX_ERROR, t('catch_no_try'));
        // 跳过catch块
        let nestedLevel = 1;
        let i = currentLinePointer + 1;
        while (i < programLines.length && nestedLevel > 0) {
            const line = programLines[i].trim();
            if (line === 'try') {
                nestedLevel++;
            } else if (line === 'endtry') {
                nestedLevel--;
                if (nestedLevel === 0) {
                    currentLinePointer = i - 1; // 减1是因为主循环会加1
                    break;
                }
            }
            i++;
        }
    }

    // 执行endtry语句
    static executeEndTry(): void {
        // 清理本 try-catch 块内声明的局部变量 (含 catch 异常变量), 防止重复执行时同名冲突
        // 注意: 仅异常进入catch后执行到endtry的情况 (正常跳过catch时不会到达本行)
        const topFrame = CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1];
        if (topFrame && topFrame.type === 'try') {
            const blockStart = topFrame.start;
            LOCAL_VARS = LOCAL_VARS.filter(v => !(v.startLine >= blockStart && !v.isGlobal));
            rebuildSlotIndex(); // 槽位索引同步 (try块内局部变量已清理)
        }
        // 清除异常栈栈顶的一个try/catch标记 (一个endtry只对应一个try-catch结构, 不能弹出外层标记)
        if (EXCEPTION_STACK.length > 0) {
            const exception = EXCEPTION_STACK[EXCEPTION_STACK.length - 1];
            if (exception.type === ExceptionType.TRY_BLOCK || exception.type === ExceptionType.CATCH_BLOCK) {
                EXCEPTION_STACK.pop();
            }
        }
        // 清除控制流栈中的try帧
        if (CONTROL_FLOW_STACK.length > 0 && CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1].type === 'try') {
            CONTROL_FLOW_STACK.pop();
        }
    }

    // 执行assert语句
    static executeAssert(params: string): void {
        debugLog(1, () => t('dbg_exec_assert', { params }));
        // 解析参数, 只支持一种格式: 
        // assert (condition)
        // "assertion failure message"
        // endasrt
        const trimmedParams = params.trim();
        if (!trimmedParams.startsWith('(') || !trimmedParams.endsWith(')')) {
            reportError(ExceptionType.SYNTAX_ERROR, t('assert_need_parentheses'));
            return;
        }

        // 提取括号内的条件
        const conditionExpr = trimmedParams.substring(1, trimmedParams.length - 1).trim();

        try {
            const condition = Interpreter.evaluateExpression(conditionExpr);
            if (!condition) {
                // 获取下一行作为消息
                currentLinePointer++;
                const messageLine = programLines[currentLinePointer].trim();

                // 检查消息是否用引号括起
                if (!messageLine.startsWith('"') || !messageLine.endsWith('"')) {
                    reportError(ExceptionType.SYNTAX_ERROR, t('assert_message_quoted'));
                    return;
                }

                // 去掉引号
                const errorMessage = messageLine.substring(1, messageLine.length - 1);

                throw {
                    type: ExceptionType.ASSERTION_ERROR,
                    message: errorMessage,
                    lineNumber: currentLinePointer
                } as Exception;
            } else {
                debugLog(1, () => t('dbg_assert_true', { expr: conditionExpr }));
                // 跳过断言体
                currentLinePointer += 2;
            }
        } catch (error) {
            // 断言条件中的 input() 挂起信号穿透 (如 assert (input() != ""))
            if (isInputSuspend(error)) throw error;
            if ((error as Exception).type === ExceptionType.ASSERTION_ERROR) {
                // 断言失败: 抛出异常交由主循环处理 (可被try-catch捕获; 未捕获时由主循环console.error输出并终止)
                throw error;
            } else {
                reportError(ExceptionType.SYNTAX_ERROR, t('assert_condition_invalid', {expr: conditionExpr}));
            }
        }
    }

    // 执行switch语句
    static executeSwitch(params: string): void {
        params = params.replace(/^\(|\)$/g, '');
        debugLog(1, () => t('dbg_exec_switch', { params }));
        try {
            const condition = Interpreter.evaluateExpression(params);
            debugLog(1, () => t('dbg_switch_cond_value', { value: condition }));

            // 检查类型是否为int或string
            let typeError = false;
            if (typeof condition === 'number') {
                // 严格检查是否为整数
                if (!Number.isInteger(condition)) {
                    reportError(ExceptionType.TYPE_ERROR, t('switch_cond_int_only'));
                    typeError = true;
                }
            } else if (typeof condition !== 'string') {
                reportError(ExceptionType.TYPE_ERROR, t('switch_cond_type'));
                typeError = true;
            }

            if (typeError) {
                // 跳过整个switch块, 避免后续case/break/endswc继续报错
                let nestedLevel = 1;
                let i = currentLinePointer + 1;
                while (i < programLines.length && nestedLevel > 0) {
                    const line = programLines[i].trim();
                    if (line.startsWith('switch')) {
                        nestedLevel++;
                    } else if (line === 'endswc') {
                        nestedLevel--;
                        if (nestedLevel === 0) {
                            currentLinePointer = i; // 主循环会+1, 落到endswc下一行
                        }
                    }
                    i++;
                }
                return;
            }

            // 将条件值存储在控制流栈中
            CONTROL_FLOW_STACK.push({
                type: 'switch',
                condition: condition,
                hasMatched: false,
                inCaseBlock: false
            });
        } catch (error) {
            // 自定义异常 (如ReferenceError) 重新抛出, 供try-catch捕获
            if (error && typeof error === 'object' && (error as Exception).type !== undefined) {
                throw error;
            }
            reportError(ExceptionType.SYNTAX_ERROR, t('switch_cond_invalid', {expr: params}));
        }
    }

    // 执行case语句
    static executeCase(params: string): void {
        debugLog(1, () => t('dbg_handle_case'));
        // 检查是否在switch块内
        if (CONTROL_FLOW_STACK.length === 0 || CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1].type !== 'switch') {
            reportError(ExceptionType.SYNTAX_ERROR, t('case_outside_switch'));
            return;
        }

        const switchInfo = CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1];

        // 如果已经匹配过case或在default块中, 则跳过
        if ('hasMatched' in switchInfo && (switchInfo.hasMatched || switchInfo.inCaseBlock === 'default')) {
            // 跳过case块直到break或endswc
            let nestedLevel = 1;
            let i = currentLinePointer + 1;
            debugLog(2, () => t('dbg_skip_matched_switch', { params, level: nestedLevel }));
            while (i < programLines.length && nestedLevel > 0) {
                const line = programLines[i].trim();
                if (line.toLowerCase().startsWith('switch ')) {
                    nestedLevel++;
                    debugLog(2, () => t('dbg_nested_switch', { line, level: nestedLevel }));
                } else if (line === 'endswc') {
                    nestedLevel--;
                    debugLog(2, () => t('dbg_exit_nested_switch', { line, level: nestedLevel }));
                    if (nestedLevel === 0) {
                        currentLinePointer = i - 1; // 减1是因为主循环会加1并执行 endSwitch 清理流程栈
                        debugLog(2, () => t('dbg_nested_level_zero', { line: currentLinePointer }));
                        break;
                    }
                } else if (line === 'break') {
                    debugLog(2, () => t('dbg_handle_break', { line, level: nestedLevel }));
                    if (nestedLevel === 1) { // 只有在当前switch层级才处理break
                        currentLinePointer = i - 1; // 减1是因为主循环会加1并执行 break 跳出当前 switch 块
                        break;
                    }
                }
                i++;
            }
            return;
        }

        // 如果在未匹配的块中
        try {
            const caseValue = Interpreter.evaluateExpression(params);
            debugLog(2, () => t('dbg_case_value', { value: caseValue }));

            // 检查类型是否与switch条件类型匹配
            if (switchInfo.type === 'switch' && typeof caseValue !== typeof switchInfo.condition) {
                reportError(ExceptionType.TYPE_ERROR, t('case_type_mismatch'));
                // throw {
                //     type: ExceptionType.TYPE_ERROR,
                //     message: `类型错误: case值的类型必须与switch条件类型相同 在第 ${currentLinePointer + 1} 行`,
                //     lineNumber: currentLinePointer
                // } as Exception;
                return;
            }

            // 检查是否匹配
            if ('condition' in switchInfo && caseValue === switchInfo.condition) {
                switchInfo.hasMatched = true;
                switchInfo.inCaseBlock = 'case';
            } else {
                // 不匹配, 跳过case块直到break或下一个case/default
                let nestedLevel = 1;
                let i = currentLinePointer + 1;
                while (i < programLines.length && nestedLevel > 0) {
                    const line = programLines[i].trim();
                    if (line.toLowerCase().startsWith('switch ')) {
                        nestedLevel++;
                    } else if (line === 'endswc') {
                        nestedLevel--;
                    } else if ((line.toLowerCase().startsWith('case ') || line === 'case') || line === 'default') {
                        if (nestedLevel === 1) { // 只有在当前switch层级才处理
                            currentLinePointer = i; // 不减1因为主循环会加1并执行 case 或 default 而不是上一个可能的 break
                            break;
                        }
                    } else if (line === 'break') {
                        if (nestedLevel === 1) { // 只有在当前switch层级才处理break
                            currentLinePointer = i; // 不减1是因为主循环会加1并执行下一个语句
                            break;
                        }
                    }
                    i++;
                }
            }
        } catch (error) {
            // 自定义异常 (如ReferenceError) 重新抛出, 供try-catch捕获
            if (error && typeof error === 'object' && (error as Exception).type !== undefined) {
                throw error;
            }
            reportError(ExceptionType.SYNTAX_ERROR, t('case_value_invalid', {expr: params}));
        }
    }

    // 执行default语句
    static executeDefault(): void {
        // 检查是否在switch块内
        if (CONTROL_FLOW_STACK.length === 0 || CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1].type !== 'switch') {
            reportError(ExceptionType.SYNTAX_ERROR, t('default_outside_switch'));
            return;
        }

        const switchInfo = CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1];

        // 如果已经匹配过case, 则跳过default块
        if ('hasMatched' in switchInfo && switchInfo.hasMatched) {
            // 跳过default块直到break或endswc
            let nestedLevel = 1;
            let i = currentLinePointer + 1;
            while (i < programLines.length && nestedLevel > 0) {
                const line = programLines[i].trim();
                if (line === 'switch') {
                    nestedLevel++;
                } else if (line === 'endswc') {
                    nestedLevel--;
                    if (nestedLevel === 0) {
                        currentLinePointer = i - 1; // 减1是因为主循环会加1并执行 endSwitch 清理流程栈
                        break;
                    }
                } else if (line === 'break') {
                    if (nestedLevel === 1) { // 只有在当前switch层级才处理break
                        currentLinePointer = i - 1; // 减1是因为主循环会加1并执行 break 跳出当前 switch 块
                        break;
                    }
                }
                i++;
            }
            return;
        }

        // 进入default块
        if ('inCaseBlock' in switchInfo) {
            switchInfo.inCaseBlock = 'default';
        }
    }

    // 执行endswc语句
    static executeEndSwitch(): void {
        // 检查是否在switch块内
        if (CONTROL_FLOW_STACK.length === 0 || CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1].type !== 'switch') {
            reportError(ExceptionType.SYNTAX_ERROR, t('endswc_outside_switch'));
            return;
        }

        // 弹出switch信息
        CONTROL_FLOW_STACK.pop();
    }

    // 执行跳转指令 (严格格式: jump (condition) :tagname, 仅支持标签跳转) 
    static executeJump(params: string): void {
        debugLog(1, () => t('dbg_jump_params', { params }));
        // 1. 格式校验
        const match = params.match(/^\(([^)]+)\)\s*:\s*([a-zA-Z_]\w*)$/);
        if (!match) {
            reportError(ExceptionType.SYNTAX_ERROR, t('jump_format'));
            return;
        }

        // 2. 条件解析
        const conditionExpr = match[1].trim();
        const tagName = match[2].trim();

        if (!conditionExpr) {
            reportError(ExceptionType.SYNTAX_ERROR, t('cond_expr_empty'));
            return;
        }

        let condition: boolean;
        try {
            condition = Interpreter.evaluateExpression(conditionExpr);
        } catch (error) {
            // 自定义异常 (如ReferenceError) 重新抛出, 供try-catch捕获
            if (error && typeof error === 'object' && (error as Exception).type !== undefined) {
                throw error;
            }
            reportError(ExceptionType.SYNTAX_ERROR, t('cond_expr_invalid', {expr: conditionExpr}));
            return;
        }

        // 3. 条件不满足时直接返回
        if (!condition) {
            debugLog(2, () => t('dbg_jump_cond_false'));
            return;
        }

        // 4. 标签跳转 (仅支持标签, 不再检查行号) 
        if (TAGS[tagName] === undefined) {
            reportError(ExceptionType.REFERENCE_ERROR, t('tag_undefined', {name: tagName}));
            return;
        }

        currentLinePointer = TAGS[tagName]; // 跳转到标签位置
    }

    // 执行操作指令
    static executeOperation(command: string): void {
        DEBUG_LEVEL >= 1 && debugLog(1, () => t('dbg_exec_op_instr', { content: command }));

        // 使用表达式解析器来处理赋值操作
        try {
            const result = ExpressionEvaluator.evaluate(command.trim(), currentLinePointer);
            if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_parse_result'));
            // 检查是否是数组元素赋值
            if (result && typeof result === 'object' && result.type === 'array_assignment') {
                if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_detect_array_assign', { arrayName: result.target.arrayName, index: result.target.index }));
                const { target, value, binding } = result;
                // 处理 global. 前缀 (与整体赋值分支一致)
                let targetName: string = target.arrayName;
                let isGlobal: boolean = false;
                if (targetName.startsWith('global.')) {
                    targetName = targetName.slice('global.'.length);
                    isGlobal = true;
                }
                // 槽位快速路径: 局部数组 O(1) 读取; 槽位为空 (被 purge 等移除) 或无绑定 (全局/未注册) 回退原查找
                let arrayVar: Variable | null;
                if (binding) {
                    arrayVar = ExpressionEvaluator.readSlot(binding);
                    if (arrayVar === null) {
                        arrayVar = ScopeManager.getVariable(targetName, currentLinePointer, true, isGlobal);
                    }
                } else {
                    arrayVar = ScopeManager.getVariable(targetName, currentLinePointer, true, isGlobal);
                }
                // 检查变量是否存在且是数组类型
                if (!arrayVar) {
                    throw { type: ExceptionType.REFERENCE_ERROR, message: t('array_undefined', {name: targetName}), lineNumber: currentLinePointer } as Exception;
                }
                if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_array_name', { name: arrayVar.name }));

                if (arrayVar.type !== DataType.ARRAY) {
                    throw { type: ExceptionType.TYPE_ERROR, message: t('not_array_type', {name: targetName}), lineNumber: currentLinePointer } as Exception;
                }

                if (arrayVar.isConst) {
                    throw { type: ExceptionType.TYPE_ERROR, message: t('const_array_assignment', {name: targetName}), lineNumber: currentLinePointer } as Exception;
                }

                if (arrayVar.isReadonlyArray) {
                    throw { type: ExceptionType.TYPE_ERROR, message: t('readonly_array_assignment', {name: targetName}), lineNumber: currentLinePointer } as Exception;
                }

                // 检查索引是否在数组范围内
                if (target.index >= arrayVar.arrayLength!) {
                    throw { type: ExceptionType.RANGE_ERROR, message: t('arr_index_out_of_range', {index: target.index, length: arrayVar.arrayLength}), lineNumber: currentLinePointer } as Exception;
                }

                // 更新数组元素
                // 检查元素类型是否匹配
                const elementType = arrayVar.arrayElementType!;
                // 快速类型兼容路径: 原生值类型与目标类型直接匹配时免 validateType 调用 (每次调用分配结果对象)
                if ((elementType === DataType.INT && typeof value === 'number' && Number.isInteger(value)) ||
                    ((elementType === DataType.FLOAT || elementType === DataType.NUMBER) && typeof value === 'number') ||
                    (elementType === DataType.STRING && typeof value === 'string') ||
                    (elementType === DataType.BOOL && typeof value === 'boolean')) {
                    arrayVar.arrayElements![target.index].value = value;
                    return;
                }
                const validation = ScopeManager.validateType(value, elementType);
                if (!validation.isValid) {
                    throw { type: ExceptionType.TYPE_ERROR, message: t('array_element_type_mismatch', {expected: elementType, actual: typeof value}), lineNumber: currentLinePointer } as Exception;
                }

                // 更新数组元素
                if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_update_array_elem', { oldValue: arrayVar.arrayElements![target.index].value, newValue: validation.convertedValue }));
                arrayVar.arrayElements![target.index].value = validation.convertedValue;
                // ScopeManager.setVariable(target.arrayName, arrayVar, currentLinePointer);
                return;
            } else if (result && typeof result === 'object' && result.type === 'assignment') {
                if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_handle_assign', { command }));
                // 处理普通变量赋值
                const { target, value, binding } = result;
                let newTarget: string = target;
                let isGlobal: boolean = false;
                if (newTarget.startsWith('global.')) {
                    newTarget = newTarget.slice('global.'.length);
                    isGlobal = true;
                }

                // 槽位快速路径: 局部变量 O(1) 赋值 (global. 目标绑定为 null 不走此路径)
                if (binding) {
                    const lhsVar = ExpressionEvaluator.readSlot(binding);
                    // 槽位为空 (变量被 purge/帧清理移除): 回退下方通用查找路径 (可能命中全局变量)
                    if (lhsVar !== null) {
                        // 数组整体赋值: LHS 为数组变量且 RHS 求值为数组变量 → 引用赋值 (共享同一数组数据)
                        if (lhsVar.type === DataType.ARRAY &&
                            value && typeof value === 'object' && (value as Variable).type === DataType.ARRAY &&
                            Array.isArray((value as Variable).arrayElements)) {
                            if (lhsVar.isConst) {
                                throw {
                                    type: ExceptionType.TYPE_ERROR,
                                    message: t('const_array_whole_assignment', {name: newTarget}),
                                    lineNumber: currentLinePointer
                                } as Exception;
                            }
                            if (lhsVar.isReadonlyArray) {
                                throw {
                                    type: ExceptionType.TYPE_ERROR,
                                    message: t('readonly_array_whole_assignment', {name: newTarget}),
                                    lineNumber: currentLinePointer
                                } as Exception;
                            }
                            Interpreter.checkLoopVarWritable(newTarget);
                            // 引用赋值: LHS 与 RHS 共享同一数组数据
                            const rhsVar = value as Variable;
                            lhsVar.arrayLength = rhsVar.arrayLength;
                            lhsVar.arrayElementType = rhsVar.arrayElementType;
                            lhsVar.arrayElements = rhsVar.arrayElements;
                            // 只读传播: 从只读引用视图整体赋值得到的引用同样受只读保护, 防止透过 LHS 写穿原数组
                            if (rhsVar.isReadonlyArray) {
                                lhsVar.isReadonlyArray = true;
                            }
                            if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_arr_ref_assign', { newTarget, rhsName: rhsVar.name }));
                            return;
                        }
                        Interpreter.checkLoopVarWritable(newTarget);
                        // 快速 setVariable (const/类型检查 + 赋值, 语义与 setVariable 一致)
                        if (lhsVar.isConst) {
                            reportError(ExceptionType.TYPE_ERROR, t('const_assignment_forbidden', {name: newTarget}), currentLinePointer + 1);
                            return;
                        }
                        // 快速类型兼容路径: 原生值类型与目标类型直接匹配时免 validateType 调用 (每次调用分配结果对象)
                        if ((lhsVar.type === DataType.INT && typeof value === 'number' && Number.isInteger(value)) ||
                            ((lhsVar.type === DataType.FLOAT || lhsVar.type === DataType.NUMBER) && typeof value === 'number') ||
                            (lhsVar.type === DataType.STRING && typeof value === 'string') ||
                            (lhsVar.type === DataType.BOOL && typeof value === 'boolean')) {
                            lhsVar.value = value;
                            return;
                        }
                        const validation = ScopeManager.validateType(value, lhsVar.type);
                        if (!validation.isValid) {
                            reportError(ExceptionType.TYPE_ERROR, t('assign_type_mismatch', {value: value, name: newTarget, type: lhsVar.type}), currentLinePointer + 1);
                            return;
                        }
                        lhsVar.value = validation.convertedValue;
                        return;
                    }
                }

                // 检查是否为已声明变量
                if (ScopeManager.hasVariable(newTarget, currentLinePointer, isGlobal)) {
                    const lhsVar = ScopeManager.getVariableInfo(newTarget, currentLinePointer, isGlobal);
                    // 数组整体赋值: LHS 为数组变量且 RHS 求值为数组变量 → 引用赋值 (共享同一数组数据)
                    if (lhsVar && lhsVar.type === DataType.ARRAY &&
                        value && typeof value === 'object' && (value as Variable).type === DataType.ARRAY &&
                        Array.isArray((value as Variable).arrayElements)) {
                        if (lhsVar.isConst) {
                            throw {
                                type: ExceptionType.TYPE_ERROR,
                                message: t('const_array_whole_assignment', {name: newTarget}),
                                lineNumber: currentLinePointer
                            } as Exception;
                        }
                        if (lhsVar.isReadonlyArray) {
                            throw {
                                type: ExceptionType.TYPE_ERROR,
                                message: t('readonly_array_whole_assignment', {name: newTarget}),
                                lineNumber: currentLinePointer
                            } as Exception;
                        }
                        Interpreter.checkLoopVarWritable(newTarget);
                        // 引用赋值: LHS 与 RHS 共享同一数组数据
                        const rhsVar = value as Variable;
                        lhsVar.arrayLength = rhsVar.arrayLength;
                        lhsVar.arrayElementType = rhsVar.arrayElementType;
                        lhsVar.arrayElements = rhsVar.arrayElements;
                        // 只读传播: 从只读引用视图整体赋值得到的引用同样受只读保护, 防止透过 LHS 写穿原数组
                        if (rhsVar.isReadonlyArray) {
                            lhsVar.isReadonlyArray = true;
                        }
                        debugLog(1, () => t('dbg_arr_ref_assign', { newTarget, rhsName: rhsVar.name }));
                    } else {
                        Interpreter.checkLoopVarWritable(newTarget);
                        ScopeManager.setVariable(newTarget, value, currentLinePointer, isGlobal);
                    }
                } else {
                    // 未定义变量抛引用错误 (可被try-catch捕获)
                    throw {
                        type: ExceptionType.REFERENCE_ERROR,
                        message: t('var_undefined_scope', {scope: isGlobal ? '全局' : '局部', name: newTarget}),
                        lineNumber: currentLinePointer
                    } as Exception;
                }
            } else if (command.includes('=')) {
                debugLog(1, () => t('dbg_handle_assign_eq', { command }));
                // 手动切分: 避免 split('=') + map(trim) 的数组分配
                const eqIdx = command.indexOf('=');
                let newLhs = command.substring(0, eqIdx).trim();
                const rhs = command.substring(eqIdx + 1).trim();

                let isGlobal: boolean = false;
                if (newLhs.startsWith('global.')) {
                    newLhs = newLhs.slice('global.'.length);
                    isGlobal = true;
                }
                // 检查是否为已声明变量
                if (ScopeManager.hasVariable(newLhs, currentLinePointer, isGlobal)) {
                    const value = Interpreter.evaluateExpression(rhs);
                    Interpreter.checkLoopVarWritable(newLhs);
                    ScopeManager.setVariable(newLhs, value, currentLinePointer, isGlobal);
                } else {
                    // 未定义变量抛引用错误 (可被try-catch捕获)
                    throw {
                        type: ExceptionType.REFERENCE_ERROR,
                        message: t('var_undefined_scope', {scope: isGlobal ? '全局' : '局部', name: newLhs}),
                        lineNumber: currentLinePointer
                    } as Exception;
                }
            }
        } catch (error) {
            // 解释器自定义异常 (如ReferenceError) 重新抛出, 交由主循环决定是否被try-catch捕获
            if (error && typeof error === 'object' && (error as Exception).type !== undefined) {
                throw error;
            }
            reportError(ExceptionType.SYNTAX_ERROR, t('execute_operation_failed', {command: command, error: error}));
            // 可以选择设置变量为undefined或其他默认值
        }
    }

    // 检查目标变量是否为只读的循环变量 (for循环的更新表达式豁免)
    static checkLoopVarWritable(varName: string): void {
        if (varName === FOR_UPDATE_VAR) return; // 循环更新表达式执行中, 豁免只读检查
        for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
            const block = CONTROL_FLOW_STACK[i];
            if (block.type === 'for' && block.varName === varName) {
                // 仅当赋值目标确实是该 for 循环变量时 (作用域起始行匹配) 才报错,
                // 避免误伤函数内与循环变量同名的局部变量/参数
                const targetInfo = ScopeManager.getVariableInfo(varName, currentLinePointer, false);
                if (targetInfo && targetInfo.startLine === block.start) {
                    throw {
                        type: ExceptionType.TYPE_ERROR,
                        message: t('loop_var_readonly', {name: varName}),
                        lineNumber: currentLinePointer
                    } as Exception;
                }
            }
        }
    }

    // 表达式求值
    static evaluateExpression(expr: string): any {
        try {
            // 使用新的表达式解析器
            return ExpressionEvaluator.evaluate(expr.trim(), currentLinePointer);
        } catch (e) {
            // 解释器自定义异常 (如ReferenceError) 重新抛出, 交由主循环决定是否被try-catch捕获
            if (e && typeof e === 'object' && (e as Exception).type !== undefined) {
                throw e;
            }
            debugLog(1, () => t('dbg_expr_eval_err', { expr, line: currentLinePointer + 1, error: e }));
            // 重新抛出错误, 以便调用者可以处理
            throw {
                type: ExceptionType.UNKNOWN_ERROR,
                message: t('expr_eval_error', {expr: expr, inner: (e as Error).message}),
                lineNumber: currentLinePointer
            } as Exception;
        }
    }

    // 执行清除指令
    static executePurge(params: string): void {
        debugLog(1, () => t('dbg_exec_purge', { params }));
        // 判断是否包含except
        if (params.includes('except')) {
            const match = params.match(/^(.*?)\s+except\s+(.*)$/);
            if (!match) {
                reportError(ExceptionType.SYNTAX_ERROR, t('except_format_error'));
                return;
            }
            debugLog(1, () => t('dbg_except_matched'));
            const beforeExcept = match[1].trim().split(/\s+/);
            const afterExcept = match[2].trim().split(/\s+/);
            if (beforeExcept.length !== 1 || beforeExcept[0] !== 'all') {
                reportError(ExceptionType.SYNTAX_ERROR, t('except_requires_all'));
                return;
            } else if (beforeExcept.length === 1 && beforeExcept[0] === 'all') {
                debugLog(1, () => t('dbg_except_vars', { vars: afterExcept }));
                if (afterExcept.length === 0) {
                    throw { type: ExceptionType.SYNTAX_ERROR, message: t('except_requires_var'), lineNumber: currentLinePointer } as Exception;
                }
                for (let i = 0; i < afterExcept.length; i++) {
                    if (afterExcept[i].startsWith('global.')) {
                        throw { type: ExceptionType.SYNTAX_ERROR, message: t('except_local_only'), lineNumber: currentLinePointer } as Exception;
                    }
                }
                let remainedVars: Variable[] = [];
                for (let i = 0; i < afterExcept.length; i++) {
                    let remainedVar = ScopeManager.getVariableInfo(afterExcept[i], currentLinePointer);
                    if (remainedVar) {
                        remainedVars[i] = remainedVar;
                    }
                }
                // 清除所有局部变量再将排除的局部变量恢复
                ScopeManager.cleanupLocalVariable(true);
                LOCAL_VARS = remainedVars;
                rebuildSlotIndex(); // 槽位索引同步 (排除变量已恢复)
                debugLog(1, () => t('dbg_except_restored', { vars: LOCAL_VARS.map(varInfo => varInfo.name) }));
                return;
            }
        }
        // 判断是否全部清除
        else if (params === 'all') {
            ScopeManager.cleanupLocalVariable(true);
            debugLog(1, () => t('dbg_purge_all_done'));
            return;
        }
        // 清除全局变量
        else if (params.startsWith('global.')) {
            let globalVarName: string = params.slice('global.'.length);
            if (ScopeManager.hasVariable(globalVarName, currentLinePointer, true)) {
                ScopeManager.cleanupGlobalVariable(globalVarName);
            }
            else {
                debugLog(1, () => t('dbg_global_var_not_exists', { name: globalVarName }));
            }
            debugLog(1, () => t('dbg_global_var_cleared', { name: globalVarName }));
            return;
        }
        else {
            // 清除指定变量
            let cleanedVars = params.trim().split(/\s+/);
            let currentFuncName = ScopeManager.getCurrentFunction(currentLinePointer);
            if (currentFuncName) {
                const funcInfo = FUNCTIONS[currentFuncName];
                const { startLine: funcStartLine, endLine: funcEndLine } = funcInfo;
                for (let i = 0; i < cleanedVars.length; i++) {
                    debugLog(2, () => t('dbg_purge_var_num', { index: i + 1, name: cleanedVars[i] }))
                    let varInfo = ScopeManager.getVariableInfo(cleanedVars[i], currentLinePointer);
                    if (varInfo && varInfo.startLine >= funcStartLine && varInfo.endLine <= funcEndLine) {
                        ScopeManager.cleanupLocalVariable(false, false, varInfo.name, varInfo.startLine, varInfo.endLine, varInfo.frameId);
                        debugLog(2, () => t('dbg_purged_var', { name: varInfo.name, start: varInfo.startLine + 1, end: varInfo.endLine === -1 ? t('dbg_last_line') : varInfo.endLine + 1 }));
                    }
                }
                debugLog(1, () => t('dbg_purge_done'));
            }
            else {
                reportError(ExceptionType.SYNTAX_ERROR, t('purge_local_outside_func'));
            }
        }
    }

    // 执行遇到没有return语句的函数的善后工作
    static executeFunctionEndTag(): void {
        if (CONTROL_FLOW_STACK.length === 0) {
            reportError(ExceptionType.SYNTAX_ERROR, t('stray_func_end_tag'));
            return;
        } else {
            const block = CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1];
            if (block.type === 'function') {
                // 没有显式return到达函数结束标记，先弹出函数帧再处理
                const funcInfo = FUNCTIONS[block.funcName];
                // 清理本帧局部变量: 帧变量按 LIFO 连续位于 LOCAL_VARS 尾部, 截断到调用时位置即可 (O(1), 替代 O(n) filter)
                // 注意: 无需重建槽位索引 — 函数帧ID单调递增不复用, 被清理帧的陈旧槽位条目不可达
                LOCAL_VARS.length = block.frameVarStart;
                // 回收该帧的槽位索引条目, 防止 SLOT_INDEX 随调用次数无限增长
                delete SLOT_INDEX[String(block.frameId)];
                CONTROL_FLOW_STACK.pop();
                if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_func_end_local_vars', { name: funcInfo.name }), LOCAL_VARS);
                if (!ScopeManager.isVoidFunction(funcInfo)) {
                    reportError(ExceptionType.TYPE_ERROR, t('func_reached_end_no_return', {name: funcInfo.name, type: funcInfo.returnType}));
                    currentLinePointer = block.callFrom;
                    return;
                } else {
                    if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_func_void_return', { name: funcInfo.name }))
                    currentLinePointer = block.callFrom;
                    return;
                }
            } else {
                reportError(ExceptionType.SYNTAX_ERROR, t('unknown_func_end_tag'));
                return;
            }
        }
    }

    // 命名规则检查函数
    static isValidIdentifier(name: string): boolean {
        // 检查是否为空
        if (!name || name.length === 0) {
            return false;
        }

        // 检查第一个字符是否为字母或下划线或冒号
        if (!/^[a-zA-Z_:]/.test(name.charAt(0))) {
            return false;
        }

        // 检查其余字符是否为字母、数字或下划线
        if (!/^[a-zA-Z0-9_]+$/.test(name)) {
            return false;
        }

        // 检查是否为关键字 (保留字) 
        if (keywords.includes(name.toLowerCase())) {
            return false;
        }

        return true;
    }
}

// 表达式求值器
// 表达式树节点: 求值前先把 token 序列解析成树 (纯结构, 不含运行时值), 缓存树后每次执行只遍历求值。
// 变量/数组访问/函数调用等节点在求值时实时查作用域, 故树可安全跨执行共享 (与 token 缓存同批安全原则)。
interface ExprNode {
    kind: 'literal' | 'variable' | 'binary' | 'unary' | 'call' | 'arrayAccess' | 'assignment' | 'arrayAssignment';
    value?: any;          // literal 字面量值 (数字/字符串/布尔已在建树期确定)
    name?: string;        // variable 变量名 / arrayAccess 数组名 (含 global. 前缀) / call 函数名
    isGlobal?: boolean;   // variable / arrayAccess 是否全局访问
    op?: string;          // binary / unary 运算符
    left?: ExprNode;      // binary 左操作数
    right?: ExprNode;     // binary 右操作数
    operand?: ExprNode;   // unary 操作数
    funcName?: string;    // call 函数名
    args?: ExprNode[];    // call 参数树列表
    index?: ExprNode;     // arrayAccess 索引表达式树
    target?: string | { arrayName: string, index: ExprNode }; // assignment: 变量名; arrayAssignment: 数组目标
    valueExpr?: ExprNode; // assignment / arrayAssignment 右值表达式树
    // 静态槽位绑定 (局部变量热路径 O(1) 访问用; 全局变量/未注册引用为 undefined 走原查找路径)
    slotBinding?: { frameKey: string, slot: number };      // variable / arrayAccess
    targetBinding?: { frameKey: string, slot: number };    // assignment 目标
    arrayTargetBinding?: { frameKey: string, slot: number };// arrayAssignment 数组目标
    // 阶段2: 表达式字节码 (树首次求值时惰性编译并挂载; 与树同生命周期, 树缓存清空则一并失效)
    bytecode?: ExprCode | null;  // null = 不可编译 (整体回退树求值)
}

// ===== 阶段2: 表达式字节码 VM =====
// 表达式级寄存器虚拟机: 把已缓存的表达式树编译为 Int32Array 扁平指令流 (免重复切词/建树/树遍历递归),
// 临时寄存器保存中间结果。语义与 evalTree 完全复刻 (变量检查顺序/运算符类型检查/除零/非短路等)。
// 注: 求值器不含任何跳转指令 → AND/OR 不可能短路, 两操作数无条件先求值 (副作用严防死守)。

// 表达式级操作码 (阶段2专用; 阶段3全块 VM 的指令集见 bytecode-vm-design.md §3)
enum ExprOp {
    LOADK = 0,     // regs[a] = consts[b]
    LOADVAR = 1,   // regs[a] = 读变量(vars[b]) (槽位快速路径 → 无绑定/槽位空回退原查找; 先存在性后值检查)
    UNPOS = 2,     // regs[a] = +regs[b]
    NEG = 3,       // regs[a] = -regs[b]
    NOT = 4,       // regs[a] = !regs[b]
    ADD = 5, SUB = 6, MUL = 7, DIV = 8, MOD = 9, POW = 10,
    EQ = 11, NEQ = 12, LT = 13, GT = 14, LE = 15, GE = 16,
    AND = 17, OR = 18,
    GETARRAY = 19,   // regs[a] = regs[arrReg][regs[idxReg]] (数组元素读取, 语义复刻 evalTree 'arrayAccess': 索引检查先于数组查找/越界)
}

// 二元运算符 → 操作码映射 (仅可编译子集; 其余构造整体回退树求值)
const EXPR_BIN_OP_TO_VM: Record<string, ExprOp> = {
    '+': ExprOp.ADD, '-': ExprOp.SUB, '*': ExprOp.MUL, '/': ExprOp.DIV, '%': ExprOp.MOD, '**': ExprOp.POW,
    '==': ExprOp.EQ, '!=': ExprOp.NEQ, '<': ExprOp.LT, '>': ExprOp.GT, '<=': ExprOp.LE, '>=': ExprOp.GE,
    '&&': ExprOp.AND, '||': ExprOp.OR
};
const EXPR_BIN_OPS: Set<string> = new Set(Object.keys(EXPR_BIN_OP_TO_VM));

// 编译期变量绑定 (槽位绑定或全局/未注册引用, 供 LOADVAR 复刻 evalTree 'variable' 分支语义)
interface CompiledVar {
    name: string;
    lookupName: string;  // 去掉 'global.' 前缀的查找名 (编译期预计算, 免运行期字符串操作)
    isGlobal: boolean;
    binding?: { frameKey: string, slot: number };
}

// 表达式编译产物
interface ExprCode {
    code: Int32Array;                  // [op, a, b, c] × n 扁平指令流
    consts: any[];                     // 字面量常量池
    vars: CompiledVar[];               // 变量绑定表
    nTemps: number;                    // 临时寄存器数 (寄存器 0 恒为结果寄存器)
    resultKind: 'value' | 'assignment';
    target?: string;                   // resultKind='assignment' 时的目标变量名
    targetBinding?: { frameKey: string, slot: number };  // assignment 目标槽位绑定
    nTokens: number;                   // 整表达式 token 数 (数组访问错误消息的 pos, 复刻 evalTree 的 currentTokenIndex=tokens.length)
    hasArray: boolean;                 // 指令流是否含 GETARRAY (含数组访问的表达式走独立执行循环, 避免 GETARRAY 复杂分支拖累主分发循环的 V8 优化)
}

// 表达式树 → 字节码编译器 (仅处理 literal/variable/binary/unary; 可编译性由调用方先判定)
class ExprBytecodeCompiler {
    private code: number[] = [];
    private consts: any[] = [];
    private constIdx = new Map<any, number>();
    private vars: CompiledVar[] = [];
    private varIdx = new Map<string, number>();
    private nTemps = 1;  // 寄存器 0 保留给表达式结果
    private sawArray = false;  // 是否已编译数组访问 (含 GETARRAY → hasArray 标记)

    private constIndex(value: any): number {
        const existing = this.constIdx.get(value);
        if (existing !== undefined) return existing;
        const idx = this.consts.length;
        this.consts.push(value);
        this.constIdx.set(value, idx);
        return idx;
    }

    private varIndex(name: string, isGlobal: boolean, binding?: { frameKey: string, slot: number }): number {
        const key = binding ? `s:${binding.frameKey}:${binding.slot}` : `g:${isGlobal ? 1 : 0}:${name}`;
        const existing = this.varIdx.get(key);
        if (existing !== undefined) return existing;
        const idx = this.vars.length;
        const lookupName = isGlobal && name.startsWith('global.') ? name.slice('global.'.length) : name;
        this.vars.push({ name, lookupName, isGlobal, binding });
        this.varIdx.set(key, idx);
        return idx;
    }

    private allocTemp(): number {
        return this.nTemps++;
    }

    private emit(op: ExprOp, a: number, b: number, c: number): void {
        this.code.push(op, a, b, c);
    }

    // 把节点值计算到寄存器 dst (先算子节点入临时寄存器, 再运算入 dst; 求值顺序与 evalTree 一致: 左→右→运算)。
    // 公开供 ExpressionEvaluator.compileExprToBytecode 以任意节点为根编译 (结果寄存器恒为 0)。
    compileNode(node: ExprNode, dst: number): void {
        switch (node.kind) {
            case 'literal':
                this.emit(ExprOp.LOADK, dst, this.constIndex(node.value), 0);
                break;
            case 'variable':
                this.emit(ExprOp.LOADVAR, dst, this.varIndex(node.name as string, !!node.isGlobal, node.slotBinding), 0);
                break;
            case 'arrayAccess': {
                // 数组元素读取: 索引先求值入临时寄存器, 再 GETARRAY (数组查找/检查在 GETARRAY 执行期进行,
                // 复刻 evalTree 'arrayAccess' 的检查顺序: 索引类型/非负检查 → 数组存在与类型 → 越界 → 取值)
                this.sawArray = true;
                const idx = this.allocTemp();
                this.compileNode(node.index as ExprNode, idx);
                this.emit(ExprOp.GETARRAY, dst, this.varIndex(node.name as string, !!node.isGlobal, node.slotBinding), idx);
                break;
            }
            case 'unary': {
                const t = this.allocTemp();
                this.compileNode(node.operand as ExprNode, t);
                const op = node.op as string;
                if (op === '-') this.emit(ExprOp.NEG, dst, t, 0);
                else if (op === '+') this.emit(ExprOp.UNPOS, dst, t, 0);
                else this.emit(ExprOp.NOT, dst, t, 0);
                break;
            }
            case 'binary': {
                const t1 = this.allocTemp();
                const t2 = this.allocTemp();
                this.compileNode(node.left as ExprNode, t1);
                this.compileNode(node.right as ExprNode, t2);
                this.emit(EXPR_BIN_OP_TO_VM[node.op as string], dst, t1, t2);
                break;
            }
        }
    }

    build(nTokens: number): ExprCode {
        return {
            code: new Int32Array(this.code),
            consts: this.consts,
            vars: this.vars,
            nTemps: this.nTemps,
            resultKind: 'value',
            nTokens: nTokens,
            hasArray: this.sawArray
        };
    }
}

class ExpressionEvaluator {
    private static currentLine: number;
    private static tokens: string[];
    private static currentTokenIndex: number;
    // // 简单的缓存机制, 用于存储已计算的表达式结果
    // private static cache: Map<string, any> = new Map();
    // // 缓存大小限制, 防止内存泄漏
    // private static readonly MAX_CACHE_SIZE = 1000;

    // 公共入口方法
    static evaluate(expression: string, currentLine: number): any {
        this.currentLine = currentLine;
        try {
            // 表达式树缓存: 树为纯结构 (不含运行时值), 同一表达式首次执行时解析建树, 之后每次执行直接遍历求值。
            // 树节点携带静态槽位绑定 (依赖当前程序的符号表), 故缓存按程序指纹 (PROGRAM_ID) 隔离;
            // 变量/数组访问/函数调用等节点的运行时值仍在求值时实时查作用域。
            // 两级 Map (programId → 表达式 → 树): 免每次求值的 key 字符串拼接 (热路径分配)。
            let programTrees = ExpressionEvaluator.treeCacheByProgram.get(PROGRAM_ID);
            if (programTrees === undefined) {
                programTrees = new Map<string, ExprNode>();
                ExpressionEvaluator.treeCacheByProgram.set(PROGRAM_ID, programTrees);
            }
            let tree = programTrees.get(expression);
            if (tree === undefined) {
                // 树缓存未命中: 需要词法分析 + 建树 (词法结果同样缓存, 供建树失败需重复解析的场景复用)
                let cachedTokens = ExpressionEvaluator.tokenCache.get(expression);
                if (cachedTokens === undefined) {
                    cachedTokens = this.tokenize(expression);
                    if (ExpressionEvaluator.tokenCache.size >= ExpressionEvaluator.MAX_TOKEN_CACHE) {
                        ExpressionEvaluator.tokenCache.clear();
                    }
                    ExpressionEvaluator.tokenCache.set(expression, cachedTokens);
                }
                this.tokens = cachedTokens;
                this.currentTokenIndex = 0;

                if (this.tokens.length === 0) {
                    return undefined;
                }

                tree = this.buildExpressionTree();

                // 检查是否还有未处理的令牌
                if (this.currentTokenIndex < this.tokens.length) {
                    throw { type: ExceptionType.SYNTAX_ERROR, message: t('unexpected_token_after_parse', {token: this.tokens[this.currentTokenIndex]}), lineNumber: this.currentLine } as Exception;
                }

                if (programTrees.size >= ExpressionEvaluator.MAX_TREE_CACHE) {
                    programTrees.clear();
                }
                programTrees.set(expression, tree);
            }

            // 阶段2: 表达式字节码路径 — 可编译表达式 (字面量/变量/一元/二元, 含赋值右值) 走
            // Int32Array 扁平指令流的寄存器 VM; 不可编译构造 (函数调用/数组访问/数组赋值等) 编译期
            // 判定为 null 后整表达式原子回退树求值 (绝不部分混合执行, 杜绝寄存器状态不同步)。
            // 字节码携带静态槽位绑定, 惰性编译并挂载于树节点 (树按程序指纹隔离, 字节码与树同生命周期)。
            if (tree.bytecode === undefined) {
                tree.bytecode = ExpressionEvaluator.compileExprToBytecode(tree);
            }
            if (tree.bytecode !== null) {
                return this.runExprCode(tree.bytecode, currentLine);
            }

            return this.evalTree(tree);
        } catch (error) {
            // 统一将表达式求值中的原生 JS Error 转换为 NS 异常 (可被 try-catch 捕获); 已是 NS 异常则原样返回。
            // 内联于 evaluate 而非外提: 外提会缩小 evaluate 体积, Turbofan 会将其内联进 NSVMExecutor.run 的
            // OSR 图 (连带 compileExprToBytecode), 使 run OSR 编译耗时从 ~13ms 增至 ~18ms (冷启动回归来源)。
            if (error && typeof error === 'object' && (error as Exception).type !== undefined) {
                throw error;
            }
            const msg = (error as Error).message || String(error);
            let type: ExceptionType;
            if (/^TypeError|类型错误|类型不匹配|需要 \d+ 个参数|只能用于|必须是数字|要求.*操作数|expects .* argument|must be a|must be of type|requires .* operand/.test(msg)) {
                type = ExceptionType.TYPE_ERROR;
            } else if (/^RangeError|范围错误|越界|除零|必须是非负整数|out of range|division by zero|must be non-negative|must be within/.test(msg)) {
                type = ExceptionType.RANGE_ERROR;
            } else if (/未知函数|未定义的数组|unknown function|is not defined/.test(msg)) {
                type = ExceptionType.REFERENCE_ERROR;
            } else if (/意外的|缺少|无效的|未知操作|意外结束|意外字符|unexpected|missing|invalid|unknown operation|unexpected end/.test(msg)) {
                type = ExceptionType.SYNTAX_ERROR;
            } else {
                type = ExceptionType.UNKNOWN_ERROR;
            }
            throw {
                type: type,
                message: msg,
                lineNumber: currentLine
            } as Exception;
        }
    }

    // 统一将表达式求值中的原生 JS Error 转换为 NS 异常 (可被 try-catch 捕获); 已是 NS 异常则原样返回
    private static wrapEvalError(error: any, currentLine: number): Exception {
        if (error && typeof error === 'object' && (error as Exception).type !== undefined) {
            return error as Exception;
        }
        const msg = (error as Error).message || String(error);
        let type: ExceptionType;
        if (/^TypeError|类型错误|类型不匹配|需要 \d+ 个参数|只能用于|必须是数字|要求.*操作数|expects .* argument|must be a|must be of type|requires .* operand/.test(msg)) {
            type = ExceptionType.TYPE_ERROR;
        } else if (/^RangeError|范围错误|越界|除零|必须是非负整数|out of range|division by zero|must be non-negative|must be within/.test(msg)) {
            type = ExceptionType.RANGE_ERROR;
        } else if (/未知函数|未定义的数组|unknown function|is not defined/.test(msg)) {
            type = ExceptionType.REFERENCE_ERROR;
        } else if (/意外的|缺少|无效的|未知操作|意外结束|意外字符|unexpected|missing|invalid|unknown operation|unexpected end/.test(msg)) {
            type = ExceptionType.SYNTAX_ERROR;
        } else {
            type = ExceptionType.UNKNOWN_ERROR;
        }
        return {
            type: type,
            message: msg,
            lineNumber: currentLine
        } as Exception;
    }

    // 编译期预解析 (NSVM SETARRAY 探测): 仅建树不执行, 与运行期 evaluate 的解析完全一致
    // (tokenize/建树缓存复用); 返回树与整表达式 token 数 (错误消息 pos), 解析失败返回 null。
    // 解析期间置 silentCompileParse 禁止调试输出 (编译期行指针非目标行, 日志会污染运行期输出)。
    static parseExpressionTree(expression: string, currentLine: number): { tree: ExprNode; nTokens: number } | null {
        const prevSilent = silentCompileParse;
        silentCompileParse = true;
        try {
            this.currentLine = currentLine;
            let cachedTokens = this.tokenCache.get(expression);
            if (cachedTokens === undefined) {
                cachedTokens = this.tokenize(expression);
                if (this.tokenCache.size >= this.MAX_TOKEN_CACHE) this.tokenCache.clear();
                this.tokenCache.set(expression, cachedTokens);
            }
            this.tokens = cachedTokens;
            this.currentTokenIndex = 0;
            if (this.tokens.length === 0) return null;
            const tree = this.buildExpressionTree();
            if (this.currentTokenIndex < this.tokens.length) return null;
            return { tree: tree, nTokens: this.tokens.length };
        } catch (e) {
            return null;
        } finally {
            silentCompileParse = prevSilent;
        }
    }

    // NSVM SETARRAY 指令专用: 以整表达式 token 上下文直接求值已解析树 (跳过 tokenize/建树/编译尝试/结果分发)。
    // currentTokenIndex = nTokens 使错误消息 pos 与行解释器整表达式求值逐字节一致; 原生 JS Error 包装同 evaluate。
    static evalTreeWithContext(tree: ExprNode, nTokens: number, currentLine: number): any {
        this.currentLine = currentLine;
        this.currentTokenIndex = nTokens;
        try {
            return this.evalTree(tree);
        } catch (error) {
            throw this.wrapEvalError(error, currentLine);
        }
    }

    // ===== 阶段2: 表达式字节码 VM (编译/缓存/执行) =====

    // 共享寄存器数组: 表达式求值为单遍线性执行, 无递归重入 (求值期间不会再次调用 evaluate/runExprCode),
    // 故可跨表达式复用, 消除每次求值的 new Array 分配 (GC 压力)。每条指令写后才读, 无需清零。
    private static scratchRegs: any[] = [];

    // 可编译性判定: 仅 literal/variable/binary/unary (运算符限定), 其余构造整体回退树求值
    private static isExprCompilable(node: ExprNode): boolean {
        switch (node.kind) {
            case 'literal':
            case 'variable':
                return true;
            case 'unary': {
                const op = node.op as string;
                return (op === '+' || op === '-' || op === '!') && ExpressionEvaluator.isExprCompilable(node.operand as ExprNode);
            }
            case 'binary': {
                const op = node.op as string;
                return EXPR_BIN_OPS.has(op) &&
                    ExpressionEvaluator.isExprCompilable(node.left as ExprNode) &&
                    ExpressionEvaluator.isExprCompilable(node.right as ExprNode);
            }
            case 'arrayAccess':
                // 数组元素读取回退树求值 (设计稿 §348/370: 数组访问为不可编译构造 → 整表达式原子回退树求值)。
                // BISECT 结论: evaluate 的树缓存已消除重复解析, evalTree 对短数组读表达式快于 GETARRAY 字节码循环
                // (GETARRAY 完整实现 2048 端到端 +6~8%, 回退后无劣化), 故编译策略不生成 GETARRAY 指令;
                // GETARRAY 指令保留于 VM 指令集 (设计稿 §7), 供未来复杂表达式编译策略启用。
                return false;
            default:
                return false; // call / assignment / arrayAssignment
        }
    }

    // 表达式树 → ExprCode (根节点为赋值时编译右值, 返回结构复刻 evalTree 'assignment' 分支); 不可编译返回 null
    private static compileExprToBytecode(tree: ExprNode): ExprCode | null {
        const nTokens = this.tokens.length; // 错误消息 pos (复刻 evalTree 中 currentTokenIndex=tokens.length)
        if (tree.kind === 'assignment') {
            const rhs = tree.valueExpr as ExprNode;
            if (!ExpressionEvaluator.isExprCompilable(rhs)) return null;
            const compiler = new ExprBytecodeCompiler();
            compiler.compileNode(rhs, 0); // 结果恒入寄存器 0
            const built = compiler.build(nTokens);
            built.resultKind = 'assignment';
            built.target = tree.target as string;
            built.targetBinding = tree.targetBinding;
            return built;
        }
        if (!ExpressionEvaluator.isExprCompilable(tree)) return null;
        const compiler = new ExprBytecodeCompiler();
        compiler.compileNode(tree, 0);
        return compiler.build(nTokens);
    }

    // 读取变量 (LOADVAR 语义): 槽位快速路径 → 回退原查找; 检查顺序: 存在性 (REFERENCE_ERROR) → 值 (undefined→TYPE_ERROR)
    private static loadVar(v: CompiledVar, currentLine: number): any {
        if (v.binding) {
            const varInfo = ExpressionEvaluator.readSlot(v.binding);
            if (varInfo !== null) {
                if (varInfo.type === DataType.ARRAY) return varInfo;
                if (varInfo.value === undefined) {
                    throw { type: ExceptionType.TYPE_ERROR, message: t('var_value_undefined', { name: v.name }), lineNumber: currentLine } as Exception;
                }
                return varInfo.value;
            }
        }
        const varInfo = ScopeManager.getVariableInfo(v.name, currentLine, v.isGlobal);
        if (varInfo === null) {
            throw {
                type: ExceptionType.REFERENCE_ERROR,
                message: v.isGlobal ? t('var_undefined_expr_global', { name: v.name }) : t('var_undefined_expr_local', { name: v.name }),
                lineNumber: currentLine
            } as Exception;
        }
        if (varInfo.type === DataType.ARRAY) {
            DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_return_array', { scope: v.isGlobal ? t('dbg_scope_global') : '', name: varInfo.name, line: currentLine + 1 }));
            return varInfo;
        }
        if (varInfo.value === undefined) {
            throw { type: ExceptionType.TYPE_ERROR, message: t('var_value_undefined', { name: v.name }), lineNumber: currentLine } as Exception;
        }
        DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_return_var_value', { scope: v.isGlobal ? t('dbg_scope_global') : '', name: v.name, value: varInfo.value, line: currentLine + 1 }));
        return varInfo.value;
    }

    // GETARRAY 错误路径 (冷): 逐项检查复刻 evalTree 'arrayAccess', 构造精确错误消息。
    // 独立成方法使热路径 case 保持极简, 避免大段 throw 分支拖累 runExprCode 分发循环优化。
    private static getArrayAccessError(arr: Variable | null, idx: any, cv: CompiledVar, currentLine: number, pos: number): Exception {
        if (typeof idx !== 'number') {
            return { type: ExceptionType.TYPE_ERROR, message: t('array_index_not_number', {pos}), lineNumber: currentLine } as Exception;
        }
        if (!Number.isInteger(idx) || idx < 0) {
            return { type: ExceptionType.RANGE_ERROR, message: t('array_index_not_nonneg_int', {pos}), lineNumber: currentLine } as Exception;
        }
        if (arr === null || arr.type !== DataType.ARRAY) {
            return { type: ExceptionType.TYPE_ERROR, message: t('array_var_not_array', {name: cv.lookupName, pos}), lineNumber: currentLine } as Exception;
        }
        if (idx >= (arr.arrayLength || 0)) {
            return { type: ExceptionType.RANGE_ERROR, message: t('array_index_out_of_range_access', {index: idx, name: cv.lookupName, max: arr.arrayLength ? arr.arrayLength - 1 : -1, pos}), lineNumber: currentLine } as Exception;
        }
        return { type: ExceptionType.UNKNOWN_ERROR, message: t('array_element_access_error', {name: cv.lookupName, index: idx, pos}), lineNumber: currentLine } as Exception;
    }

    // 表达式字节码执行器: Int32Array 扁平指令循环, 寄存器 0 为结果寄存器。
    // 语义与 evalTree 逐分支复刻 (变量: 槽位快速路径 → 回退原查找, 先存在性(REFERENCE_ERROR)后值(undefined→TYPE_ERROR);
    // 一元/二元: 数字快速路径 + evaluateOperation/evaluateUnaryOperation 完整类型检查与除零检查;
    // AND/OR 非短路: 本求值器无跳转指令, 两操作数必已无条件求值)。
    // 性能架构: 主循环不含 GETARRAY (含数组访问的表达式经 hasArray 分发到 runExprCodeArr)。
    // 原因: GETARRAY 的查找/检查/错误分支会让 V8 对含它的分发循环整体降速 (BISECT: GETARRAY 置空时
    // 2048 端到端 -14.6%, 完整实现 +6~8%), 而 2048 中绝大多数表达式不含数组访问。
    private static runExprCode(ec: ExprCode, currentLine: number): any {
        const code = ec.code;
        const consts = ec.consts;
        // 单指令快速路径 (纯字面量/单变量): 免循环与寄存器数组, 直接返回结果
        if (code.length === 4) {
            const result = code[0] === ExprOp.LOADK
                ? consts[code[2]]
                : ExpressionEvaluator.loadVar(ec.vars[code[2]], currentLine);
            if (ec.resultKind === 'assignment') {
                return { type: 'assignment', target: ec.target as string, value: result, binding: ec.targetBinding };
            }
            return result;
        }
        const vars = ec.vars;
        const regs = ExpressionEvaluator.scratchRegs;
        if (regs.length < ec.nTemps) {
            regs.length = ec.nTemps;
        }
        const end = code.length;
        for (let pc = 0; pc < end; pc += 4) {
            const op = code[pc];
            const a = code[pc + 1];
            const b = code[pc + 2];
            const c = code[pc + 3];
            switch (op) {
                case ExprOp.LOADK:
                    regs[a] = consts[b];
                    break;
                case ExprOp.LOADVAR:
                    // 语义与 evalTree 'variable' 分支一致: 槽位快速路径 → 回退原查找; 先存在性后值检查
                    regs[a] = ExpressionEvaluator.loadVar(vars[b], currentLine);
                    break;
                case ExprOp.UNPOS: {
                    const o = regs[b];
                    regs[a] = (typeof o === 'number') ? +o : this.evaluateUnaryOperation('+', o);
                    break;
                }
                case ExprOp.NEG: {
                    const o = regs[b];
                    regs[a] = (typeof o === 'number') ? -o : this.evaluateUnaryOperation('-', o);
                    break;
                }
                case ExprOp.NOT:
                    regs[a] = this.evaluateUnaryOperation('!', regs[b]);
                    break;
                case ExprOp.ADD: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? l + r : this.evaluateOperation('+', l, r);
                    break;
                }
                case ExprOp.SUB: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? l - r : this.evaluateOperation('-', l, r);
                    break;
                }
                case ExprOp.MUL: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? l * r : this.evaluateOperation('*', l, r);
                    break;
                }
                case ExprOp.DIV: {
                    const l = regs[b], r = regs[c];
                    if (typeof l === 'number' && typeof r === 'number') {
                        if (r === 0) throw { type: ExceptionType.RANGE_ERROR, message: t('division_by_zero'), lineNumber: currentLine } as Exception;
                        regs[a] = l / r;
                    } else {
                        regs[a] = this.evaluateOperation('/', l, r);
                    }
                    break;
                }
                case ExprOp.MOD: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? l % r : this.evaluateOperation('%', l, r);
                    break;
                }
                case ExprOp.POW: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? Math.pow(l, r) : this.evaluateOperation('**', l, r);
                    break;
                }
                case ExprOp.EQ: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? Boolean(l == r) : this.evaluateOperation('==', l, r);
                    break;
                }
                case ExprOp.NEQ: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? Boolean(l != r) : this.evaluateOperation('!=', l, r);
                    break;
                }
                case ExprOp.LT: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? Boolean(l < r) : this.evaluateOperation('<', l, r);
                    break;
                }
                case ExprOp.GT: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? Boolean(l > r) : this.evaluateOperation('>', l, r);
                    break;
                }
                case ExprOp.LE: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? Boolean(l <= r) : this.evaluateOperation('<=', l, r);
                    break;
                }
                case ExprOp.GE: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? Boolean(l >= r) : this.evaluateOperation('>=', l, r);
                    break;
                }
                case ExprOp.AND:
                    // 非短路: 两操作数已无条件求值 (本求值器无跳转指令, 不可能短路)
                    regs[a] = this.evaluateOperation('&&', regs[b], regs[c]);
                    break;
                case ExprOp.OR:
                    // 非短路: 同上
                    regs[a] = this.evaluateOperation('||', regs[b], regs[c]);
                    break;
            }
        }
        // 赋值表达式: 返回结构与 evalTree 'assignment' 分支一致, executeOperation 原样消费
        if (ec.resultKind === 'assignment') {
            return { type: 'assignment', target: ec.target as string, value: regs[0], binding: ec.targetBinding };
        }
        return regs[0];
    }

    // 含数组访问的表达式执行循环: 与主循环语义完全一致, 额外支持 GETARRAY。
    // 独立循环避免 GETARRAY 复杂分支拖累主分发循环优化; 此循环仅被 hasArray 的表达式调用 (调用次数少)。
    private static runExprCodeArr(ec: ExprCode, currentLine: number): any {
        const code = ec.code;
        const consts = ec.consts;
        const vars = ec.vars;
        const regs = ExpressionEvaluator.scratchRegs;
        if (regs.length < ec.nTemps) {
            regs.length = ec.nTemps;
        }
        const end = code.length;
        for (let pc = 0; pc < end; pc += 4) {
            const op = code[pc];
            const a = code[pc + 1];
            const b = code[pc + 2];
            const c = code[pc + 3];
            switch (op) {
                case ExprOp.LOADK:
                    regs[a] = consts[b];
                    break;
                case ExprOp.LOADVAR:
                    // 语义与 evalTree 'variable' 分支一致: 槽位快速路径 → 回退原查找; 先存在性后值检查
                    regs[a] = ExpressionEvaluator.loadVar(vars[b], currentLine);
                    break;
                case ExprOp.GETARRAY: {
                    // 数组元素读取: 语义与 evalTree 'arrayAccess' 分支一致。热路径: 数组查找 + 单条件取值全部内联;
                    // 条件不满足时回退独立错误方法 (冷路径, 复刻逐项检查与精确错误消息)。
                    // 数组查找: 槽位快速路径 → 槽位为空时完整回退 getVariable (查局部作用域+全局, 与 evalTree 一致);
                    // 无槽位的全局访问直查 GLOBAL_VARS (语义等价于 getVariable(isGlobal=true), lookupName 已去前缀, 免 debugLog 开销)。
                    const idx = regs[c];
                    const cv = vars[b];
                    let arr: Variable | null;
                    if (cv.binding) {
                        arr = ExpressionEvaluator.readSlot(cv.binding);
                        if (arr === null) {
                            arr = ScopeManager.getVariable(cv.lookupName, currentLine, true, cv.isGlobal);
                        }
                    } else if (cv.isGlobal) {
                        arr = (GLOBAL_VARS[cv.lookupName] !== undefined) ? GLOBAL_VARS[cv.lookupName] : null;
                    } else {
                        arr = ScopeManager.getVariable(cv.lookupName, currentLine, true, false);
                    }
                    const els = arr !== null && arr.type === DataType.ARRAY ? arr.arrayElements : null;
                    if (typeof idx === 'number' && Number.isInteger(idx) && idx >= 0 &&
                        els !== null && els !== undefined && idx < els.length &&
                        idx < (arr!.arrayLength || 0)) {
                        regs[a] = els[idx].value;
                        break;
                    }
                    throw ExpressionEvaluator.getArrayAccessError(arr, idx, cv, currentLine, ec.nTokens);
                }
                case ExprOp.UNPOS: {
                    const o = regs[b];
                    regs[a] = (typeof o === 'number') ? +o : this.evaluateUnaryOperation('+', o);
                    break;
                }
                case ExprOp.NEG: {
                    const o = regs[b];
                    regs[a] = (typeof o === 'number') ? -o : this.evaluateUnaryOperation('-', o);
                    break;
                }
                case ExprOp.NOT:
                    regs[a] = this.evaluateUnaryOperation('!', regs[b]);
                    break;
                case ExprOp.ADD: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? l + r : this.evaluateOperation('+', l, r);
                    break;
                }
                case ExprOp.SUB: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? l - r : this.evaluateOperation('-', l, r);
                    break;
                }
                case ExprOp.MUL: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? l * r : this.evaluateOperation('*', l, r);
                    break;
                }
                case ExprOp.DIV: {
                    const l = regs[b], r = regs[c];
                    if (typeof l === 'number' && typeof r === 'number') {
                        if (r === 0) throw { type: ExceptionType.RANGE_ERROR, message: t('division_by_zero'), lineNumber: currentLine } as Exception;
                        regs[a] = l / r;
                    } else {
                        regs[a] = this.evaluateOperation('/', l, r);
                    }
                    break;
                }
                case ExprOp.MOD: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? l % r : this.evaluateOperation('%', l, r);
                    break;
                }
                case ExprOp.POW: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? Math.pow(l, r) : this.evaluateOperation('**', l, r);
                    break;
                }
                case ExprOp.EQ: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? Boolean(l == r) : this.evaluateOperation('==', l, r);
                    break;
                }
                case ExprOp.NEQ: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? Boolean(l != r) : this.evaluateOperation('!=', l, r);
                    break;
                }
                case ExprOp.LT: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? Boolean(l < r) : this.evaluateOperation('<', l, r);
                    break;
                }
                case ExprOp.GT: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? Boolean(l > r) : this.evaluateOperation('>', l, r);
                    break;
                }
                case ExprOp.LE: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? Boolean(l <= r) : this.evaluateOperation('<=', l, r);
                    break;
                }
                case ExprOp.GE: {
                    const l = regs[b], r = regs[c];
                    regs[a] = (typeof l === 'number' && typeof r === 'number') ? Boolean(l >= r) : this.evaluateOperation('>=', l, r);
                    break;
                }
                case ExprOp.AND:
                    // 非短路: 两操作数已无条件求值 (本求值器无跳转指令, 不可能短路)
                    regs[a] = this.evaluateOperation('&&', regs[b], regs[c]);
                    break;
                case ExprOp.OR:
                    // 非短路: 同上
                    regs[a] = this.evaluateOperation('||', regs[b], regs[c]);
                    break;
            }
        }
        // 赋值表达式: 返回结构与 evalTree 'assignment' 分支一致, executeOperation 原样消费
        if (ec.resultKind === 'assignment') {
            return { type: 'assignment', target: ec.target as string, value: regs[0], binding: ec.targetBinding };
        }
        return regs[0];
    }

    // 词法分析: 将表达式分解为令牌
    private static tokenize(expression: string): string[] {
        const tokens: string[] = [];
        let i = 0;

        while (i < expression.length) {
            const char = expression[i];
            const code = char.charCodeAt(0);

            // 跳过空白字符 (与正则 \s 语义一致: 含全部 Unicode 空白码点)
            if (code === 9 || code === 10 || code === 11 || code === 12 || code === 13 ||
                code === 32 || code === 160 || code === 5760 ||
                (code >= 8192 && code <= 8202) ||
                code === 8232 || code === 8233 || code === 8239 || code === 8287 ||
                code === 12288 || code === 65279) {
            } else if (code >= 48 && code <= 57) {
                // 解析数字 (支持 0x/0b/0o 进制字面量)
                let numStr = char;
                i++;
                if (numStr === '0' && i < expression.length) {
                    const p = expression[i].charCodeAt(0);
                    if (p === 120 || p === 88 || p === 98 || p === 66 || p === 111 || p === 79) { // x X b B o O
                        numStr += expression[i];
                        i++;
                    }
                }
                const prefix = numStr.length > 1 ? numStr[1].toLowerCase() : '';
                const isHex = prefix === 'x';
                const isBin = prefix === 'b';
                const isOct = prefix === 'o';
                while (i < expression.length) {
                    const c = expression[i].charCodeAt(0);
                    const isDigit = c >= 48 && c <= 57;
                    const isDot = c === 46;
                    // 与原正则 validChars 严格等价: 十六进制允许 a-f/A-F, 二进制仅 0/1, 八进制仅 0-7, 十进制仅数字; 均允许小数点
                    const ok = isDot ||
                        (isHex ? (isDigit || (c >= 97 && c <= 102) || (c >= 65 && c <= 70))
                            : (isBin ? (c === 48 || c === 49)
                                : (isOct ? (c >= 48 && c <= 55) : isDigit)));
                    if (!ok) break;
                    numStr += expression[i];
                    i++;
                }
                tokens.push(numStr);
                continue;
            } else if (code === 34) { // " (字符串定界符仅双引号; 单引号不是字符串边界)
                // 解析字符串
                const quote = char;
                let str = char;
                i++;
                while (i < expression.length && expression[i] !== quote) {
                    str += expression[i];
                    i++;
                }
                if (i < expression.length) {
                    str += quote;
                    i++;
                }
                tokens.push(str);
                continue;
            } else if ((code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95) { // A-Z a-z _
                // 解析标识符或关键字
                let identifier = char;
                i++;
                // 允许点号: 支持 Math.sin / global.var 等点分标识符作为单个token
                while (i < expression.length) {
                    const c = expression[i].charCodeAt(0);
                    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 46 || c === 95) {
                        identifier += expression[i];
                        i++;
                    } else {
                        break;
                    }
                }
                tokens.push(identifier);
                continue;
            } else if (code === 43 || code === 45 || code === 42 || code === 47 || code === 37 ||
                code === 61 || code === 60 || code === 62 || code === 33 || code === 38 || code === 124) {
                // 解析运算符 + - * / % = < > ! & |
                let op = char;
                i++;
                // 检查是否是双字符运算符
                if (i < expression.length) {
                    const nextChar = expression[i];
                    if ((char === '=' && nextChar === '=') ||
                        (char === '!' && nextChar === '=') ||
                        (char === '<' && nextChar === '=') ||
                        (char === '>' && nextChar === '=') ||
                        (char === '&' && nextChar === '&') ||
                        (char === '|' && nextChar === '|') ||
                        (char === '*' && nextChar === '*')) {
                        op += nextChar;
                        i++;
                    }
                }
                tokens.push(op);
                continue;
            } else if (code === 40 || code === 41 || code === 91 || code === 93 ||
                code === 123 || code === 125 || code === 44 || code === 58) {
                // 解析分隔符 ( ) [ ] { } , :
                tokens.push(char);
            } else {
                throw { type: ExceptionType.SYNTAX_ERROR, message: t('unexpected_char', {char: char, pos: i}), lineNumber: this.currentLine } as Exception;
            }
            i++;
        }
        return tokens;
    }

    // 解析表达式 (处理赋值运算符) 
    private static buildExpressionTree(): ExprNode {
        debugLog(2, () => t('dbg_parse_expr', { tokens: this.tokens }));
        // 检查是否是数组元素赋值
        if (this.currentTokenIndex + 2 < this.tokens.length &&
            /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(this.tokens[this.currentTokenIndex]) &&
            this.tokens[this.currentTokenIndex + 1] === '[') {
            // 保存当前索引以备恢复
            const savedIndex = this.currentTokenIndex;
            this.currentTokenIndex += 2; // 跳过数组名和 '['

            // 解析索引表达式 (建树)
            this.buildExpressionTree(); // 索引表达式

            // 检查是否有 ']'
            if (this.currentTokenIndex < this.tokens.length && this.tokens[this.currentTokenIndex] === ']') {
                this.currentTokenIndex++; // 跳过 ']'

                // 检查是否有 '='
                if (this.currentTokenIndex < this.tokens.length && this.tokens[this.currentTokenIndex] === '=') {
                    // 这是一个数组元素赋值表达式
                    this.currentTokenIndex = savedIndex; // 恢复索引
                    const target = this.buildArrayAssignmentTarget();
                    this.currentTokenIndex++; // 跳过 '='
                    const value = this.buildExpressionTree();
                    const node: ExprNode = { kind: 'arrayAssignment', target: target, valueExpr: value };
                    // 局部数组目标绑定槽位 (global. 前缀跳过, 走原查找路径)
                    if (!target.arrayName.startsWith('global.')) {
                        node.arrayTargetBinding = lookupSlotBinding(target.arrayName, this.currentLine) ?? undefined;
                    }
                    return node;
                }
            }

            // 不是数组赋值, 恢复索引并继续正常解析
            debugLog(2, () => t('dbg_parse_not_array_assign', { tokens: this.tokens }));
            this.currentTokenIndex = savedIndex;
        }

        // 检查是否是简单变量赋值
        if (this.currentTokenIndex + 1 < this.tokens.length &&
            /^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(this.tokens[this.currentTokenIndex]) &&
            this.tokens[this.currentTokenIndex + 1] === '=') {
            // 这是一个简单变量赋值表达式
            const target = this.buildAssignmentTarget();
            this.currentTokenIndex++; // 跳过 '='
            const value = this.buildExpressionTree();
            const node: ExprNode = { kind: 'assignment', target: target, valueExpr: value };
            // 局部变量目标绑定槽位 (global. 前缀跳过, 走原查找路径)
            if (typeof target === 'string' && !target.startsWith('global.')) {
                node.targetBinding = lookupSlotBinding(target, this.currentLine) ?? undefined;
            }
            return node;
        }

        let left = this.buildLogicalOr();

        if (this.currentTokenIndex < this.tokens.length) {
            const op = this.tokens[this.currentTokenIndex];
            if (op === '=') {
                this.currentTokenIndex++;
                this.buildExpressionTree();
                // 注意: 赋值运算符的处理需要在调用上下文中进行, 这里仅做解析
                throw {
                    type: ExceptionType.SYNTAX_ERROR,
                    message: t('assignment_op_in_call_context', {pos: this.currentTokenIndex}),
                    lineNumber: this.currentLine
                } as Exception;

            }
        }

        return left;
    }

    // 构建逻辑或运算节点 (||) 
    private static buildLogicalOr(): ExprNode {
        debugLog(2, () => t('dbg_parse_logic_or', { tokens: this.tokens }));
        let left = this.buildLogicalAnd();

        while (this.currentTokenIndex < this.tokens.length && this.tokens[this.currentTokenIndex] === '||') {
            this.currentTokenIndex++;
            const right = this.buildLogicalAnd();
            left = { kind: 'binary', op: '||', left: left, right: right };
        }

        return left;
    }

    // 构建逻辑与运算节点 (&&) 
    private static buildLogicalAnd(): ExprNode {
        debugLog(2, () => t('dbg_parse_logic_and', { tokens: this.tokens }));
        let left = this.buildEquality();

        while (this.currentTokenIndex < this.tokens.length && this.tokens[this.currentTokenIndex] === '&&') {
            this.currentTokenIndex++;
            const right = this.buildEquality();
            left = { kind: 'binary', op: '&&', left: left, right: right };
        }

        return left;
    }

    // 构建相等性运算节点 (==, !=) 
    private static buildEquality(): ExprNode {
        debugLog(2, () => t('dbg_parse_equality', { tokens: this.tokens }));
        let left = this.buildRelational();

        while (this.currentTokenIndex < this.tokens.length &&
            (this.tokens[this.currentTokenIndex] === '==' || this.tokens[this.currentTokenIndex] === '!=')) {
            const op = this.tokens[this.currentTokenIndex];
            this.currentTokenIndex++;
            const right = this.buildRelational();
            left = { kind: 'binary', op: op, left: left, right: right };
        }

        return left;
    }

    // 构建关系运算节点 (<, >, <=, >=) 
    private static buildRelational(): ExprNode {
        debugLog(2, () => t('dbg_parse_relational', { tokens: this.tokens }));
        let left = this.buildAdditive();

        while (this.currentTokenIndex < this.tokens.length &&
            (this.tokens[this.currentTokenIndex] === '<' || this.tokens[this.currentTokenIndex] === '>' ||
                this.tokens[this.currentTokenIndex] === '<=' || this.tokens[this.currentTokenIndex] === '>=')) {
            const op = this.tokens[this.currentTokenIndex];
            this.currentTokenIndex++;
            const right = this.buildAdditive();
            left = { kind: 'binary', op: op, left: left, right: right };
        }

        return left;
    }

    // 构建加法和减法运算节点
    private static buildAdditive(): ExprNode {
        debugLog(2, () => t('dbg_parse_additive', { tokens: this.tokens }));
        let left = this.buildMultiplicative();

        while (this.currentTokenIndex < this.tokens.length &&
            (this.tokens[this.currentTokenIndex] === '+' || this.tokens[this.currentTokenIndex] === '-')) {
            const op = this.tokens[this.currentTokenIndex];
            this.currentTokenIndex++;
            const right = this.buildMultiplicative();
            left = { kind: 'binary', op: op, left: left, right: right };
        }

        return left;
    }

    // 构建乘法、除法和取模运算节点
    private static buildMultiplicative(): ExprNode {
        debugLog(2, () => t('dbg_parse_multiplicative', { tokens: this.tokens }));
        let left = this.buildPower();

        while (this.currentTokenIndex < this.tokens.length &&
            (this.tokens[this.currentTokenIndex] === '*' || this.tokens[this.currentTokenIndex] === '/' ||
                this.tokens[this.currentTokenIndex] === '%' || this.tokens[this.currentTokenIndex] === '**')) {
            const op = this.tokens[this.currentTokenIndex];
            this.currentTokenIndex++;
            const right = this.buildPower();
            left = { kind: 'binary', op: op, left: left, right: right };
        }

        return left;
    }

    // 构建幂运算节点
    private static buildPower(): ExprNode {
        debugLog(2, () => t('dbg_parse_power', { tokens: this.tokens }));
        let left = this.buildUnary();

        while (this.currentTokenIndex < this.tokens.length && this.tokens[this.currentTokenIndex] === '**') {
            const op = this.tokens[this.currentTokenIndex];
            this.currentTokenIndex++;
            const right = this.buildPower(); // 右结合
            left = { kind: 'binary', op: op, left: left, right: right };
        }

        return left;
    }

    // 构建一元运算符节点
    private static buildUnary(): ExprNode {
        debugLog(2, () => t('dbg_parse_unary', { tokens: this.tokens }));
        if (this.currentTokenIndex < this.tokens.length &&
            (this.tokens[this.currentTokenIndex] === '-' || this.tokens[this.currentTokenIndex] === '+' ||
                this.tokens[this.currentTokenIndex] === '!')) {
            const op = this.tokens[this.currentTokenIndex];
            this.currentTokenIndex++;
            const operand = this.buildUnary();
            return { kind: 'unary', op: op, operand: operand };
        }

        return this.buildPrimary();
    }

    // 构建基本元素节点 (数字、字符串、变量、括号表达式) 
    private static buildPrimary(): ExprNode {
        debugLog(2, () => t('dbg_parse_primary', { tokens: this.tokens }));
        if (this.currentTokenIndex >= this.tokens.length) {
            throw { type: ExceptionType.SYNTAX_ERROR, message: t('expr_unexpected_end', {pos: this.currentTokenIndex}), lineNumber: this.currentLine } as Exception;
        }

        const token = this.tokens[this.currentTokenIndex];

        // 检查是否是数字
        if (/^\d+(\.\d+)?$/.test(token)) {
            this.currentTokenIndex++;
            return { kind: 'literal', value: parseFloat(token) };
        }

        // 检查是否是进制字面量 (0x/0b/0o)
        const radixMatch = /^0[xX][\da-fA-F]+$|^0[bB][01]+$|^0[oO][0-7]+$/.exec(token);
        if (radixMatch) {
            this.currentTokenIndex++;
            const radix = token[1].toLowerCase() === 'x' ? 16 : token[1].toLowerCase() === 'b' ? 2 : 8;
            return { kind: 'literal', value: parseInt(token.slice(2), radix) };
        }

        // 检查是否是字符串 (仅双引号; 单引号不是字符串边界)
        if (token.startsWith('"') && token.endsWith('"')) {
            this.currentTokenIndex++;
            return { kind: 'literal', value: token.substring(1, token.length - 1) };
        }

        // 检查是否是关键字
        if (token === 'true') {
            this.currentTokenIndex++;
            return { kind: 'literal', value: true };
        }
        if (token === 'false') {
            this.currentTokenIndex++;
            return { kind: 'literal', value: false };
        }
        if (token === 'null') {
            // 规范: 条件/表达式中出现 null 或 undefined 立即抛出错误 (建树期即抛, 与原有解析期行为一致)
            throw {
                type: ExceptionType.TYPE_ERROR,
                message: t('expr_null_not_allowed'),
                lineNumber: this.currentLine
            } as Exception;
        }
        if (token === 'undefined') {
            // 规范: 条件/表达式中出现 null 或 undefined 立即抛出错误
            throw {
                type: ExceptionType.TYPE_ERROR,
                message: t('expr_undefined_not_allowed'),
                lineNumber: this.currentLine
            } as Exception;
        }

        // 检查是否是变量或函数调用
        // 检查 token 是否为有效的标识符。正则表达式规则如下: 
        // ^ : 匹配字符串的开始位置
        // [a-zA-Z_] : 第一个字符必须是字母或下划线
        // [a-zA-Z0-9_.]* : 后续字符可以是字母、数字、下划线或点号, * 表示该组合可出现 0 次或多次
        // $ : 匹配字符串的结束位置
        if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(token)) {
            debugLog(2, () => t('dbg_check_token', { token }))
            this.currentTokenIndex++;
            // 全局变量标志
            let isGlobal: boolean = false;
            // 检查是否是函数调用
            if (this.currentTokenIndex < this.tokens.length && this.tokens[this.currentTokenIndex] === '(') {
                debugLog(2, () => t('dbg_detect_func_call', { token }));
                return this.buildFunctionCall(token);
            }

            if (token.startsWith('global.')) {
                debugLog(2, () => t('dbg_detect_global_prefix'));
                isGlobal = true;
            }

            // 检查是否是数组元素访问
            if (this.currentTokenIndex < this.tokens.length && this.tokens[this.currentTokenIndex] === '[') {
                debugLog(2, () => t('dbg_detect_array_access', { token }));
                return this.buildArrayAccess(token, isGlobal);
            }

            // 变量节点: 类型/存在性/值检查推迟到求值期实时查作用域 (缓存树不含运行时值)
            // 局部变量额外携带静态槽位绑定 (热路径 O(1) 访问; 全局/未注册引用留空走原查找路径)
            if (!isGlobal) {
                const node: ExprNode = { kind: 'variable', name: token, isGlobal: isGlobal };
                node.slotBinding = lookupSlotBinding(token, this.currentLine) ?? undefined;
                return node;
            }
            return { kind: 'variable', name: token, isGlobal: isGlobal };
        }

        // 检查是否是括号表达式
        if (token === '(') {
            this.currentTokenIndex++;
            const expr = this.buildExpressionTree();

            if (this.currentTokenIndex >= this.tokens.length || this.tokens[this.currentTokenIndex] !== ')') {
                throw {
                    type: ExceptionType.SYNTAX_ERROR,
                    message: t('missing_right_paren', {pos: this.currentTokenIndex}),
                    lineNumber: this.currentLine
                } as Exception;
            }

            this.currentTokenIndex++;
            return expr;
        }

        throw {
            type: ExceptionType.SYNTAX_ERROR,
            message: t('unexpected_token_primary', {token: token, pos: this.currentTokenIndex}),
            lineNumber: this.currentLine
        } as Exception;
    }

    // 构建数组元素访问节点 (索引类型/范围检查推迟到求值期实时进行)
    private static buildArrayAccess(arrayName: string, isGlobal: boolean = false): ExprNode {
        // 跳过左方括号
        this.currentTokenIndex++;

        // 解析索引表达式 (建树)
        const index = this.buildExpressionTree();

        // 跳过右方括号
        if (this.currentTokenIndex >= this.tokens.length || this.tokens[this.currentTokenIndex] !== ']') {
            throw { type: ExceptionType.SYNTAX_ERROR, message: t('array_missing_right_bracket', {name: arrayName, pos: this.currentTokenIndex}), lineNumber: this.currentLine } as Exception;
        }
        this.currentTokenIndex++;

        const node: ExprNode = { kind: 'arrayAccess', name: arrayName, isGlobal: isGlobal, index: index };
        // 局部数组绑定槽位 (global. 前缀跳过, 走原查找路径)
        if (!isGlobal) {
            node.slotBinding = lookupSlotBinding(arrayName, this.currentLine) ?? undefined;
        }
        return node;
    }

    // 构建数组赋值目标节点 (索引类型/范围检查推迟到求值期实时进行)
    private static buildArrayAssignmentTarget(): { arrayName: string, index: ExprNode } {
        const arrayName = this.tokens[this.currentTokenIndex];
        this.currentTokenIndex += 2; // 跳过数组名和 '['

        // 解析索引表达式 (建树)
        const index = this.buildExpressionTree();

        // 跳过右方括号
        if (this.currentTokenIndex >= this.tokens.length || this.tokens[this.currentTokenIndex] !== ']') {
            throw { type: ExceptionType.SYNTAX_ERROR, message: t('array_missing_right_bracket', {name: arrayName, pos: this.currentTokenIndex}), lineNumber: this.currentLine } as Exception;
        }
        this.currentTokenIndex++;

        return { arrayName: arrayName, index: index };
    }

    // 构建赋值目标
    private static buildAssignmentTarget(): string {
        // 检查是否是有效的标识符 (允许点号, 以支持 global.var 前缀赋值)
        if (this.currentTokenIndex >= this.tokens.length ||
            !/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(this.tokens[this.currentTokenIndex])) {
            throw {
                type: ExceptionType.SYNTAX_ERROR,
                message: t('invalid_assignment_target', {pos: this.currentTokenIndex}),
                lineNumber: this.currentLine
            } as Exception;
        }

        const varName = this.tokens[this.currentTokenIndex];
        this.currentTokenIndex++;

        return varName;
    }

    // 构建函数调用节点 (参数求值推迟到 evalTree, 与原有从左到右按序求值一致)
    private static buildFunctionCall(funcName: string): ExprNode {
        debugLog(2, () => t('dbg_parse_func_call', { funcName }));
        // 跳过左括号
        this.currentTokenIndex++;

        const args: ExprNode[] = [];

        // 解析参数 (建树)
        while (this.currentTokenIndex < this.tokens.length && this.tokens[this.currentTokenIndex] !== ')') {
            debugLog(2, () => t('dbg_parse_args'));
            args.push(this.buildExpressionTree());

            // 检查是否有逗号
            if (this.currentTokenIndex < this.tokens.length && this.tokens[this.currentTokenIndex] === ',') {
                this.currentTokenIndex++;
            }
        }

        // 跳过右括号
        if (this.currentTokenIndex >= this.tokens.length || this.tokens[this.currentTokenIndex] !== ')') {
            throw {
                type: ExceptionType.SYNTAX_ERROR,
                message: t('func_call_missing_right_paren', {name: funcName, pos: this.currentTokenIndex}),
                lineNumber: this.currentLine
            } as Exception;
        }
        this.currentTokenIndex++;

        return { kind: 'call', funcName: funcName, args: args };
    }

    // 执行函数调用
    private static executeFunction(funcName: string, args: any[]): any {
        // 支持一些内置函数
        switch (funcName) {
            case 'Math.sin':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'Math.sin'}), lineNumber: this.currentLine } as Exception;
                return Math.sin(args[0]);
            case 'Math.cos':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'Math.cos'}), lineNumber: this.currentLine } as Exception;
                return Math.cos(args[0]);
            case 'Math.tan':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'Math.tan'}), lineNumber: this.currentLine } as Exception;
                return Math.tan(args[0]);
            case 'Math.sqrt':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'Math.sqrt'}), lineNumber: this.currentLine } as Exception;
                return Math.sqrt(args[0]);
            case 'Math.abs':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'Math.abs'}), lineNumber: this.currentLine } as Exception;
                return Math.abs(args[0]);
            case 'Math.pow':
                if (args.length !== 2) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_2_args', {func: 'Math.pow'}), lineNumber: this.currentLine } as Exception;
                return Math.pow(args[0], args[1]);
            case 'Math.floor':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'Math.floor'}), lineNumber: this.currentLine } as Exception;
                return Math.floor(args[0]);
            case 'Math.ceil':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'Math.ceil'}), lineNumber: this.currentLine } as Exception;
                return Math.ceil(args[0]);
            case 'Math.round':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'Math.round'}), lineNumber: this.currentLine } as Exception;
                return Math.round(args[0]);
            case 'Math.max':
                return Math.max(...args);
            case 'Math.min':
                return Math.min(...args);
            case 'Math.random':
                if (args.length !== 0) throw { type: ExceptionType.TYPE_ERROR, message: t('func_no_arg_expected', {func: 'Math.random'}), lineNumber: this.currentLine } as Exception;
                return Math.random();
            // ============ String.* 字符串操作 (直接映射宿主 JS String, 与 Math.* 同源) ============
            case 'String.length':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'String.length'}), lineNumber: this.currentLine } as Exception;
                return String(args[0]).length;
            case 'String.substring':
                if (args.length !== 3) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_3_args', {func: 'String.substring'}), lineNumber: this.currentLine } as Exception;
                // JS substring 语义: [start, end), 负索引按 0, end<start 自动交换
                return String(args[0]).substring(args[1], args[2]);
            case 'String.indexOf':
                if (args.length !== 2) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_2_args', {func: 'String.indexOf'}), lineNumber: this.currentLine } as Exception;
                return String(args[0]).indexOf(String(args[1]));
            case 'String.includes':
                if (args.length !== 2) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_2_args', {func: 'String.includes'}), lineNumber: this.currentLine } as Exception;
                return String(args[0]).includes(String(args[1]));
            case 'String.replace':
                if (args.length !== 3) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_3_args', {func: 'String.replace'}), lineNumber: this.currentLine } as Exception;
                // JS replace 语义: 字符串参数仅替换第一处
                return String(args[0]).replace(String(args[1]), String(args[2]));
            case 'String.toUpper':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'String.toUpper'}), lineNumber: this.currentLine } as Exception;
                return String(args[0]).toUpperCase();
            case 'String.toLower':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'String.toLower'}), lineNumber: this.currentLine } as Exception;
                return String(args[0]).toLowerCase();
            case 'String.trim':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'String.trim'}), lineNumber: this.currentLine } as Exception;
                return String(args[0]).trim();
            // ============ Bit.* 位运算 (直接映射 JS 位运算符, 32 位有符号语义) ============
            case 'Bit.and':
                if (args.length !== 2) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_2_args', {func: 'Bit.and'}), lineNumber: this.currentLine } as Exception;
                return args[0] & args[1];
            case 'Bit.or':
                if (args.length !== 2) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_2_args', {func: 'Bit.or'}), lineNumber: this.currentLine } as Exception;
                return args[0] | args[1];
            case 'Bit.xor':
                if (args.length !== 2) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_2_args', {func: 'Bit.xor'}), lineNumber: this.currentLine } as Exception;
                return args[0] ^ args[1];
            case 'Bit.not':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'Bit.not'}), lineNumber: this.currentLine } as Exception;
                return ~args[0];
            case 'Bit.shl':
                if (args.length !== 2) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_2_args', {func: 'Bit.shl'}), lineNumber: this.currentLine } as Exception;
                return args[0] << args[1];
            case 'Bit.shr':
                if (args.length !== 2) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_2_args', {func: 'Bit.shr'}), lineNumber: this.currentLine } as Exception;
                return args[0] >> args[1];
            case 'len':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'len'}), lineNumber: this.currentLine } as Exception;
                debugLog(2, () => t('dbg_len_arg', { arg: args[0] }));
                if (typeof args[0] === 'string') {
                    debugLog(2, () => t('dbg_arg_string_type'));
                    return args[0].length;
                }
                // 检查是否是数组变量
                // 注意: 这里需要特殊处理, 因为数组变量在传递时可能已经被解构
                // 我们需要检查参数是否是数组变量对象
                debugLog(2, () => t('dbg_arg_array_type', { arg: args[0] }));
                if (args[0] && typeof args[0] === 'object' && 'type' in args[0] && args[0].type === DataType.ARRAY) {
                    return args[0].arrayLength || 0;
                }
                // 如果是数组变量引用, 尝试从作用域中获取
                if (typeof args[0] === 'string') {

                    const arrayVar = ScopeManager.getVariable(args[0], this.currentLine, true);
                    if (arrayVar && arrayVar.type === DataType.ARRAY) {
                        return arrayVar.arrayLength || 0;
                    }
                }
                throw { type: ExceptionType.TYPE_ERROR, message: t('len_only_str_or_array'), lineNumber: this.currentLine } as Exception;
            case 'str':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'str'}), lineNumber: this.currentLine } as Exception;
                return String(args[0]);
            case 'int':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'int'}), lineNumber: this.currentLine } as Exception;
                return parseInt(args[0]);
            case 'float':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'float'}), lineNumber: this.currentLine } as Exception;
                return parseFloat(args[0]);
            case 'input':
                // 运行时输入: 无参数, 返回用户输入的一行字符串 (不含换行符)
                if (args.length !== 0) throw { type: ExceptionType.TYPE_ERROR, message: t('func_no_arg_expected', {func: 'input'}), lineNumber: this.currentLine } as Exception;
                // 交互挂起模式 (NSI.runInteractive): 有预取值直接取, 否则挂起等待宿主提供 (按键等事件)
                if (INPUT_INTERACTIVE_MODE) {
                    if (INPUT_PRELOAD.length > 0) {
                        return INPUT_PRELOAD.shift() as string;
                    }
                    INPUT_SUSPENDED = true;
                    if (typeof INPUT_ON_REQUEST === 'function') {
                        try { INPUT_ON_REQUEST(); } catch (e) { /* 宿主回调异常不影响解释器 */ }
                    }
                    throw INPUT_SUSPEND_SIGNAL;
                }
                // 自定义输入处理器优先 (浏览器可用 NSI.setInput() 绑定, 如页面中的输入框)
                if (typeof INPUT_HANDLER === 'function') {
                    const custom = INPUT_HANDLER();
                    return custom === null || custom === undefined ? '' : String(custom);
                }
                // Node 环境: 同步逐字节读取 stdin (fs.readSync 是同步的, 不破坏解释器的同步执行模型)
                if (typeof process !== 'undefined' && typeof fs !== 'undefined' && typeof fs.readSync === 'function') {
                    const inBuf = Buffer.alloc(1);
                    const bytes: number[] = [];
                    while (true) {
                        const bytesRead = fs.readSync(0, inBuf, 0, 1, null);
                        if (bytesRead === 0) break; // EOF: 无更多输入
                        const b = inBuf[0];
                        if (b === 0x0A) break;          // \n: 行结束
                        if (b === 0x0D) continue;       // 忽略 \r (Windows CRLF), 仅以 \n 结束
                        bytes.push(b);
                    }
                    // 一次性按 UTF-8 解码, 避免逐字节解码导致多字节字符 (如中文) 损坏
                    return Buffer.from(bytes).toString('utf8');
                }
                // 浏览器环境: 同步弹窗输入 (prompt 为阻塞式)
                if (typeof window !== 'undefined' && typeof window.prompt === 'function') {
                    return window.prompt('') || '';
                }
                throw { type: ExceptionType.TYPE_ERROR, message: t('input_unavailable'), lineNumber: this.currentLine } as Exception;
            case 'copy':
                // 数组副本: 深拷贝数组数据并返回独立副本 (可用于整体赋值 b = copy(a))
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'copy'}), lineNumber: this.currentLine } as Exception;
                let copySrcArr: Variable | null = null;
                if (args[0] && typeof args[0] === 'object' && 'type' in args[0] && args[0].type === DataType.ARRAY) {
                    copySrcArr = args[0] as Variable;
                } else if (typeof args[0] === 'string') {
                    copySrcArr = ScopeManager.getVariable(args[0], this.currentLine, true);
                }
                if (!copySrcArr || copySrcArr.type !== DataType.ARRAY) {
                    throw { type: ExceptionType.TYPE_ERROR, message: t('copy_arg_must_be_array'), lineNumber: this.currentLine } as Exception;
                }
                const copiedArr: Variable = {
                    name: copySrcArr.name + "_copy",
                    value: "请使用arrayElements属性访问数组元素",
                    type: DataType.ARRAY,
                    isGlobal: false,
                    isConst: false,
                    startLine: this.currentLine,
                    endLine: -1,
                    frameId: copySrcArr.frameId,
                    arrayLength: copySrcArr.arrayLength,
                    arrayElementType: copySrcArr.arrayElementType,
                    arrayElements: copySrcArr.arrayElements!.map(e => ({ value: e.value, type: e.type })),
                    isReadonlyArray: false
                };
                debugLog(1, () => t('dbg_copy_array', { name: copySrcArr.name, length: copiedArr.arrayLength }));
                return copiedArr;
            default:
                throw {
                    type: ExceptionType.REFERENCE_ERROR,
                    message: t('unknown_function', {name: funcName, pos: this.currentTokenIndex}),
                    lineNumber: this.currentLine
                } as Exception;
        }
    }

    // 词法缓存: token 数组纯由字符序列决定, 与运行时值无关, 同一表达式字符串缓存后跳过逐字符切词。
    // 解析器只通过游标读取 token 数组内容、从不修改, 多个表达式共享缓存数组无副作用。
    private static tokenCache: Map<string, string[]> = new Map();
    private static readonly MAX_TOKEN_CACHE = 1000;

    // 表达式树缓存 (两级: programId → 表达式 → 树): 树为纯结构 (不含运行时值), 首次执行时解析建树, 之后每次执行直接遍历求值。
    // 变量/数组/函数调用等节点在求值时实时查作用域, 故缓存树跨执行共享是安全的 (与 token 缓存同批安全原则)。
    // 两级 Map 免每次求值的 key 字符串拼接; 程序指纹 PROGRAM_ID 隔离 (树节点携带静态槽位绑定, 跨程序不可共享)。
    private static treeCacheByProgram: Map<number, Map<string, ExprNode>> = new Map();
    private static readonly MAX_TREE_CACHE = 1000;

    // ===== 求值 (运行期): 遍历表达式树求值, 变量/数组/函数调用实时查作用域 =====
    // 帧查找缓存: 同一函数帧内连续变量/数组访问免重复遍历控制流栈。
    // 命中条件 = 缓存帧键一致 且 当前栈深一致 (函数帧入栈后相对位置由深度唯一确定, 同深度帧必同);
    // 递归进入/退出会改变栈深, 自动失效, 不会误命中外层帧。
    private static slotFrameKey: string = '';
    private static slotFrameId: number = -1;
    private static slotFrameDepth: number = -1;
    // 槽位读取: 顶层帧固定 'top' 键; 函数帧从控制流栈查找匹配的调用帧 (递归时栈顶即最内层, 语义与"后入先匹配"一致)
    static readSlot(binding: { frameKey: string, slot: number }): Variable | null {
        // 帧缓存命中: 栈深一致时栈顶函数帧必为同一帧 (热路径最常见, 放在最前省掉 'top' 字符串比较)
        if (binding.frameKey === ExpressionEvaluator.slotFrameKey && CONTROL_FLOW_STACK.length === ExpressionEvaluator.slotFrameDepth) {
            const m = SLOT_INDEX[ExpressionEvaluator.slotFrameId];
            return m ? (m[binding.slot] ?? null) : null;
        }
        if (binding.frameKey === 'top') {
            const m = SLOT_INDEX.top;
            return m ? (m[binding.slot] ?? null) : null;
        }
        for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
            const b = CONTROL_FLOW_STACK[i];
            if (b.type === 'function' && ('f:' + b.funcName + ':' + b.startLine) === binding.frameKey) {
                // 更新帧缓存供后续同帧访问复用
                ExpressionEvaluator.slotFrameKey = binding.frameKey;
                ExpressionEvaluator.slotFrameId = b.frameId;
                ExpressionEvaluator.slotFrameDepth = CONTROL_FLOW_STACK.length;
                const m = SLOT_INDEX[b.frameId];
                return m ? (m[binding.slot] ?? null) : null;
            }
        }
        if (binding.frameKey.startsWith('f:')) {
            ExpressionEvaluator.slotFrameKey = '';
            ExpressionEvaluator.slotFrameDepth = -1;
        }
        return null;
    }

    // 语义与原有"边解析边求值"严格一致: 求值顺序 (左→右→运算, 参数按序, 数组索引先于右值),
    // 类型检查/报错 (引用/类型/越界/除零等) 完全复刻, 唯一差异是解析不再重复执行。
    private static evalTree(node: ExprNode): any {
        switch (node.kind) {
            case 'literal':
                return node.value;
            case 'variable': {
                const name = node.name as string;
                const isGlobal = !!node.isGlobal;
                // 槽位快速路径: 局部变量 O(1) 读取 (未注册绑定/全局变量走下方原查找路径)
                const binding = node.slotBinding;
                if (binding) {
                    const varInfo = ExpressionEvaluator.readSlot(binding);
                    if (varInfo !== null) {
                        if (varInfo.type === DataType.ARRAY) return varInfo; // 数组整体返回数组对象
                        if (varInfo.value === undefined) {
                            throw {
                                type: ExceptionType.TYPE_ERROR,
                                message: t('var_value_undefined', { name: name }),
                                lineNumber: this.currentLine
                            } as Exception;
                        }
                        return varInfo.value;
                    }
                    // 槽位为空 (变量被 purge/帧清理移除 或 槽位索引未覆盖): 回退原查找路径 (可能命中全局变量)
                }
                // 全局槽位快速路径: GLOBAL_VARS 对象属性 O(1) 读取, 免 getVariableInfo 函数调用与内部分支;
                // 调试输出顺序与 getVariableInfo(入口 lookup → 命中 global_info / 未命中 warn) + 原返回处理逐字节一致
                if (isGlobal) {
                    if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_lookup_var_info', { scope: t('dbg_scope_global'), name, line: this.currentLine + 1 }));
                    const gName = name.startsWith('global.') ? name.slice('global.'.length) : name;
                    const gv = GLOBAL_VARS[gName];
                    if (gv === undefined) {
                        if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_warn_var_undefined', { name, line: this.currentLine + 1 }));
                        throw {
                            type: ExceptionType.REFERENCE_ERROR,
                            message: t('var_undefined_expr_global', { name: name }),
                            lineNumber: this.currentLine
                        } as Exception;
                    }
                    if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_get_var_info_global', { name, value: gv.value, type: gv.type, scopeStart: gv.startLine + 1, scopeEnd: gv.endLine === -1 ? t('dbg_last_line') : gv.endLine + 1, line: this.currentLine + 1 }));
                    if (gv.type === DataType.ARRAY) {
                        DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_return_array', { scope: t('dbg_scope_global'), name: gv.name, line: this.currentLine + 1 }));
                        return gv;
                    }
                    if (gv.value === undefined) {
                        throw {
                            type: ExceptionType.TYPE_ERROR,
                            message: t('var_value_undefined', { name: name }),
                            lineNumber: this.currentLine
                        } as Exception;
                    }
                    DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_return_var_value', { scope: t('dbg_scope_global'), name, value: gv.value, line: this.currentLine + 1 }));
                    return gv.value;
                }
                // 无绑定路径: 一次 getVariableInfo 完成类型/存在性/值检查 (原 getVariableType+getVariableInfo 两趟扫描合并)
                const varInfo = ScopeManager.getVariableInfo(name, this.currentLine, isGlobal);
                if (varInfo === null) {
                    throw {
                        type: ExceptionType.REFERENCE_ERROR,
                        message: isGlobal ? t('var_undefined_expr_global', { name: name }) : t('var_undefined_expr_local', { name: name }),
                        lineNumber: this.currentLine
                    } as Exception;
                }
                if (varInfo.type === DataType.ARRAY) {
                DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_return_array', { scope: isGlobal ? t('dbg_scope_global') : '', name: varInfo.name, line: this.currentLine + 1 }));
                    return varInfo;
                }
                if (varInfo.value === undefined) {
                    throw {
                        type: ExceptionType.TYPE_ERROR,
                        message: t('var_value_undefined', { name: name }),
                        lineNumber: this.currentLine
                    } as Exception;
                }
                DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_return_var_value', { scope: isGlobal ? t('dbg_scope_global') : '', name, value: varInfo.value, line: this.currentLine + 1 }));
                return varInfo.value;
            }
            case 'binary': {
                const left = this.evalTree(node.left as ExprNode);
                const right = this.evalTree(node.right as ExprNode);
                const op = node.op as string;
                // 数字快速路径: 两操作数均为原生 number (数值变量/字面量/数值运算结果) 时直接原生运算,
                // 跳过 evaluateOperation 的 typeof/Set/对象类型检查 (语义等价: 原路径对 number 操作数
                // 仅 '/' 有除零检查需保留, 其余直接计算; &&/|| 需布尔操作数故不进入快速路径)
                if (typeof left === 'number' && typeof right === 'number') {
                    switch (op) {
                        case '+': return left + right;
                        case '-': return left - right;
                        case '*': return left * right;
                        case '/':
                            if (right === 0) throw { type: ExceptionType.RANGE_ERROR, message: t('division_by_zero'), lineNumber: this.currentLine } as Exception;
                            return left / right;
                        case '%': return left % right;
                        case '**': return Math.pow(left, right);
                        case '==': return Boolean(left == right);
                        case '!=': return Boolean(left != right);
                        case '<': return Boolean(left < right);
                        case '>': return Boolean(left > right);
                        case '<=': return Boolean(left <= right);
                        case '>=': return Boolean(left >= right);
                        default: break; // && || 等非数值运算符落入原路径
                    }
                }
                return this.evaluateOperation(op, left, right);
            }
            case 'unary': {
                const operand = this.evalTree(node.operand as ExprNode);
                const op = node.op as string;
                // 数字快速路径: 原生 number 的一元 +/- 直接计算 (原路径对 number 行为一致)
                if (typeof operand === 'number' && (op === '+' || op === '-')) {
                    return op === '-' ? -operand : operand;
                }
                return this.evaluateUnaryOperation(op, operand);
            }
            case 'call': {
                // 参数从左到右按序求值, 与原有边解析边求值的参数求值顺序一致
                const args = (node.args as ExprNode[]).map(a => this.evalTree(a));
                debugLog(2, () => t('dbg_exec_func_call', { funcName: node.funcName, args }))
                return this.executeFunction(node.funcName as string, args);
            }
            case 'arrayAccess': {
                const index = this.evalTree(node.index as ExprNode);
                // 复刻 parseArrayAccess 的索引检查与取元素逻辑 (检查从解析期移至求值期, 语义一致)
                if (typeof index !== 'number') {
                    throw {
                        type: ExceptionType.TYPE_ERROR,
                        message: t('array_index_not_number', {pos: this.currentTokenIndex}),
                        lineNumber: this.currentLine
                    } as Exception;
                }
                if (!Number.isInteger(index) || index < 0) {
                    throw {
                        type: ExceptionType.RANGE_ERROR,
                        message: t('array_index_not_nonneg_int', {pos: this.currentTokenIndex}),
                        lineNumber: this.currentLine
                    } as Exception;
                }
                let newArrayName: string = node.name as string;
                if (node.isGlobal && newArrayName.startsWith('global.')) {
                    newArrayName = newArrayName.slice('global.'.length);
                }
                // 槽位快速路径: 局部数组 O(1) 读取; 槽位为空 (被 purge 等移除) 或无绑定 (全局/未注册) 回退原查找
                let arrayVar: Variable | null;
                if (node.slotBinding) {
                    arrayVar = ExpressionEvaluator.readSlot(node.slotBinding);
                    if (arrayVar === null) {
                        arrayVar = ScopeManager.getVariable(newArrayName, this.currentLine, true, !!node.isGlobal);
                    }
                } else {
                    arrayVar = ScopeManager.getVariable(newArrayName, this.currentLine, true, !!node.isGlobal);
                }
                if (!arrayVar || arrayVar.type !== DataType.ARRAY) {
                    throw { type: ExceptionType.TYPE_ERROR, message: t('array_var_not_array', {name: newArrayName, pos: this.currentTokenIndex}), lineNumber: this.currentLine } as Exception;
                }
                if (index >= (arrayVar.arrayLength || 0)) {
                    throw { type: ExceptionType.RANGE_ERROR, message: t('array_index_out_of_range_access', {index: index, name: newArrayName, max: arrayVar.arrayLength ? arrayVar.arrayLength - 1 : -1, pos: this.currentTokenIndex}), lineNumber: this.currentLine } as Exception;
                }
                const elements = arrayVar.arrayElements;
                if (elements && index < elements.length) {
                    return elements[index].value;
                }
                throw { type: ExceptionType.UNKNOWN_ERROR, message: t('array_element_access_error', {name: newArrayName, index: index, pos: this.currentTokenIndex}), lineNumber: this.currentLine } as Exception;
            }
            case 'assignment': {
                const value = this.evalTree(node.valueExpr as ExprNode);
                // 返回结构与原有边解析边求值一致, executeOperation 原样消费 (附带目标槽位绑定供赋值快速路径用)
                return { type: 'assignment', target: node.target as string, value: value, binding: node.targetBinding };
            }
            case 'arrayAssignment': {
                const target = node.target as { arrayName: string, index: ExprNode };
                const index = this.evalTree(target.index);
                // 复刻 parseArrayAssignmentTarget 的索引检查 (先于右值求值, 与原有顺序一致)
                if (typeof index !== 'number') {
                    throw {
                        type: ExceptionType.TYPE_ERROR,
                        message: t('array_index_not_number', {pos: this.currentTokenIndex}),
                        lineNumber: this.currentLine
                    } as Exception;
                }
                if (!Number.isInteger(index) || index < 0) {
                    throw {
                        type: ExceptionType.RANGE_ERROR,
                        message: t('array_index_not_nonneg_int', {pos: this.currentTokenIndex}),
                        lineNumber: this.currentLine
                    } as Exception;
                }
                const value = this.evalTree(node.valueExpr as ExprNode);
                return {
                    type: 'array_assignment',
                    target: { arrayName: target.arrayName, index: index },
                    value: value,
                    binding: node.arrayTargetBinding
                };
            }
            default:
                throw {
                    type: ExceptionType.SYNTAX_ERROR,
                    message: t('unknown_operator', {op: node.kind, pos: this.currentTokenIndex}),
                    lineNumber: this.currentLine
                } as Exception;
        }
    }

    // 需要数字操作数的运算符集合 (evaluateOperation 热路径 O(1) 判定, 替代数组 indexOf 线性扫描)
    private static readonly NUMERIC_OPS: Set<string> = new Set(['-', '*', '/', '%', '**', '<', '>', '<=', '>=']);

    // 计算二元运算
    private static evaluateOperation(operator: string, left: any, right: any): any {
        DEBUG_LEVEL >= 1 && debugLog(1, () => t('dbg_calc_operation', { operator, left: JSON.stringify(left), leftType: typeof left, right: JSON.stringify(right), rightType: typeof right }));

        // 提取操作数的值和类型
        const leftValue = left;
        const leftType = typeof left;
        const rightValue = right;
        const rightType = typeof right;

        // 检查类型一致性
        if (ExpressionEvaluator.NUMERIC_OPS.has(operator)) {
            // 这些运算符要求左右操作数都是数字
            const isLeftNumeric = leftType === 'number' ||
                (leftType === 'object' && left && left.type &&
                    (left.type === DataType.INT || left.type === DataType.FLOAT || left.type === DataType.NUMBER));
            if (!isLeftNumeric) {
                throw { type: ExceptionType.TYPE_ERROR, message: t('op_left_operand_not_number', {op: operator}), lineNumber: this.currentLine } as Exception;
            }
            const isRightNumeric = rightType === 'number' ||
                (rightType === 'object' && right && right.type &&
                    (right.type === DataType.INT || right.type === DataType.FLOAT || right.type === DataType.NUMBER));
            if (!isRightNumeric) {
                throw { type: ExceptionType.TYPE_ERROR, message: t('op_right_operand_not_number', {op: operator}), lineNumber: this.currentLine } as Exception;
            }
        } else if (operator === '==' || operator === '!=') {
            // 这些运算符要求左右操作数类型相同
            // 获取实际的值和类型用于比较
            const leftValueType = leftType === 'object' && left && left.type ? left.type : leftType;
            const rightValueType = rightType === 'object' && right && right.type ? right.type : rightType;

            if (leftValueType !== rightValueType) {
                // 根据规范, 类型不同时返回false而不报错
                return false;
            }
        } else if (operator === '&&' || operator === '||') {
            // 逻辑运算符要求左右操作数都是布尔值
            const leftValueType = leftType === 'object' && left && left.type ? left.type : leftType;
            const rightValueType = rightType === 'object' && right && right.type ? right.type : rightType;

            if (leftValueType !== DataType.BOOL && leftType !== 'boolean') {
                throw { type: ExceptionType.TYPE_ERROR, message: t('logic_op_left_operand_not_bool', {op: operator}), lineNumber: this.currentLine } as Exception;
            }
            if (rightValueType !== DataType.BOOL && rightType !== 'boolean') {
                throw { type: ExceptionType.TYPE_ERROR, message: t('logic_op_right_operand_not_bool', {op: operator}), lineNumber: this.currentLine } as Exception;
            }
        }

        switch (operator) {
            case '+':
                // 支持字符串连接
                if (typeof leftValue === 'string' || typeof rightValue === 'string') {
                    return String(leftValue) + String(rightValue);
                }
                DEBUG_LEVEL >= 2 && debugLog(2, () => `${operator} operated`);
                return leftValue + rightValue;
            case '-':
                DEBUG_LEVEL >= 2 && debugLog(2, () => `${operator} operated`);
                return leftValue - rightValue;
            case '*':
                DEBUG_LEVEL >= 2 && debugLog(2, () => `${operator} operated`);
                return leftValue * rightValue;
            case '/':
                if (rightValue === 0) throw { type: ExceptionType.RANGE_ERROR, message: t('division_by_zero'), lineNumber: this.currentLine } as Exception;
                DEBUG_LEVEL >= 2 && debugLog(2, () => `${operator} operated`);
                return leftValue / rightValue;
            case '%':
                DEBUG_LEVEL >= 2 && debugLog(2, () => `${operator} operated`);
                return leftValue % rightValue;
            case '**':
                DEBUG_LEVEL >= 2 && debugLog(2, () => `${operator} operated`);
                return Math.pow(leftValue, rightValue);
            case '==':
                DEBUG_LEVEL >= 2 && debugLog(2, () => `${operator} operated`);
                return Boolean(leftValue == rightValue);
            case '!=':
                DEBUG_LEVEL >= 2 && debugLog(2, () => `${operator} operated`);
                return Boolean(leftValue != rightValue);
            case '<':
                DEBUG_LEVEL >= 2 && debugLog(2, () => `${operator} operated`);
                return Boolean(leftValue < rightValue);
            case '>':
                DEBUG_LEVEL >= 2 && debugLog(2, () => `${operator} operated`);
                return Boolean(leftValue > rightValue);
            case '<=':
                DEBUG_LEVEL >= 2 && debugLog(2, () => `${operator} operated`);
                return Boolean(leftValue <= rightValue);
            case '>=':
                DEBUG_LEVEL >= 2 && debugLog(2, () => `${operator} operated`);
                return Boolean(leftValue >= rightValue);
            case '&&':
                DEBUG_LEVEL >= 2 && debugLog(2, () => `${operator} operated`);
                return Boolean(leftValue && rightValue);
            case '||':
                DEBUG_LEVEL >= 2 && debugLog(2, () => `${operator} operated`);
                return Boolean(leftValue || rightValue);
            default:
                throw {
                    type: ExceptionType.SYNTAX_ERROR,
                    message: t('unknown_operator', {op: operator, pos: this.currentTokenIndex}),
                    lineNumber: this.currentLine
                } as Exception;
        }
    }

    // 计算一元运算
    private static evaluateUnaryOperation(operator: string, operand: any): any {
        switch (operator) {
            case '+':
                return +operand;
            case '-':
                return -operand;
            case '!':
                return !operand;
            default:
                throw {
                    type: ExceptionType.SYNTAX_ERROR,
                    message: t('unknown_unary_operator', {op: operator, pos: this.currentTokenIndex}),
                    lineNumber: this.currentLine
                } as Exception;
        }
    }
}

// 添加Node.js环境下的文件系统模块导入
if (typeof require !== 'undefined') {
    var fs = require('fs');
}

// 打印使用帮助 (双语, 跟随当前输出语言)
function printHelp(): void {
    if (LANG === 'en') {
        console.log(`NoethingScript Interpreter v${NSIVersion}`);
        console.log('');
        console.log('Usage: node noethingScript-Interpreter.js <filename> [options]');
        console.log('');
        console.log('Arguments:');
        console.log('  <filename>      NoethingScript script file to execute');
        console.log('  --debug N       Set debug level 0-3 (default 0)');
        console.log('  --lang en|zh    Set output language (default zh)');
        console.log('  --help          Show this help message');
        console.log('  --version       Show version number');
    } else {
        console.log(`NoethingScript 解释器 v${NSIVersion}`);
        console.log('');
        console.log('用法: node noethingScript-Interpreter.js <文件名> [选项]');
        console.log('');
        console.log('参数:');
        console.log('  <文件名>        要执行的 NoethingScript 脚本文件');
        console.log('  --debug N       设置调试级别 0-3 (默认 0)');
        console.log('  --lang en|zh    设置输出语言 (默认 zh)');
        console.log('  --help          显示本帮助');
        console.log('  --version       显示版本号');
    }
}

// 主函数, 用于处理命令行参数并执行程序
function main() {
    // 检查是否在Node.js环境中运行
    if (typeof process !== 'undefined' && process.argv) {
        // 获取命令行参数 (从 Node.js 进程的命令行参数中提取除前两个参数之外的所有参数)
        const args = process.argv.slice(2);
        // 通用可选参数解析: 支持 --debug N 与 --lang en|zh, 顺序任意, 文件名必须是第一个非可选参数
        let filename: string | undefined;
        let debugValue: string | undefined;
        let langArg: string | undefined;
        const unknownArgs: string[] = [];
        for (let i = 0; i < args.length; i++) {
            if (args[i] === '--debug') {
                debugValue = args[i + 1];
                i++;
            } else if (args[i] === '--lang') {
                langArg = args[i + 1];
                i++;
            } else if (args[i].startsWith('-') && args[i] !== '--help' && args[i] !== '--version') {
                // 未知可选参数兜底: 以 - 开头的未知参数 (含短参数如 -h) 记入列表, 不当作文件名处理
                unknownArgs.push(args[i]);
            } else if (filename === undefined) {
                filename = args[i];
            }
        }

        // 语言设置: 仅接受 en/zh, 其他值忽略 (保持默认中文)
        if (langArg === 'en') {
            LANG = 'en';
        } else if (langArg !== 'zh' && langArg !== undefined) {
            console.log(t('cli_invalid_lang'));
        }

        // 调试等级设置: 命令行显式指定时优先级最高, 覆盖脚本内 debug 指令
        if (debugValue !== undefined) {
            if (Number.isInteger(Number(debugValue)) && Number(debugValue) >= 0) {
                DEBUG_LEVEL = Number(debugValue);
                CLI_DEBUG_SET = true;
            } else {
                console.log(t('cli_no_debug_level'));
            }
        }

        // --help / --version: 独立参数, 显示后直接退出 (不读取脚本)
        if (args.includes('--help')) {
            printHelp();
            process.exit(0);
        }
        if (args.includes('--version')) {
            console.log(`NoethingScript Interpreter v${NSIVersion}`);
            process.exit(0);
        }

        // 未知可选参数兜底: 提示后退出, 避免被误当作文件名导致"无法读取文件"
        if (unknownArgs.length > 0) {
            console.error(t('cli_unknown_args', { args: unknownArgs.join(', ') }));
            process.exit(1);
        }

        // 检查是否有参数
        if (filename === undefined) {
            console.error(t('cli_usage'));
            process.exit(1);
        }

        // 输出语言切换提示 (第一行, 用与当前输出语言不同的语言书写, 便于用户发现切换方式)
        if (LANG === 'en') {
            console.error('提示: 使用 --lang zh 切换为中文输出。');
        } else {
            console.error('Tip: Run with --lang en for English messages.');
        }

        try {
            // 读取文件内容
            const code = fs.readFileSync(filename, 'utf8');

            // 加载并执行程序
            Interpreter.loadProgram(code);
            Interpreter.run();
        } catch (error) {
            // CLI 层错误 (脚本运行前): 与脚本执行错误区分, 不用 [ERROR N] [行 X] 脚本错误格式
            console.error(t('cli_cannot_read', { filename: filename, error: error instanceof Error ? error.message : String(error) }));
            process.exit(1);
        }
    } else {
        console.error(t('cli_node_required'));
    }
}

// 处理函数返回值赋值逻辑
function handleReturnValueAssignment(funcName: string, funcInfo: FunctionInfo, resultVar: string | undefined, oldLinePointer: number): void {
    // 检查函数是否有返回值且调用时有接收变量
    if (funcInfo.returnType !== DataType.UNDEFINED && resultVar !== undefined) {
        // 数组返回值专门路径: 结果变量绑定返回数组的结构 (引用共享)
        if (funcInfo.returnType === DataType.ARRAY) {
            if (RETURN_VALUES.hasOwnProperty(funcName)) {
                const funcReturnValues = RETURN_VALUES[funcName];
                // 函数定义中的返回值变量名 (函数解析时已缓存, 免重复正则解析定义行)
                const returnVarName = funcInfo.returnVarName;
                let arrStruct: Variable | undefined;
                if (returnVarName && funcReturnValues.hasOwnProperty(returnVarName)) {
                    arrStruct = funcReturnValues[returnVarName] as Variable;
                }
                delete RETURN_VALUES[funcName];
                if (!arrStruct || arrStruct.type !== DataType.ARRAY || !arrStruct.arrayElements) {
                    reportError(ExceptionType.TYPE_ERROR, t('func_no_valid_array_return', {name: funcName}), oldLinePointer + 1);
                    return;
                }
                if (!ScopeManager.hasVariable(resultVar, oldLinePointer)) {
                    const newVar: Variable = {
                        name: resultVar,
                        value: "请使用arrayElements属性访问数组元素",
                        type: DataType.ARRAY,
                        isGlobal: false,
                        isConst: false,
                        startLine: oldLinePointer,
                        endLine: -1,
                        arrayLength: arrStruct.arrayLength,
                        arrayElementType: arrStruct.arrayElementType,
                        arrayElements: arrStruct.arrayElements,
                        isReadonlyArray: arrStruct.isReadonlyArray
                    };
                    LOCAL_VARS.push(newVar);
                    indexSlotVar(newVar); // 增量登记 (仅新增变量, 避免全量重建)
                    debugLog(2, () => t('dbg_array_ret_new_var', { name: resultVar }));
                } else {
                    const existing = ScopeManager.getVariableInfo(resultVar, oldLinePointer);
                    if (existing && existing.type === DataType.ARRAY) {
                        existing.arrayLength = arrStruct.arrayLength;
                        existing.arrayElementType = arrStruct.arrayElementType;
                        existing.arrayElements = arrStruct.arrayElements;
                        existing.isReadonlyArray = arrStruct.isReadonlyArray;
                        debugLog(2, () => t('dbg_array_ret_existing_var', { name: resultVar }));
                    } else {
                        reportError(ExceptionType.TYPE_ERROR, t('result_var_not_array', {name: resultVar}));
                    }
                }
            } else {
                reportError(ExceptionType.TYPE_ERROR, t('func_no_array_return', {name: funcName}), oldLinePointer + 1);
            }
            return;
        }

        // 确保结果变量在当前作用域中已声明
        // 如果变量不存在, 则添加到局部变量作用域中
        if (!ScopeManager.hasVariable(resultVar, oldLinePointer)) {
            debugLog(2, () => t('dbg_result_var_undeclared', { name: resultVar }));
            // 用类型默认值初始化, 避免 addVariable 类型校验失败
            let initValue: any;
            switch (funcInfo.returnType) {
                case DataType.INT: initValue = 0; break;
                case DataType.FLOAT: initValue = 0.0; break;
                case DataType.NUMBER: initValue = 0.0; break;
                case DataType.STRING: initValue = ""; break;
                case DataType.BOOL: initValue = false; break;
                default: initValue = undefined;
            }
            // 变量作用域从当前行开始, 到程序结束
            const rvIdx = LOCAL_VARS.length;
            ScopeManager.addVariable(resultVar, initValue, funcInfo.returnType, oldLinePointer, -1, false);
            // 增量登记结果变量槽位 (仅新增变量, 避免全量重建)
            if (LOCAL_VARS.length > rvIdx) indexSlotVar(LOCAL_VARS[rvIdx]);
        }

        // 从返回值池中获取返回值
        if (RETURN_VALUES.hasOwnProperty(funcName)) {
            const funcReturnValues = RETURN_VALUES[funcName];

            // 函数定义中的返回值变量名 (函数解析时已缓存, 免重复正则解析定义行)
            const returnVarName = funcInfo.returnVarName;

            // 检查是否有返回值
            if (returnVarName && funcReturnValues.hasOwnProperty(returnVarName)) {
                const returnValue = funcReturnValues[returnVarName];

                debugLog(2, () => t('dbg_get_func_return', { funcName, returnVarName, returnValue }));

                // 将返回值赋值给结果变量
                ScopeManager.setVariable(resultVar, returnValue, oldLinePointer);

                // 清理返回值池中该函数的返回值
                delete RETURN_VALUES[funcName];
            } else {
                // 没有返回值, 设置为默认值
                let defaultValue: any;
                switch (funcInfo.returnType) {
                    case DataType.NUMBER:
                        defaultValue = 0.0;
                        break;
                    case DataType.INT:
                        defaultValue = 0;
                        break;
                    case DataType.FLOAT:
                        defaultValue = 0.0;
                        break;
                    case DataType.STRING:
                        defaultValue = "";
                        break;
                    case DataType.BOOL:
                        defaultValue = false;
                        break;
                    default:
                        defaultValue = null;
                }

                debugLog(2, () => t('dbg_func_no_ret_default', { name: resultVar, value: defaultValue }));
                ScopeManager.setVariable(resultVar, defaultValue, oldLinePointer);
            }
        } else {
            // 没有返回值, 设置为默认值
            let defaultValue: any;
            switch (funcInfo.returnType) {
                case DataType.NUMBER:
                    defaultValue = 0.0;
                    break;
                case DataType.INT:
                    defaultValue = 0;
                    break;
                case DataType.FLOAT:
                    defaultValue = 0.0;
                    break;
                case DataType.STRING:
                    defaultValue = "";
                    break;
                case DataType.BOOL:
                    defaultValue = false;
                    break;
                default:
                    defaultValue = null;
            }

            debugLog(2, () => t('dbg_func_no_ret_default', { name: resultVar, value: defaultValue }));
            ScopeManager.setVariable(resultVar, defaultValue, oldLinePointer);
        }
    } else if (resultVar !== undefined) {
        // 函数没有返回类型但有结果变量, 设置为void
        // 确保结果变量在当前作用域中已声明
        if (!ScopeManager.hasVariable(resultVar, oldLinePointer)) {
            debugLog(2, () => t('dbg_result_var_undeclared', { name: resultVar }));
            // 添加变量到局部作用域, 类型为UNDEFINED, 初始值为undefined
            // 变量作用域从当前行开始, 到程序结束
            const rvIdx = LOCAL_VARS.length;
            ScopeManager.addVariable(resultVar, undefined, DataType.UNDEFINED, oldLinePointer, -1, false);
            // 增量登记结果变量槽位 (仅新增变量, 避免全量重建)
            if (LOCAL_VARS.length > rvIdx) indexSlotVar(LOCAL_VARS[rvIdx]);
        }
        ScopeManager.setVariable(resultVar, undefined, oldLinePointer);
    }
}

// ===== 阶段3: 块级寄存器虚拟机 (NSVM) =====
// 控制流结构 (if/while/for/switch/try/jump/break/continue/assert) 编译期为跳转指令 (消除运行时逐行扫描),
// 普通语句 (赋值/声明/print/call/purge) 委托现有 executeCommand (语义完全一致), 表达式存常量池字符串由
// ExpressionEvaluator 运行时求值 (与行解释器共用缓存/槽位/类型检查)。函数块与全局块均编译为独立指令块,
// call/return 切换 VM 帧; 异常用编译期 handlerTable 查表跳转 (替代 findCatchLine 逐行扫描)。

// 块级操作码 (每条指令 = [op, a, b, c] 4 个 int32)
enum NSVMOp {
    HALT = 0,        // 全局块结束
    STMT = 1,        // 委托: a=源行号, 执行 executeCommand(LINE_INFO[a].stmt, content)
    JMP = 2,         // a=目标指令索引
    JZ = 3,          // a=条件表达式常量索引, b=目标 (假跳)
    JNZ = 4,         // a=条件表达式常量索引, b=目标 (真跳)
    CALL = 5,        // 已废弃 (CALLFUNC=20 取代; 保留编号防重排, 无指令再发射此操作码)
    RETV = 6,        // a=源行号 (executeReturn + VM 帧恢复)
    RET = 7,         // a=源行号 (:end, executeFunctionEndTag + VM 帧恢复)
    FORINIT = 8,     // a=init 元数据常量索引 (声明循环变量)
    FORUPD = 9,      // a=更新表达式常量索引, b=循环变量名字符串常量索引
    SWSTART = 10,    // a=条件表达式常量索引, b=类型错误跳转目标
    SWCASE = 11,     // a=case 值表达式常量索引, b=匹配目标, c=已匹配跳过目标
    SWDEF = 12,      // a=匹配目标(default 体), b=已匹配跳过目标
    SWEND = 13,      // 弹 switch 帧
    TRY = 14,        // a=handler 索引
    CATCH = 15,      // a=异常变量名字符串常量索引, c=endtry 源行号
    ENDTRY = 16,     // 清理 try/catch 帧
    ASSERTFAIL = 17, // a=消息字符串常量索引 (抛 ASSERTION_ERROR)
    FORCLEAN = 18,   // a=init 元数据常量索引 (循环自然结束时清理循环变量, 复刻 executeFor 条件不满足分支)
    ASSERTCHK = 19,  // a=assert 信息常量索引 {content,params,cond}, b=跳过目标(endasrt 后);
                     // 复刻 executeAssert: 条件真值性判断 (非布尔不报错) + 完全一致的调试输出
    CALLFUNC = 20,   // a=函数名字符串常量索引, b=modesK 实参模式表常量索引 (Int32Array, 长度即实参个数),
                     // c=调用元数据常量索引 {funcName, callParams, content, argExprs, resultVar}
                     // 实参模式: 0=值(标量/表达式), 1=arrayref, 2=arraymut, 3=arraycopy, 4=literal (数组字面量)
                     // 实参个数 argc 一律从 consts[b] 模式表长度读取, 绝不从操作数 c 字段携带 (设计稿注意点1)
    NEWARRAY = 21,   // a=数组声明元数据常量索引 (NSVMArrayDeclMeta, 编译期预解析: 名称/长度表达式/元素类型/初始化元素串)
                     // 复刻 executeArrayDeclaration 完整语义: 长度求值+非负整数检查 → 元素类型检查 → arrfill/手动初始化
                     // → 数组 Variable 创建与 GLOBAL_VARS/LOCAL_VARS 登记 (含重复/作用域检查与槽位索引重建)
    SETARRAY = 22,   // a=数组赋值元数据常量索引 (NSVMSetArrayMeta: content + 预解析整行表达式树 + nTokens)
                     // 复刻 executeOperation 数组赋值分支: 表达式求值 (evalTree arrayAssignment, 索引检查先于右值) →
                     // 数组查找 (槽位→回退) → 存在/类型/const/readonly/越界/元素类型检查 → 写元素
}

// CALLFUNC 调用元数据 (编译期预解析, 运行期直读, 免 executeCall 的字符串正则/拆分/模式判定)
interface NSVMCallMeta {
    funcName: string;      // 函数名
    callParams: string;    // 完整调用串 "funcName(args) -> result" (调试输出逐字节一致)
    content: string;       // 原始源码行 (复刻 executeCommand 的"执行指令"调试输出)
    argExprs: string[];    // 逐实参表达式字符串 (已拆分, 忽略数组字面量/字符串内逗号)
    resultVar: string | undefined; // 返回变量名 (-> result)
    bodyStartLine: number; // 函数体首条可执行行 (编译期预解析, 跳过空行/标签行; 运行期免重复扫描)
}

// NEWARRAY 数组声明元数据 (编译期预解析 executeArrayDeclaration 的静态部分: 格式正则/标识符/元素拆分,
// 运行期直读; 长度表达式求值/元素类型检查/初始化解析等动态语义仍在执行器内复刻)
interface NSVMArrayDeclMeta {
    arrayName: string;       // 数组名 (已通过 isValidIdentifier 检查)
    lengthExpr: string;      // 长度表达式串 "[...]" 内原样保留 (运行期 evaluateExpression)
    elementTypeStr: string;  // 元素类型名字符串
    initValue: string;       // 初始化值原串 (trim 后; 'arrfill' 或 '[..]')
    elementValues: string[] | null; // 预拆分的元素表达式 (null = arrfill)
    isGlobal: boolean;       // 全局数组声明
    isConst: boolean;        // const 前缀
    params: string;          // 传给 executeArrayDeclaration 的参数串 (debugLog 3 逐字节一致)
    content: string;         // 原始源码行 (复刻 executeCommand 的"执行指令"调试输出)
}

// SETARRAY 数组赋值元数据 (编译期预解析整行表达式为树; 运行期以整表达式 token 上下文直接求值,
// pos 错误消息与行解释器逐字节一致)
interface NSVMSetArrayMeta {
    content: string;    // 原始源码行 (执行操作指令 调试输出)
    tree: ExprNode;     // 整行表达式树 (kind 恒为 arrayAssignment, 编译期已判定)
    nTokens: number;    // 整行 token 数 (错误消息 pos, 复刻 evalTree 中 currentTokenIndex=tokens.length)
}

// 异常处理器 (编译期构建, 对应一个 try-catch 结构)
interface NSVMHandler {
    tryInstr: number;      // TRY 指令索引
    catchInstr: number;    // CATCH 指令索引
    endtryInstr: number;   // ENDTRY 指令索引
    endtryLine: number;    // endtry 源行号 (catch 异常变量作用域)
    errorName: string;     // catch 异常变量名
}

// 编译产物: 指令块
interface NSVMBlock {
    instrs: Int32Array;
    consts: any[];
    lines: number[];       // 每条指令的源行号
    handlers: NSVMHandler[];
    lineToInstr: number[]; // 源行号 → 指令索引 (-1 = 无指令)
}

// VM 帧 (函数调用帧栈)
interface NSVMFrame {
    block: NSVMBlock;
    pc: number;
    retAddr: number;
    caller: NSVMFrame | null;
    callFrom: number;      // 调用源行号
}

// FORINIT 元数据
interface ForInitMeta {
    varName: string;
    type: DataType;
    initExpr: string;
    updateExpr: string;
    endforLine: number;
}

// 编译期结构栈元素
interface NSVMStruct {
    type: 'if' | 'while' | 'for' | 'switch' | 'try';
    // if
    jzIdx?: number;
    condK?: number;
    hasElse?: boolean;
    endJmpIdx?: number;
    // while / for
    topInstr?: number;
    breaks?: number[];
    continues?: number[];
    // for
    initK?: number;
    updK?: number;
    updVarK?: number;
    condInstr?: number;
    // switch
    swStartIdx?: number;
    heads?: { kind: 'case' | 'default'; caseK: number; headInstr: number; bodyStart: number; line: number }[];
    lastHead?: number;
    bodyStart?: number;
    endswcLine?: number;
    // try
    handlerIdx?: number;
    catchInstrIdx?: number;
}

class NSVMCompiler {
    private static code: number[] = [];
    private static consts: any[] = [];
    private static lines: number[] = [];
    private static curLine: number = 0;

    private static constIndex(v: any): number {
        const idx = this.consts.length;
        this.consts.push(v);
        return idx;
    }

    // 发射指令, 返回指令索引 (code 中 /4 的位置)
    private static emit(op: NSVMOp, a: number, b: number, c: number): number {
        const idx = this.code.length / 4;
        this.code.push(op, a, b, c);
        this.lines.push(this.curLine);
        return idx;
    }

    // 回填指令操作数 (null = 不改)
    private static patch(idx: number, a: number | null, b: number | null, c: number | null): void {
        const base = idx * 4;
        if (a !== null) this.code[base + 1] = a;
        if (b !== null) this.code[base + 2] = b;
        if (c !== null) this.code[base + 3] = c;
    }

    private static curInstr(): number {
        return this.code.length / 4;
    }

    // 提取括号内容 (与 executeIf 的 substring 语义一致)
    private static extractParen(p: string): string | null {
        const t = p.trim();
        if (!t.startsWith('(') || !t.endsWith(')')) return null;
        return t.substring(1, t.length - 1).trim();
    }

    // 拆分调用实参 (复刻 executeCall 内 splitCallArguments 语义: 忽略数组字面量 [...] 内部与字符串内部的逗号)
    private static splitCallArgs(s: string): string[] {
        const parts: string[] = [];
        let depth = 0;
        let cur = '';
        let inString = false;
        let delimiter = '';
        for (let i = 0; i < s.length; i++) {
            const c = s[i];
            if (!inString && (c === '"' || c === "'")) { inString = true; delimiter = c; cur += c; }
            else if (inString && c === delimiter) { inString = false; cur += c; }
            else if (!inString && c === '[') { depth++; cur += c; }
            else if (!inString && c === ']') { depth--; cur += c; }
            else if (!inString && c === ',' && depth === 0) { parts.push(cur.trim()); cur = ''; }
            else cur += c;
        }
        if (cur.trim()) parts.push(cur.trim());
        return parts;
    }

    // 数组实参模式判定 (复刻 executeCall 内 parseArrayArgument 语义, 编译期前移)
    // 返回 CALLFUNC 模式码: 1=ref(数组引用), 2=mut, 3=copy(深拷贝), 4=literal(数组字面量); 无法判定 → null
    private static parseArrayArgMode(argStr: string): number | null {
        const trimmed = argStr.trim();
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) return 4; // literal
        if (/^copy\s*\(\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\)$/.test(trimmed)) return 3;
        if (/^mut\s+([a-zA-Z_][a-zA-Z0-9_.]*)$/.test(trimmed)) return 2;
        if (/^([a-zA-Z_][a-zA-Z0-9_.]*)$/.test(trimmed)) return 1; // ref
        return null;
    }

    // 数组声明预解析 (编译期): 复刻 executeGlobal/executeLocal 的 const 剥离 + 'array ' 判定, 再按
    // executeArrayDeclaration 的格式正则/标识符/初始化结构拆分静态部分; 任一不满足 → null (回退 STMT,
    // 由行解释器在运行期以完全相同的时机报错)。长度表达式求值/元素类型检查/初始化解析留待执行器动态处理。
    private static parseArrayDecl(params: string, isGlobal: boolean): NSVMArrayDeclMeta | null {
        let isConst = false;
        let remaining = params;
        const constMatch = remaining.match(/^const\s+(.+)$/);
        if (constMatch) { isConst = true; remaining = constMatch[1]; }
        if (!remaining.startsWith('array ')) return null;
        const decl = remaining.substring(6).trim(); // 传给 executeArrayDeclaration 的参数串
        const m = decl.match(/^([a-zA-Z0-9_]+)\[([^\]]+)\]:([a-zA-Z0-9_]+)\s*=\s*(.+)$/);
        if (!m) return null;
        if (!Interpreter.isValidIdentifier(m[1])) return null;
        const initValue = m[4].trim();
        let elementValues: string[] | null = null; // null = arrfill
        if (initValue === 'arrfill') {
            elementValues = null;
        } else if (initValue.startsWith('[') && initValue.endsWith(']')) {
            const elementsStr = initValue.substring(1, initValue.length - 1).trim();
            elementValues = elementsStr ? Interpreter.splitArrayElements(elementsStr) : [];
        } else {
            return null; // 非 arrfill 非 [..] 初始化 → 运行期报 array_init_format, 回退 STMT
        }
        return {
            arrayName: m[1],
            lengthExpr: m[2],
            elementTypeStr: m[3],
            initValue,
            elementValues,
            isGlobal,
            isConst,
            params: decl,
            content: LINE_INFO[this.curLine].content
        };
    }

    // 编译整个程序: 全局块 + 每个函数块; 任一编译失败返回 false (整体回退行解释器)
    static compileProgram(): boolean {
        try {
            // 函数区间 (start..end 含定义行与 :end)
            const funcRanges: { start: number; end: number; name: string }[] = [];
            for (const name in FUNCTIONS) {
                const f = FUNCTIONS[name];
                funcRanges.push({ start: f.startLine, end: f.endLine, name });
            }
            const inFunc = new Array<boolean>(programLines.length).fill(false);
            for (const r of funcRanges) {
                for (let i = r.start; i <= r.end && i < programLines.length; i++) inFunc[i] = true;
            }

            // 全局块
            const globalBlock = this.compileBlock(0, programLines.length - 1, inFunc, null);
            if (!globalBlock) return false;
            NSVMExecutor.globalBlock = globalBlock;

            // 函数块
            const funcBlocks = new Map<string, NSVMBlock>();
            for (const r of funcRanges) {
                const fb = this.compileBlock(r.start + 1, r.end, inFunc, r.name);
                if (!fb) return false;
                funcBlocks.set(r.name, fb);
            }
            NSVMExecutor.funcBlocks = funcBlocks;
            return true;
        } catch (e) {
            debugLog(1, () => t('dbg_nsvm_compile_failed', { error: (e as Error).stack || e }));
            return false;
        }
    }

    // 编译一个块 (startLine..endLine 含); funcName=null 表示全局块
    private static compileBlock(startLine: number, endLine: number, inFunc: boolean[], funcName: string | null): NSVMBlock | null {
        this.code = [];
        this.consts = [];
        this.lines = [];
        // 跨块防污染: 每块独立回填集合 (前一块残留的回填项不得影响本块)
        this.jumpFixes = [];
        this.assertFixes = [];
        this.breakByLine = new Map();
        const handlers: NSVMHandler[] = [];
        const stack: NSVMStruct[] = [];
        let inMultiComment = false;
        let skipLine = -1; // 断言消息行已被 ASSERTFAIL 消费, 编译循环中跳过

        for (let line = startLine; line <= endLine; line++) {
            this.curLine = line;
            const info = LINE_INFO[line];
            const content = info.content;

            // 断言消息行已被 ASSERTFAIL 消费: 跳过, 不产生指令
            if (line === skipLine) continue;

            // 多行注释切换与区间跳过
            if (content === '///') { inMultiComment = !inMultiComment; continue; }
            if (inMultiComment) continue;
            if (info.isEmpty || info.isComment) continue;
            // debug 首行 (run 主循环会跳过): 不产生指令
            if (line === 0 && content.startsWith('debug ')) continue;

            // 标签行: 映射到下一指令索引
            if (content !== ':end' && /^:([a-zA-Z_]\w*)$/.test(content)) {
                // 标签已全局登记 TAGS, 跳转目标通过 lineToInstr 解析 (块内)
                continue;
            }
            // 函数定义行 / :end
            if (content.indexOf(':') === 0) {
                if (content === ':end') {
                    if (funcName !== null) {
                        // 函数块尾 → 无值返回
                        this.emit(NSVMOp.RET, line, 0, 0);
                    }
                    // 全局块中的孤立 :end 不产生指令
                    continue;
                }
                // :func(...) 定义行: 全局块跳过 (函数区间行已在 inFunc); 函数块内嵌套定义不合法 (扫描期报错)
                continue;
            }

            // 全局块跳过函数区间内的行
            if (funcName === null && inFunc[line]) continue;

            const stmt = info.stmt;
            switch (stmt.type) {
                case StmtType.OP: {
                    // SETARRAY 指令化: 编译期预解析整行表达式树, 仅 arrayAssignment 结构指令化
                    // (数组元素赋值 arr[i] = expr); 其余 (普通赋值/纯表达式) 回退 STMT 由行解释器处理。
                    // 预过滤: 仅首 token 为标识符且紧随 '[' 的行可能为数组赋值 (复刻 buildExpressionTree 探测),
                    // 其余行免编译期解析 (避免无谓开销)
                    if (/^[a-zA-Z_][a-zA-Z0-9_.]*\s*\[/.test(content)) {
                        const parsed = ExpressionEvaluator.parseExpressionTree(content, line);
                        if (parsed !== null && parsed.tree.kind === 'arrayAssignment') {
                            const metaK = this.constIndex({ content, tree: parsed.tree, nTokens: parsed.nTokens } as NSVMSetArrayMeta);
                            this.emit(NSVMOp.SETARRAY, metaK, 0, 0);
                            break;
                        }
                    }
                    this.emit(NSVMOp.STMT, line, 0, 0);
                    break;
                }
                case StmtType.GLOBAL:
                case StmtType.LOCAL: {
                    // NEWARRAY 指令化: 仅数组声明 (global/local array ...[..]:type = ...) 且静态部分可完整
                    // 预解析时发射 NEWARRAY; 其余声明 (普通变量/格式不符) 回退 STMT 由行解释器运行期报错
                    const declMeta = this.parseArrayDecl(stmt.params, stmt.type === StmtType.GLOBAL);
                    if (declMeta !== null) {
                        const metaK = this.constIndex(declMeta);
                        this.emit(NSVMOp.NEWARRAY, metaK, 0, 0);
                    } else {
                        this.emit(NSVMOp.STMT, line, 0, 0);
                    }
                    break;
                }
                case StmtType.PRINT:
                case StmtType.PURGE:
                case StmtType.CONST_PREFIX_ERROR:
                    this.emit(NSVMOp.STMT, line, 0, 0);
                    break;
                case StmtType.CALL: {
                    // CALLFUNC 指令化: 函数名/实参拆分/模式判定/个数与返回值规则校验全部前移到编译期,
                    // 任一不满足 → 返回 null 整体回退行解释器 (运行期报错/警告行为逐字节保持)
                    const p = stmt.params;
                    let funcName: string, argsStr: string, resultVar: string | undefined;
                    if (p.indexOf('->') !== -1) {
                        const m = p.match(/^([a-zA-Z0-9_]+)\((.*)\)\s*->\s*([a-zA-Z0-9_]+)$/);
                        if (!m) return null; // call_format → 回退
                        funcName = m[1]; argsStr = m[2]; resultVar = m[3];
                    } else {
                        const m = p.match(/^([a-zA-Z0-9_]+)\((.*)\)$/);
                        if (!m) return null; // call_format → 回退
                        funcName = m[1]; argsStr = m[2]; resultVar = undefined;
                    }
                    const funcInfo = FUNCTIONS[funcName];
                    if (!funcInfo) return null; // func_undefined (运行期抛错, 可被 try-catch 捕获) → 回退
                    if (resultVar === undefined && funcInfo.returnType !== DataType.UNDEFINED) return null; // func_result_var_missing → 回退
                    if (resultVar !== undefined && funcInfo.returnType === DataType.UNDEFINED) return null; // func_result_var_unexpected → 回退
                    // 实参拆分 + 个数校验 (不足报错 func_arg_count_insufficient / 多余警告 func_extra_args_ignored, 均为运行期行为 → 不匹配即回退)
                    const argValues = this.splitCallArgs(argsStr);
                    if (argValues.length !== funcInfo.params.length) return null;
                    // 逐实参模式判定 (含形参 mut/只读与实参模式一致性检查; 运行期报错 func_array_arg_format / func_mut_param_requires_mut / func_readonly_param_no_mut → 回退)
                    const modes: number[] = [];
                    for (let i = 0; i < funcInfo.params.length; i++) {
                        const param = funcInfo.params[i];
                        if (param.type === DataType.ARRAY) {
                            const mode = this.parseArrayArgMode(argValues[i]);
                            if (mode === null) return null;
                            if (param.isMutable && mode !== 2 && mode !== 3) return null;
                            if (!param.isMutable && mode === 2) return null;
                            modes.push(mode);
                        } else {
                            modes.push(0);
                        }
                    }
                    const fnK = this.constIndex(funcName);
                    const modesK = this.constIndex(Int32Array.from(modes));
                    // 函数体首条可执行行编译期预解析 (跳过空行/标签行), 运行期免每次调用重复扫描 programLines
                    let bodyStartLine = funcInfo.startLine + 1;
                    while (bodyStartLine < funcInfo.endLine) {
                        const checkLine = programLines[bodyStartLine].trim();
                        if (checkLine === '' || checkLine.indexOf(':') === 0) {
                            bodyStartLine++;
                            continue;
                        }
                        break;
                    }
                    const metaK = this.constIndex({ funcName, callParams: p, content: LINE_INFO[line].content, argExprs: argValues, resultVar, bodyStartLine } as NSVMCallMeta);
                    this.emit(NSVMOp.CALLFUNC, fnK, modesK, metaK);
                    break;
                }
                case StmtType.RETURN:
                    this.emit(NSVMOp.RETV, line, 0, 0);
                    break;
                case StmtType.IF: {
                    const cond = this.extractParen(stmt.params);
                    if (cond === null) return null;
                    const condK = this.constIndex(cond);
                    const jzIdx = this.emit(NSVMOp.JZ, condK, -1, 0);
                    stack.push({ type: 'if', jzIdx, condK, hasElse: false, endJmpIdx: -1 });
                    break;
                }
                case StmtType.ELSE: {
                    const top = stack[stack.length - 1];
                    if (!top || top.type !== 'if') return null;
                    // 先发射 then 尾的 JMP, 再回填 JZ 假跳目标为 else 体首条指令 (JMP 之后),
                    // 顺序错误会导致 JZ 假跳指向 JMP 本身 (差一指令)
                    top.endJmpIdx = this.emit(NSVMOp.JMP, -1, 0, 0);
                    this.patch(top.jzIdx!, null, this.curInstr(), null); // 假 → else 开始
                    top.hasElse = true;
                    break;
                }
                case StmtType.ENDIF: {
                    const top = stack[stack.length - 1];
                    if (!top || top.type !== 'if') return null;
                    if (top.hasElse) {
                        this.patch(top.endJmpIdx as number, this.curInstr(), null, null); // then 尾 → endif 后
                    } else {
                        this.patch(top.jzIdx as number, null, this.curInstr(), null);      // 假 → endif 后
                    }
                    stack.pop();
                    break;
                }
                case StmtType.WHILE: {
                    const cond = this.extractParen(stmt.params);
                    if (cond === null) return null;
                    const condK = this.constIndex(cond);
                    const topInstr = this.curInstr();
                    const jzIdx = this.emit(NSVMOp.JZ, condK, -1, 0);
                    stack.push({ type: 'while', jzIdx, condK, topInstr, breaks: [], continues: [] });
                    break;
                }
                case StmtType.ENDWHL: {
                    const top = stack[stack.length - 1];
                    if (!top || top.type !== 'while') return null;
                    this.emit(NSVMOp.JMP, top.topInstr as number, 0, 0);         // body 尾回跳
                    const end = this.curInstr();
                    this.patch(top.jzIdx as number, null, end, null);            // 条件假 → 循环尾
                    for (const b of top.breaks as number[]) this.patch(b, end, null, null);
                    for (const c of top.continues as number[]) this.patch(c, top.topInstr as number, null, null);
                    stack.pop();
                    break;
                }
                case StmtType.FOR: {
                    const params = stmt.params.replace(/^\(|\)$/g, '');
                    const match = params.match(/^local\s+([a-zA-Z0-9_]+):([a-zA-Z0-9_]+)\s*=\s*(.+)\s*;\s*(.+)\s*;\s*(.+)$/);
                    if (!match) return null;
                    const varName = match[1];
                    const type = Interpreter.getDataTypeFromString(match[2]);
                    const initExpr = match[3].trim();
                    const condExpr = match[4].trim();
                    const updateExpr = match[5].trim();
                    // 同名循环变量嵌套检查 (与 executeFor 的 conflictForStart 报错一致; 编译期拒绝)
                    for (let i = stack.length - 1; i >= 0; i--) {
                        const s = stack[i];
                        if (s.type === 'for') {
                            const inner = this.consts[s.initK!] as ForInitMeta;
                            if (inner.varName === varName) return null;
                        }
                    }
                    // 找匹配 endfor 行 (结构闭合, 供循环变量作用域)
                    let endforLine = line;
                    {
                        let nested = 1;
                        for (let i = line + 1; i < programLines.length; i++) {
                            const l = programLines[i].trim();
                            if (l === '') continue;
                            if (l.split(/\s+/)[0] === 'for') nested++;
                            else if (l === 'endfor') { nested--; if (nested === 0) { endforLine = i; break; } }
                        }
                    }
                    const meta: ForInitMeta = { varName, type, initExpr, updateExpr, endforLine };
                    const initK = this.constIndex(meta);
                    this.emit(NSVMOp.FORINIT, initK, 0, 0);
                    const condInstr = this.curInstr();
                    const condK = this.constIndex(condExpr);
                    const jzIdx = this.emit(NSVMOp.JZ, condK, -1, 0);
                    const updK = this.constIndex(updateExpr);
                    const updVarK = this.constIndex(varName);
                    stack.push({ type: 'for', initK, jzIdx, condK, condInstr, updK, updVarK, breaks: [], continues: [] });
                    break;
                }
                case StmtType.ENDFOR: {
                    const top = stack[stack.length - 1];
                    if (!top || top.type !== 'for') return null;
                    const updInstr = this.curInstr();
                    this.emit(NSVMOp.FORUPD, top.updK as number, top.updVarK as number, 0); // 更新段
                    this.emit(NSVMOp.JMP, top.condInstr as number, 0, 0);                  // 回跳条件
                    // 自然结束 (条件不满足): 先清理循环变量 (复刻 executeFor 条件不满足分支的 cleanupLocalVariable);
                    // break 直接跳循环尾 (不清理, 复刻 executeBreak), 故 FORCLEAN 位于 break 目标之前
                    const forCleanIdx = this.emit(NSVMOp.FORCLEAN, top.initK as number, 0, 0);
                    const end = this.curInstr();
                    this.patch(top.jzIdx as number, null, forCleanIdx, null);             // 条件假 → FORCLEAN
                    for (const b of top.breaks as number[]) this.patch(b, end, null, null);
                    for (const c of top.continues as number[]) this.patch(c, updInstr, null, null);
                    stack.pop();
                    break;
                }
                case StmtType.BREAK: {
                    let found = false;
                    for (let i = stack.length - 1; i >= 0; i--) {
                        const s = stack[i];
                        if (s.type === 'while' || s.type === 'for' || s.type === 'switch') {
                            const jmpIdx = this.emit(NSVMOp.JMP, -1, 0, 0);
                            (s.breaks as number[]).push(jmpIdx);
                            this.breakByLine.set(line, jmpIdx); // 供 switch 文本扫描 (复刻 executeCase 扫描语义)
                            found = true;
                            break;
                        }
                    }
                    if (!found) return null; // 循环/switch 外 break → 回退行解释器 (运行时 reportError)
                    break;
                }
                case StmtType.CONTINUE: {
                    let found = false;
                    for (let i = stack.length - 1; i >= 0; i--) {
                        const s = stack[i];
                        if (s.type === 'while' || s.type === 'for') {
                            (s.continues as number[]).push(this.emit(NSVMOp.JMP, -1, 0, 0));
                            found = true;
                            break;
                        }
                    }
                    if (!found) return null;
                    break;
                }
                case StmtType.JUMP: {
                    const m = stmt.params.match(/^\(([^)]+)\)\s*:\s*([a-zA-Z_]\w*)$/);
                    if (!m) return null;
                    const condExpr = m[1].trim();
                    const tagName = m[2].trim();
                    if (!condExpr) return null;
                    // 标签目标行
                    const tagLine = TAGS[tagName];
                    if (tagLine === undefined) {
                        // 标签不存在: 现有语义运行时 reportError(tag_undefined) 后继续; 委托行解释器保持一致
                        this.emit(NSVMOp.STMT, line, 0, 0);
                        break;
                    }
                    // 跳转目标可能为"未来指令"或"标签后指令"; 由于标签行映射需在编译完成后才能确定,
                    // 先记录待回填 (labelLine → jump 指令), 编译完成后统一解析 lineToInstr。
                    this.emit(NSVMOp.JNZ, this.constIndex(condExpr), -1, 0);
                    this.jumpFixes.push({ line: line, tagLine, jmpIdx: this.curInstr() - 1 });
                    break;
                }
                case StmtType.ASSERT: {
                    const cond = this.extractParen(stmt.params);
                    if (cond === null) return null;
                    // 下一行是断言失败消息 (字符串字面量): 编译期提取并标记跳过 (复刻 executeAssert 条件为假时
                    // 取下一行作消息); 非引号消息行不做编译期拒绝 — 交执行器按 executeAssert 语义
                    // (assert_message_quoted 报错 + 继续执行消息行)
                    const msgRaw = LINE_INFO[line + 1] ? LINE_INFO[line + 1].content : '';
                    const msg = (msgRaw.startsWith('"') && msgRaw.endsWith('"')) ? msgRaw.substring(1, msgRaw.length - 1) : null;
                    if (msg !== null) skipLine = line + 1;
                    const infoK = this.constIndex({
                        content: LINE_INFO[line].content, // 原始行 (复刻 executeCommand 的"执行指令"调试输出)
                        params: stmt.params,               // 原始参数 (复刻 executeAssert 的"执行assert语句"调试输出)
                        cond,                              // 条件表达式 (复刻"断言条件为真"调试输出与求值)
                        msg                                // 失败消息 (null = 消息行缺失/未加引号)
                    });
                    // 条件为真 → 跳过断言体 (到 endasrt); 为假 → 抛 ASSERTION_ERROR。
                    // 复刻 executeAssert: 真值性判断 (非布尔不报错) + 调试输出逐字节一致
                    this.emit(NSVMOp.ASSERTCHK, infoK, -1, 0);
                    this.assertFixes.push(this.curInstr() - 1); // 真跳目标 = endasrt 后指令
                    break;
                }
                case StmtType.ENDASRT:
                    // 无指令; 断言体 (消息行) 为独立字符串行 (OP 或注释), 由 JNZ 跳过
                    break;
                case StmtType.SWITCH: {
                    const cond = stmt.params.replace(/^\(|\)$/g, '');
                    if (cond === '') return null;
                    const condK = this.constIndex(cond);
                    const swStartIdx = this.emit(NSVMOp.SWSTART, condK, -1, 0); // b=类型错误目标(占位)
                    // 找匹配 endswc 行 (文本扫描边界, 复刻 executeCase 的 switch 嵌套追踪)
                    let endswcLine = line;
                    {
                        let nested = 1;
                        for (let i = line + 1; i < programLines.length; i++) {
                            const l = programLines[i].trim();
                            if (l === '') continue;
                            if (l.toLowerCase().startsWith('switch ')) nested++;
                            else if (l === 'endswc') { nested--; if (nested === 0) { endswcLine = i; break; } }
                        }
                    }
                    stack.push({ type: 'switch', swStartIdx, heads: [], lastHead: -1, bodyStart: -1, endswcLine, breaks: [] });
                    break;
                }
                case StmtType.CASE: {
                    const top = stack[stack.length - 1];
                    if (!top || top.type !== 'switch') return null;
                    // 封存上一个 case 的 match 目标 (b = 其 body 开始)
                    if (top.lastHead! !== -1) {
                        const op = this.code[top.lastHead! * 4];
                        if (op === NSVMOp.SWCASE) this.patch(top.lastHead!, null, top.bodyStart as number, null);
                    }
                    // case 常量: 包装 {e: 表达式串, s: skip 目标} (s 由 ENDSWC 文本扫描回填)
                    const caseK = this.constIndex({ e: stmt.params, s: -1 });
                    const headIdx = this.emit(NSVMOp.SWCASE, caseK, -1, -1); // b=match目标, c=noMatch目标 (ENDSWC 回填)
                    top.bodyStart = this.curInstr();
                    (top.heads as any[]).push({ kind: 'case', caseK, headInstr: headIdx, bodyStart: top.bodyStart, line });
                    top.lastHead = headIdx;
                    break;
                }
                case StmtType.DEFAULT: {
                    const top = stack[stack.length - 1];
                    if (!top || top.type !== 'switch') return null;
                    if (top.lastHead! !== -1) {
                        const op = this.code[top.lastHead! * 4];
                        if (op === NSVMOp.SWCASE) this.patch(top.lastHead!, null, top.bodyStart as number, null);
                    }
                    const headIdx = this.emit(NSVMOp.SWDEF, -1, -1, 0); // a=body目标, b=skip目标 (ENDSWC 回填)
                    top.bodyStart = this.curInstr();
                    (top.heads as any[]).push({ kind: 'default', caseK: -1, headInstr: headIdx, bodyStart: top.bodyStart, line });
                    top.lastHead = headIdx;
                    break;
                }
                case StmtType.ENDSWC: {
                    const top = stack[stack.length - 1];
                    if (!top || top.type !== 'switch') return null;
                    // 封存最后一个 body
                    if (top.lastHead! !== -1) {
                        const op = this.code[top.lastHead! * 4];
                        if (op === NSVMOp.SWCASE) this.patch(top.lastHead!, null, top.bodyStart as number, null);
                        else if (op === NSVMOp.SWDEF) this.patch(top.lastHead!, top.bodyStart as number, null, null);
                    }
                    const end = this.curInstr(); // SWEND 指令索引
                    // 回填 SWSTART 类型错误目标 (SWEND 之后, 与行解释器 executeSwitch 类型错误时跳到 endswc 下一行一致;
                    // 不能指向 SWEND 本身, 否则未压 switch 帧却执行 SWEND pop 会误弹外层 switch 帧)
                    this.patch(top.swStartIdx as number, null, end + 1, null);
                    // 逐 head 文本扫描 (复刻 executeCase/executeDefault 的运行时扫描语义, 编译期预计算目标):
                    // - noMatch 目标 (case 值不匹配): 跳到首个 {case,default,break}(本层) 之后
                    //   → 下一 head 体 / break 之后的指令 / (无目标) 自身 body
                    // - skip 目标 (已匹配或已入 default): 跳到首个 {break,endswc}(本层) 之后
                    //   → break 的 JMP 目标 (循环 break 为其循环尾, switch 自身 break 为 SWEND) / SWEND
                    const heads = top.heads as any[];
                    for (let i = 0; i < heads.length; i++) {
                        const h = heads[i];
                        const op = this.code[h.headInstr * 4];
                        if (op === NSVMOp.SWCASE) {
                            const hit = this.scanCaseDefaultBreak(h.line, top.endswcLine!);
                            let noMatchT: number;
                            if (hit === null) {
                                noMatchT = h.bodyStart; // 无后续 case/default/break → 落入自身 body (executeCase 扫描到 endswc 归零不改行指针)
                            } else if (hit.kind === 'case' || hit.kind === 'default') {
                                const j = heads.findIndex((x: any) => x.line === hit.line);
                                noMatchT = j !== -1 ? heads[j].bodyStart : h.bodyStart;
                            } else {
                                noMatchT = (this.breakByLine.get(hit.line) as number) + 1; // 跳过 break → 其后指令
                            }
                            this.patch(h.headInstr, null, null, noMatchT);
                            const skipHit = this.scanBreakOrEndswc(h.line, top.endswcLine!);
                            this.consts[h.caseK].s = skipHit === null ? end : this.breakTarget(skipHit.line, end);
                        } else if (op === NSVMOp.SWDEF) {
                            const skipHit = this.scanBreakOrEndswc(h.line, top.endswcLine!);
                            const skipT = skipHit === null ? end : this.breakTarget(skipHit.line, end);
                            this.patch(h.headInstr, null, skipT, null);
                        }
                    }
                    // 回填 switch 内 break
                    for (const b of top.breaks as number[]) this.patch(b, end, null, null);
                    this.emit(NSVMOp.SWEND, 0, 0, 0);
                    stack.pop();
                    break;
                }
                case StmtType.TRY: {
                    const handlerIdx = handlers.length;
                    handlers.push({ tryInstr: -1, catchInstr: -1, endtryInstr: -1, endtryLine: -1, errorName: '' });
                    const tryInstr = this.emit(NSVMOp.TRY, handlerIdx, 0, 0);
                    handlers[handlerIdx].tryInstr = tryInstr;
                    stack.push({ type: 'try', handlerIdx, catchInstrIdx: -1 });
                    break;
                }
                case StmtType.CATCH: {
                    const top = stack[stack.length - 1];
                    if (!top || top.type !== 'try') return null;
                    const m = stmt.params.match(/^\(\s*Exception\s+([a-zA-Z0-9_]+)\s*\)$/);
                    if (!m) return null;
                    const h = handlers[top.handlerIdx as number];
                    h.errorName = m[1];
                    h.catchInstr = this.emit(NSVMOp.CATCH, this.constIndex(m[1]), 0, 0);
                    top.catchInstrIdx = h.catchInstr;
                    break;
                }
                case StmtType.ENDTRY: {
                    const top = stack[stack.length - 1];
                    if (!top || top.type !== 'try') return null;
                    const h = handlers[top.handlerIdx as number];
                    h.endtryInstr = this.emit(NSVMOp.ENDTRY, 0, 0, 0);
                    h.endtryLine = line;
                    // 回填 CATCH 指令: b = 正常流程跳过目标 (ENDTRY 之后), c = endtry 行号 (异常变量作用域)
                    if (top.catchInstrIdx !== -1) this.patch(top.catchInstrIdx!, null, h.endtryInstr + 1, line);
                    stack.pop();
                    break;
                }
                case StmtType.END_TAG:
                    // :end 已在上方处理 (funcName != null 时 emit RET)
                    break;
                default:
                    return null;
            }
        }

        // 结构未闭合 → 编译失败
        if (stack.length > 0) return null;

        // 全局块尾
        if (funcName === null) {
            this.emit(NSVMOp.HALT, endLine, 0, 0);
        }

        // 构建 lineToInstr: 源行 → 指令索引
        const lineToInstr = new Array<number>(programLines.length).fill(-1);
        for (let i = 0; i < this.lines.length; i++) {
            const ln = this.lines[i];
            if (lineToInstr[ln] === -1) lineToInstr[ln] = i;
        }

        // 解析 jump 目标 (标签行 → 该标签后的第一条指令)
        for (const f of this.jumpFixes) {
            // 标签目标必须位于当前块范围内; 全局块不得跳入函数体内标签 (跨块 jump 属边缘情形 → 编译失败整体回退行解释器)
            if (f.tagLine < startLine || f.tagLine > endLine) return null;
            if (funcName === null && inFunc[f.tagLine]) return null;
            const target = this.lineToInstrForTag(f.tagLine, lineToInstr, endLine);
            if (target === -1) return null;
            this.patch(f.jmpIdx, null, target, null);
        }
        // 解析 assert 真跳目标 (endasrt 后的第一条指令)
        for (const ai of this.assertFixes) {
            const target = this.nextInstrAfter(ai, lineToInstr);
            if (target === -1) return null;
            this.patch(ai, null, target, null);
        }

        return {
            instrs: new Int32Array(this.code),
            consts: this.consts,
            lines: this.lines,
            handlers,
            lineToInstr
        };
    }

    private static jumpFixes: { line: number; tagLine: number; jmpIdx: number }[] = [];
    private static assertFixes: number[] = [];
    // 源行号 → break 指令索引 (供 switch 文本扫描复刻 executeCase 语义)
    private static breakByLine: Map<number, number> = new Map();

    // switch 扫描: 从 startLine+1 到 endLine (endswc 行) 追踪 switch 嵌套 (复刻 executeCase),
    // 找首个本层 {case,default,break} 行; 无 (扫描到 endswc 归零) 返回 null
    private static scanCaseDefaultBreak(startLine: number, endLine: number): { kind: 'case' | 'default' | 'break'; line: number } | null {
        let nested = 1;
        for (let i = startLine + 1; i <= endLine; i++) {
            const line = programLines[i].trim();
            if (line.toLowerCase().startsWith('switch ')) nested++;
            else if (line === 'endswc') {
                nested--;
                if (nested === 0) return null;
            } else if (nested === 1) {
                if (line.toLowerCase().startsWith('case ') || line === 'case') return { kind: 'case', line: i };
                if (line === 'default') return { kind: 'default', line: i };
                if (line === 'break') return { kind: 'break', line: i };
            }
        }
        return null;
    }

    // switch 扫描: 找首个本层 {break,endswc} 行 (复刻 executeCase 已匹配跳过 / executeDefault 已匹配跳过);
    // 遇到 endswc 归零 → 返回 null (目标 = SWEND)
    private static scanBreakOrEndswc(startLine: number, endLine: number): { kind: 'break'; line: number } | null {
        let nested = 1;
        for (let i = startLine + 1; i <= endLine; i++) {
            const line = programLines[i].trim();
            if (line.toLowerCase().startsWith('switch ')) nested++;
            else if (line === 'endswc') {
                nested--;
                if (nested === 0) return null;
            } else if (nested === 1 && line === 'break') {
                return { kind: 'break', line: i };
            }
        }
        return null;
    }

    // break 行的 JMP 目标; 未回填 (switch 自身 break, ENDSWC 尚未回填) → SWEND
    private static breakTarget(line: number, swEnd: number): number {
        const jmpIdx = this.breakByLine.get(line);
        if (jmpIdx === undefined) return swEnd;
        const t = this.code[jmpIdx * 4 + 1];
        return t === -1 ? swEnd : t;
    }

    // 标签目标: 该标签行之后的第一条指令 (标签行无指令, 指向下一指令); 限定在当前块 endLine 内 (防止跨块误解析)
    private static lineToInstrForTag(tagLine: number, lineToInstr: number[], endLine: number): number {
        for (let i = tagLine; i <= endLine; i++) {
            if (lineToInstr[i] !== -1) return lineToInstr[i];
        }
        return -1;
    }

    // assert 真跳目标: 从当前指令之后查找 endasrt 行后的第一条指令
    private static nextInstrAfter(assertIdx: number, lineToInstr: number[]): number {
        // 找到 assert 指令对应的行
        const assertLine = NSVMCompiler.lines[assertIdx];
        let nested = 1;
        for (let i = assertLine + 1; i < programLines.length; i++) {
            const l = LINE_INFO[i];
            if (l.isEmpty || l.isComment || l.content === '///') continue;
            if (l.stmt.type === StmtType.ASSERT) nested++;
            else if (l.stmt.type === StmtType.ENDASRT) {
                nested--;
                if (nested === 0) {
                    // endasrt 行后的第一条指令
                    for (let j = i + 1; j < programLines.length; j++) {
                        if (lineToInstr[j] !== -1) return lineToInstr[j];
                    }
                    return NSVMCompiler.code.length / 4; // 无后续 → 块尾 (HALT)
                }
            }
        }
        return -1;
    }
}

// 执行器
class NSVMExecutor {
    static active = false;
    static globalBlock: NSVMBlock | null = null;
    static funcBlocks: Map<string, NSVMBlock> = new Map();
    static frames: NSVMFrame[] = [];
    // VM 内部 try 帧栈 (异常时从顶向下找 handler)
    static vmTryStack: { block: NSVMBlock; handlerIdx: number }[] = [];
    // switch 帧栈 (VM 内部, 复刻 executeSwitch/executeCase 的状态);
    // block/pc 记录压栈处, 供异常处理按"TRY 指令之后压入的帧"清理 (主循环 CONTROL_FLOW_STACK.length = tryIdx+1 的对应物)
    static switchStack: { block: NSVMBlock; pc: number; condition: number | string; hasMatched: boolean; inCaseBlock: false | 'case' | 'default' }[] = [];

    // 编译并激活; 编译失败返回 false (调用方回退行解释器)
    static prepare(): boolean {
        if (NSVMExecutor.active) return true;
        if (NSVMCompiler.compileProgram()) {
            NSVMExecutor.active = true;
            NSVMExecutor.frames = [];
            NSVMExecutor.vmTryStack = [];
            NSVMExecutor.switchStack = [];
            return true;
        }
        return false;
    }

    static run(): void {
        if (NSVMExecutor.frames.length === 0) {
            if (!NSVMExecutor.globalBlock) return;
            NSVMExecutor.frames = [{
                block: NSVMExecutor.globalBlock,
                pc: 0,
                retAddr: -1,
                caller: null,
                callFrom: -1
            }];
            NSVMExecutor.vmTryStack = [];
            NSVMExecutor.switchStack = [];
        }
        let frame = NSVMExecutor.frames[NSVMExecutor.frames.length - 1];

        while (true) {
            try {
                while (true) {
                    const instrs = frame.block.instrs;
                    if (frame.pc * 4 >= instrs.length) break; // 块尾
                    const base = frame.pc * 4;
                    const op = instrs[base];
                    const a = instrs[base + 1];
                    const b = instrs[base + 2];
                    const c = instrs[base + 3];
                    currentLinePointer = frame.block.lines[frame.pc];
                    const consts = frame.block.consts;

                    switch (op) {
                        case NSVMOp.HALT:
                            currentLinePointer = programLines.length; // 复刻主循环退出时行指针 ("程序执行完毕" 行号一致)
                            if (EXCEPTION_STACK.length > 0) debugLog(1, () => t('dbg_program_stopped_error'));
                            else debugLog(1, () => t('dbg_program_finished'));
                            return;
                        case NSVMOp.STMT:
                            Interpreter.executeCommand(LINE_INFO[a].stmt, LINE_INFO[a].content);
                            frame.pc++;
                            break;
                        case NSVMOp.NEWARRAY: {
                            // 数组声明指令: 预解析元数据直读, 执行器复刻 executeArrayDeclaration 完整语义
                            const declMeta = consts[a] as NSVMArrayDeclMeta;
                            DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_execute_instr', { content: declMeta.content }));
                            Interpreter.executeArrayDeclarationCompiled(declMeta);
                            frame.pc++;
                            break;
                        }
                        case NSVMOp.SETARRAY:
                            // 复杂语义已外提至独立方法 (executeArrayAssignmentCompiled), case 仅委托调用,
                            // 避免复杂分支内联拖累主分发循环的 V8 优化 (BISECT: 内联实现 2048 端到端慢 ~20%)
                            Interpreter.executeArrayAssignmentCompiled(consts[a] as NSVMSetArrayMeta, currentLinePointer);
                            frame.pc++;
                            break;
                        case NSVMOp.JMP:
                            frame.pc = a;
                            break;
                        case NSVMOp.JZ: {
                            const v = Interpreter.evaluateExpression(consts[a]);
                            if (typeof v !== 'boolean') {
                                reportError(ExceptionType.TYPE_ERROR, t('cond_must_be_bool', { actualType: typeof v }));
                                frame.pc++;
                            } else if (!v) {
                                // if 假分支调试输出 (复刻 executeIf debugLog(1))
                                if (LINE_INFO[currentLinePointer] && LINE_INFO[currentLinePointer].stmt.type === StmtType.IF) {
                                    debugLog(1, () => t('dbg_if_false_line', { line: currentLinePointer + 1 }));
                                }
                                // while 条件为假: 弹 while 帧 (复刻 executeWhile 假分支先压后弹的净效果;
                                // 每次迭代 JZ 都会执行, 存在时弹残留帧)
                                if (LINE_INFO[currentLinePointer] && LINE_INFO[currentLinePointer].stmt.type === StmtType.WHILE) {
                                    for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
                                        if (CONTROL_FLOW_STACK[i].type === 'while' && (CONTROL_FLOW_STACK[i] as { start?: number }).start === currentLinePointer) {
                                            CONTROL_FLOW_STACK.splice(i, 1);
                                            break;
                                        }
                                    }
                                }
                                frame.pc = b;
                            } else {
                                // while 条件为真: 压 while 帧 (复刻 executeWhile exists 检查; 递归/嵌套时栈顶同源帧复用)
                                if (LINE_INFO[currentLinePointer] && LINE_INFO[currentLinePointer].stmt.type === StmtType.WHILE) {
                                    let exists = false;
                                    const topBlock = CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1];
                                    if (topBlock && topBlock.type === 'while' && topBlock.start === currentLinePointer) exists = true;
                                    else exists = CONTROL_FLOW_STACK.some(item => item.type === 'while' && item.start === currentLinePointer);
                                    if (!exists) CONTROL_FLOW_STACK.push({ type: 'while', start: currentLinePointer });
                                }
                                frame.pc++;
                            }
                            break;
                        }
                        case NSVMOp.JNZ: {
                            const v = Interpreter.evaluateExpression(consts[a]);
                            if (typeof v !== 'boolean') {
                                reportError(ExceptionType.TYPE_ERROR, t('cond_must_be_bool', { actualType: typeof v }));
                                frame.pc++;
                            } else if (v) frame.pc = b;
                            else frame.pc++;
                            break;
                        }
                        case NSVMOp.CALLFUNC: {
                            // CALLFUNC 完整语义外提至 executeCallCompiled (case 仅委托): 巨大内联块拖累主分发
                            // 循环的 V8 优化 (BISECT: 内联实现 2048 端到端慢 ~3%), 委托后主循环恢复热路径优化
                            const nextFrame = NSVMExecutor.executeCallCompiled(consts, a, b, c, frame);
                            if (nextFrame !== null) frame = nextFrame;
                            break;
                        }
                        case NSVMOp.RETV:
                        case NSVMOp.RET: {
                            const curFrame = NSVMExecutor.frames.pop() as NSVMFrame;
                            // 记录当前最深的函数帧 frameId: executeReturn/executeFunctionEndTag 成功路径会弹帧,
                            // 失败路径 (报错后继续执行函数体, 如 return 非声明返回变量) 不弹帧 —
                            // 用 frameId 是否仍在栈中区分, 复刻主循环"报错后继续执行"语义
                            let funcFrameId = -1;
                            for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
                                if (CONTROL_FLOW_STACK[i].type === 'function') { funcFrameId = (CONTROL_FLOW_STACK[i] as { frameId: number }).frameId; break; }
                            }
                            // 直接调 executeReturn/executeFunctionEndTag (跳过 executeCommand switch 分发), 保留"执行指令"调试输出逐字节一致
                            if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_execute_instr', { content: LINE_INFO[a].content }));
                            if (op === NSVMOp.RETV) Interpreter.executeReturn(LINE_INFO[a].stmt.params);
                            else Interpreter.executeFunctionEndTag();
                            let frameStillThere = false;
                            if (funcFrameId !== -1) {
                                for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
                                    if (CONTROL_FLOW_STACK[i].type === 'function' && (CONTROL_FLOW_STACK[i] as { frameId: number }).frameId === funcFrameId) { frameStillThere = true; break; }
                                }
                            }
                            if (frameStillThere) {
                                // 返回失败: 恢复当前帧, 继续执行函数体 (报错后行为与行解释器一致)
                                NSVMExecutor.frames.push(curFrame);
                                frame = curFrame;
                                frame.pc++;
                            } else {
                                if (NSVMExecutor.frames.length === 0) return; // 不应发生
                                frame = NSVMExecutor.frames[NSVMExecutor.frames.length - 1];
                                frame.pc = curFrame.retAddr;
                            }
                            break;
                        }
                        case NSVMOp.FORINIT: {
                            const meta = consts[a] as ForInitMeta;
                            // 复刻 executeFor 初始化: 变量已存在 (jump 重入) 则复用, 否则声明
                            if (!ScopeManager.hasVariable(meta.varName, currentLinePointer)) {
                                const initValue = Interpreter.parseValue(meta.initExpr, meta.type);
                                ScopeManager.addVariable(meta.varName, initValue, meta.type, currentLinePointer, meta.endforLine, false);
                                rebuildSlotIndex();
                            }
                            // 压 for 帧 (复刻 executeFor): 循环变量只读检查 (checkLoopVarWritable) 与 local 声明检查
                            // (executeLocal) 均依赖 CONTROL_FLOW_STACK 中的 for 帧; jump 重入不经过本指令, 帧已残留不重复压
                            CONTROL_FLOW_STACK.push({ type: 'for', start: currentLinePointer, updateExpr: meta.updateExpr, varName: meta.varName });
                            frame.pc++;
                            break;
                        }
                        case NSVMOp.FORUPD: {
                            // 更新循环变量 (设置只读豁免标志)
                            FOR_UPDATE_VAR = consts[b];
                            try {
                                Interpreter.executeOperation(consts[a]);
                            } finally {
                                FOR_UPDATE_VAR = null;
                            }
                            frame.pc++;
                            break;
                        }
                        case NSVMOp.FORCLEAN: {
                            // 循环自然结束 (条件不满足): 清理循环变量, 复刻 executeFor 条件不满足分支的 cleanupLocalVariable;
                            // break 跳出时跳过本指令, 循环变量残留 (与 executeBreak 语义一致)
                            const meta = consts[a] as ForInitMeta;
                            const varInfo = ScopeManager.getVariableInfo(meta.varName, currentLinePointer);
                            if (varInfo && !varInfo.isGlobal) {
                                ScopeManager.cleanupLocalVariable(false, false, varInfo.name, varInfo.startLine, varInfo.endLine, varInfo.frameId);
                                rebuildSlotIndex();
                            }
                            // 弹出对应 for 帧 (复刻 executeFor !result 分支 CONTROL_FLOW_STACK.pop())
                            for (let i = CONTROL_FLOW_STACK.length - 1; i >= 0; i--) {
                                const b = CONTROL_FLOW_STACK[i];
                                if (b.type === 'for' && b.varName === meta.varName) { CONTROL_FLOW_STACK.splice(i, 1); break; }
                            }
                            frame.pc++;
                            break;
                        }
                        case NSVMOp.SWSTART: {
                            // 复刻 executeSwitch 调试输出 (debugLog 1)
                            debugLog(1, () => t('dbg_exec_switch', { params: consts[a] }));
                            const cond = Interpreter.evaluateExpression(consts[a]);
                            debugLog(1, () => t('dbg_switch_cond_value', { value: cond }));
                            // 复刻 executeSwitch 类型检查: number 必须整数; 非 number/string 报错
                            let typeError = false;
                            if (typeof cond === 'number') {
                                if (!Number.isInteger(cond)) { reportError(ExceptionType.TYPE_ERROR, t('switch_cond_int_only')); typeError = true; }
                            } else if (typeof cond !== 'string') {
                                reportError(ExceptionType.TYPE_ERROR, t('switch_cond_type'));
                                typeError = true;
                            }
                            if (typeError) {
                                frame.pc = b; // 跳到 switch 尾
                                break;
                            }
                            NSVMExecutor.switchStack.push({ block: frame.block, pc: frame.pc, condition: cond, hasMatched: false, inCaseBlock: false });
                            frame.pc++;
                            break;
                        }
                        case NSVMOp.SWCASE: {
                            // 复刻 executeCase 调试输出 (debugLog 1, 在检查/跳转之前)
                            debugLog(1, () => t('dbg_handle_case'));
                            const sw = NSVMExecutor.switchStack[NSVMExecutor.switchStack.length - 1];
                            if (!sw) { frame.pc++; break; }
                            const head = consts[a] as { e: string; s: number };
                            // 已匹配过 case 或已在 default 块: 跳到 skip 目标 (复刻 executeCase 已匹配分支的文本跳过)
                            if (sw.hasMatched || sw.inCaseBlock === 'default') {
                                frame.pc = head.s;
                                break;
                            }
                            const caseVal = Interpreter.evaluateExpression(head.e);
                            if (typeof caseVal !== typeof sw.condition) {
                                reportError(ExceptionType.TYPE_ERROR, t('case_type_mismatch'));
                                frame.pc++;
                                break;
                            }
                            if (caseVal === sw.condition) {
                                sw.hasMatched = true;
                                sw.inCaseBlock = 'case';
                                frame.pc = b; // 进入 case 体
                            } else {
                                frame.pc = c; // 不匹配: 跳到 noMatch 目标 (下一 head 体 / break 后指令 / 自身 body)
                            }
                            break;
                        }
                        case NSVMOp.SWDEF: {
                            const sw = NSVMExecutor.switchStack[NSVMExecutor.switchStack.length - 1];
                            if (!sw) { frame.pc++; break; }
                            if (sw.hasMatched) {
                                frame.pc = b; // 已匹配: 跳到 skip 目标 (复刻 executeDefault 已匹配分支)
                            } else {
                                sw.inCaseBlock = 'default';
                                frame.pc = a; // 进入 default 体
                            }
                            break;
                        }
                        case NSVMOp.SWEND:
                            NSVMExecutor.switchStack.pop();
                            frame.pc++;
                            break;
                        case NSVMOp.TRY: {
                            Interpreter.executeTry(); // 压 EXCEPTION_STACK TRY_BLOCK + CONTROL_FLOW_STACK try 帧
                            NSVMExecutor.vmTryStack.push({ block: frame.block, handlerIdx: a });
                            frame.pc++;
                            break;
                        }
                        case NSVMOp.CATCH: {
                            // 异常进入: 绑定异常变量, 进入 catch 块体 (复刻 executeCatch 情况一)
                            if (PENDING_EXCEPTION !== null) {
                                const exception = PENDING_EXCEPTION;
                                PENDING_EXCEPTION = null;
                                const errorName = consts[a];
                                ScopeManager.addVariable(errorName, exception.message, DataType.STRING, currentLinePointer, c, false, false);
                                rebuildSlotIndex();
                                EXCEPTION_STACK.push({ type: ExceptionType.CATCH_BLOCK, message: errorName, lineNumber: currentLinePointer });
                                debugLog(1, () => t('dbg_catch_exception', { message: exception.message, line: exception.lineNumber + 1 }));
                                frame.pc++; // 进入 catch 块体
                                break;
                            }
                            // 正常流程 (try 无异常): 复刻 executeCatch 情况二 — 清除 try 标记与 try 帧, 跳到 ENDTRY 之后跳过 catch 块体
                            if (EXCEPTION_STACK.length > 0 && EXCEPTION_STACK[EXCEPTION_STACK.length - 1].type === ExceptionType.TRY_BLOCK) {
                                EXCEPTION_STACK.pop();
                            }
                            if (CONTROL_FLOW_STACK.length > 0 && CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1].type === 'try') {
                                CONTROL_FLOW_STACK.pop();
                            }
                            NSVMExecutor.vmTryStack.pop(); // 对应 TRY 压入的条目
                            frame.pc = b; // 编译器回填: ENDTRY 之后 (跳过 catch 块体)
                            break;
                        }
                        case NSVMOp.ENDTRY:
                            Interpreter.executeEndTry(); // 清理 try 块内局部变量 + 异常栈 + try 帧
                            NSVMExecutor.vmTryStack.pop();
                            frame.pc++;
                            break;
                        case NSVMOp.ASSERTCHK: {
                            // 复刻 executeAssert: 条件真值性判断 (非布尔不报错) + 调试输出逐字节一致
                            const info = consts[a] as { content: string; params: string; cond: string; msg: string | null };
                            DEBUG_LEVEL >= 2 && debugLog(2, () => t('dbg_execute_instr', { content: info.content }));
                            debugLog(1, () => t('dbg_exec_assert', { params: info.params }));
                            let condition: any;
                            try {
                                condition = Interpreter.evaluateExpression(info.cond);
                            } catch (error) {
                                if (isInputSuspend(error)) throw error;
                                if ((error as Exception).type === ExceptionType.ASSERTION_ERROR) throw error;
                                reportError(ExceptionType.SYNTAX_ERROR, t('assert_condition_invalid', { expr: info.cond }));
                                frame.pc++;
                                break;
                            }
                            if (!condition) {
                                // 条件为假: 复刻 executeAssert 取下一行作消息抛 ASSERTION_ERROR (行号 = 消息行)
                                if (info.msg === null) {
                                    reportError(ExceptionType.SYNTAX_ERROR, t('assert_message_quoted'));
                                    frame.pc++;
                                    break;
                                }
                                throw { type: ExceptionType.ASSERTION_ERROR, message: info.msg, lineNumber: currentLinePointer + 1 } as Exception;
                            }
                            debugLog(1, () => t('dbg_assert_true', { expr: info.cond }));
                            frame.pc = b; // 跳过消息行 + endasrt
                            break;
                        }
                        case NSVMOp.ASSERTFAIL:
                            throw { type: ExceptionType.ASSERTION_ERROR, message: consts[a], lineNumber: currentLinePointer } as Exception;
                        default:
                            throw { type: ExceptionType.UNKNOWN_ERROR, message: t('internal_error', { line: currentLinePointer + 1, message: `未知 NSVM 指令 ${op}` }), lineNumber: currentLinePointer } as Exception;
                    }
                }

                // 块尾: 函数块无 RET 直接结束 → 走 executeFunctionEndTag 语义 (void 函数或报错);
                // 报错后仍返回调用方继续执行 (executeFunctionEndTag 报错后 currentLinePointer = callFrom, 主循环继续), 不得终止整个 VM
                if (NSVMExecutor.frames.length > 1) {
                    const curFrame = NSVMExecutor.frames.pop() as NSVMFrame;
                    const topFrame = CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1];
                    if (topFrame && topFrame.type === 'function') {
                        const funcInfo = FUNCTIONS[topFrame.funcName];
                        const block = topFrame as any;
                        LOCAL_VARS.length = block.frameVarStart;
                        delete SLOT_INDEX[String(block.frameId)];
                        CONTROL_FLOW_STACK.pop();
                        if (funcInfo && !ScopeManager.isVoidFunction(funcInfo)) {
                            reportError(ExceptionType.TYPE_ERROR, t('func_reached_end_no_return', { name: funcInfo.name, type: funcInfo.returnType }));
                        } else {
                            debugLog(1, () => t('dbg_func_void_return', { name: funcInfo.name }));
                        }
                    }
                    frame = NSVMExecutor.frames[NSVMExecutor.frames.length - 1];
                    frame.pc = curFrame.retAddr;
                    continue;
                }
                // 全局块尾 (无 HALT 情形): 正常结束
                currentLinePointer = programLines.length; // 复刻主循环退出时行指针
                if (EXCEPTION_STACK.length > 0) debugLog(1, () => t('dbg_program_stopped_error'));
                else debugLog(1, () => t('dbg_program_finished'));
                return;
            } catch (error) {
                // input 挂起信号: 交还控制权
                if (isInputSuspend(error)) {
                    INPUT_SUSPENDED = true;
                    return;
                }
                const exception = error as Exception;
                if (exception.lineNumber === undefined) exception.lineNumber = currentLinePointer;

                // 从当前帧向调用方链查找最近 handler
                let handled = false;
                while (NSVMExecutor.frames.length > 0) {
                    const f = NSVMExecutor.frames[NSVMExecutor.frames.length - 1];
                    let hitIdx = -1;
                    for (let i = NSVMExecutor.vmTryStack.length - 1; i >= 0; i--) {
                        if (NSVMExecutor.vmTryStack[i].block === f.block) { hitIdx = i; break; }
                    }
                    if (hitIdx !== -1) {
                        const handler = f.block.handlers[NSVMExecutor.vmTryStack[hitIdx].handlerIdx];
                        // 保留命中帧 (供 ENDTRY pop), 仅弹掉其上的内层条目
                        NSVMExecutor.vmTryStack.length = hitIdx + 1;
                        // 清理本块内 TRY 指令之后压入的 switch 帧 (主循环 CONTROL_FLOW_STACK.length = tryIdx+1 的对应物:
                        // try 内的 switch 帧被弹, try 外先于 try 压入的 switch 帧保留)
                        for (let j = NSVMExecutor.switchStack.length - 1; j >= 0; j--) {
                            if (NSVMExecutor.switchStack[j].block === f.block && NSVMExecutor.switchStack[j].pc > handler.tryInstr) {
                                NSVMExecutor.switchStack.length = j;
                                break;
                            }
                        }
                        // 清理 CONTROL_FLOW_STACK 到 try 帧 + EXCEPTION_STACK (与主循环一致)
                        let tryIdx = -1;
                        for (let j = CONTROL_FLOW_STACK.length - 1; j >= 0; j--) {
                            if (CONTROL_FLOW_STACK[j].type === 'try') { tryIdx = j; break; }
                        }
                        if (tryIdx !== -1) {
                            const tryFrame = CONTROL_FLOW_STACK[tryIdx] as any;
                            CONTROL_FLOW_STACK.length = tryIdx + 1;
                            let excIdx = -1;
                            for (let j = EXCEPTION_STACK.length - 1; j >= 0; j--) {
                                if (EXCEPTION_STACK[j].type === ExceptionType.TRY_BLOCK && EXCEPTION_STACK[j].lineNumber === tryFrame.start) { excIdx = j; break; }
                            }
                            if (excIdx !== -1) EXCEPTION_STACK.length = excIdx;
                        }
                        PENDING_EXCEPTION = exception;
                        f.pc = handler.catchInstr;
                        currentLinePointer = f.block.lines[f.pc];
                        frame = f;
                        handled = true;
                        break;
                    }
                    // 本帧无 handler → 冒泡到调用方
                    if (f.caller) {
                        NSVMExecutor.frames.pop();
                        // 清理被弹帧的残留 try/switch 帧 (防污染后续匹配; 本帧无 handler 时其 vmTryStack 通常为空,
                        // switch 帧可能残留 — 如 switch 块内调用未捕获异常的函数)
                        for (let j = NSVMExecutor.vmTryStack.length - 1; j >= 0; j--) {
                            if (NSVMExecutor.vmTryStack[j].block === f.block) NSVMExecutor.vmTryStack.splice(j, 1);
                        }
                        for (let j = NSVMExecutor.switchStack.length - 1; j >= 0; j--) {
                            if (NSVMExecutor.switchStack[j].block === f.block) NSVMExecutor.switchStack.splice(j, 1);
                        }
                        for (let j = CONTROL_FLOW_STACK.length - 1; j >= 0; j--) {
                            if (CONTROL_FLOW_STACK[j].type === 'function') {
                                CONTROL_FLOW_STACK.length = j;
                                break;
                            }
                        }
                    } else {
                        break; // 全局帧无 handler
                    }
                }

                if (!handled) {
                    // 未捕获: 与主循环一致 — reportError 后终止执行, 并复刻主循环退出时的收尾调试输出
                    if (Object.values(ExceptionType).includes(exception.type)) {
                        reportError(exception.type, exception.message);
                    } else {
                        const nativeMsg = error instanceof Error ? error.message : String(error);
                        console.error(t('internal_error', { line: currentLinePointer + 1, message: nativeMsg }));
                        console.error(t('internal_error_hint'));
                    }
                    currentLinePointer = programLines.length;
                    if (EXCEPTION_STACK.length > 0) debugLog(1, () => t('dbg_program_stopped_error'));
                    else debugLog(1, () => t('dbg_program_finished'));
                    return;
                }
                // handled: 继续执行
            }
        }
    }

    // CALLFUNC 执行器 (case 外提): 完整复刻 executeCall 语义。case 内联巨大块会拖累主分发循环的
    // Turbofan 优化, 外提后主循环恢复热路径优化。返回新帧 (切帧成功) 或 null (失败/未切帧, 内部已 pc++)。
    static executeCallCompiled(consts: any[], a: number, b: number, c: number, frame: NSVMFrame): NSVMFrame | null {
        // 严格按设计稿注意点1: 实参个数 argc 一律从 modesK 模式表长度读取, 绝不从操作数 c 携带
        const modesK = consts[b] as Int32Array;
        const argc = modesK.length;
        const fnK = consts[a] as string;
        const meta = consts[c] as NSVMCallMeta;
        const funcInfo = FUNCTIONS[fnK];
        const oldPc = frame.pc;
        // 复刻 executeCommand CALL 分发 → executeCall 入口调试输出 (先 debug 2 执行指令, 后 debug 1 开始执行函数调用)
        // 惰性化: DEBUG_LEVEL 不足时短路, 免闭包创建 (热路径: 每调用 ~20 个 debugLog 闭包)
        if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_execute_instr', { content: meta.content }));
        if (DEBUG_LEVEL >= 1) debugLog(1, () => t('dbg_start_func_call', { params: meta.callParams }));
        if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_func_info'), funcInfo);
        // 阶段1: 解析实参 (复刻 executeCall 解析段; 失败即 reportError + 调用方继续, 无绑定污染)
        const args: any[] = [];
        let parseFailed = false;
        for (let i = 0; i < argc; i++) {
            if (modesK[i] === 0) {
                try {
                    args.push(Interpreter.parseValue(meta.argExprs[i], funcInfo.params[i].type));
                } catch (error) {
                    // 实参表达式中的 input() 挂起信号穿透
                    if (isInputSuspend(error)) throw error;
                    reportError(ExceptionType.TYPE_ERROR, t('func_arg_type_error', {name: fnK, argIndex: i + 1}));
                    parseFailed = true;
                    break;
                }
            } else {
                args.push(null); // 数组实参: 绑定阶段按模式处理
            }
        }
        if (parseFailed) { frame.pc++; return null; }
        // 保存调用所在行号 / 分配帧ID / 记录本帧首个局部变量位置 (复刻 executeCall)
        const oldLinePointer = currentLinePointer;
        const frameId = ++CALL_FRAME_ID;
        const callVarStart = LOCAL_VARS.length;
        if (DEBUG_LEVEL >= 2) {
            debugLog(2, () => t('dbg_func_start_passing', { funcName: fnK }));
            debugLog(2, () => t('dbg_func_info'), funcInfo);
            debugLog(2, () => t('dbg_param_count', { count: funcInfo.params.length }), args);
            debugLog(2, () => t('dbg_param_loop_start'));
            debugLog(2, () => t('dbg_func_call_args', { funcName: fnK }), args, () => t('dbg_curr_line', { line: currentLinePointer + 1 }));
        }
        // 阶段2: 绑定参数到 callee 帧参数槽位 (寄存器直写, 复刻 executeCall 绑定循环)
        for (let i = 0; i < argc; i++) {
            if (DEBUG_LEVEL >= 3) debugLog(3, () => t('dbg_loop_index', { i }));
            const param = funcInfo.params[i];
            const paramName = param.name;
            if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_set_param', { paramName, paramType: param.type }));
            const mode = modesK[i];
            if (param.type === DataType.ARRAY) {
                if (mode === 4) {
                    // 数组字面量: 创建临时数组 (只读视图) — 复刻 executeCall literal 分支
                    const elementsStr = meta.argExprs[i].slice(1, -1);
                    const elementStrs = Interpreter.splitArrayElements(elementsStr);
                    let literalElements: ArrayElement[] = [];
                    try {
                        literalElements = elementStrs.map(es => {
                            const ess = es.trim();
                            if (ess.startsWith('"') && ess.endsWith('"')) {
                                return { value: ess.slice(1, -1), type: DataType.STRING };
                            }
                            if (ess === 'true') return { value: true, type: DataType.BOOL };
                            if (ess === 'false') return { value: false, type: DataType.BOOL };
                            const num = Number(ess);
                            // 整数字面量推断 INT, 小数推断 FLOAT (与 inferLiteralElement 一致)
                            if (ess !== '' && !isNaN(num) && isFinite(num)) return { value: num, type: Number.isInteger(num) ? DataType.INT : DataType.FLOAT };
                            throw { type: ExceptionType.SYNTAX_ERROR, message: t('array_literal_element_unresolvable', {value: ess}) } as Exception;
                        });
                    } catch (e) {
                        reportError(ExceptionType.TYPE_ERROR, t('array_literal_arg_parse_failed', {error: (e as Error).message}));
                        LOCAL_VARS = LOCAL_VARS.filter(v => v.frameId !== frameId);
                        rebuildSlotIndex();
                        frame.pc++;
                        return null;
                    }
                    // 元素类型校验: 字面量推断类型须与形参声明一致 (数组形参声明了元素类型时)
                    if (param.arrayElementType !== undefined && literalElements.length > 0) {
                        const actualElemType = literalElements[0].type;
                        if (!Interpreter.canArrayElementFit(actualElemType, param.arrayElementType)) {
                            reportError(ExceptionType.TYPE_ERROR, t('array_elem_type_mismatch', { expected: param.arrayElementType, actual: actualElemType }));
                            LOCAL_VARS = LOCAL_VARS.filter(v => v.frameId !== frameId);
                            rebuildSlotIndex();
                            frame.pc++;
                            return null;
                        }
                    }
                    const literalVar: Variable = {
                        name: paramName,
                        value: "请使用arrayElements属性访问数组元素",
                        type: DataType.ARRAY,
                        isGlobal: false,
                        isConst: false,
                        startLine: funcInfo.startLine + 1,
                        endLine: funcInfo.endLine,
                        frameId: frameId,
                        arrayLength: literalElements.length,
                        arrayElementType: literalElements.length > 0 ? literalElements[0].type : DataType.NUMBER,
                        arrayElements: literalElements,
                        isReadonlyArray: true
                    };
                    LOCAL_VARS.push(literalVar);
                    (SLOT_INDEX[String(frameId)] || (SLOT_INDEX[String(frameId)] = {}))[i] = literalVar;
                    if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_array_param_literal', { paramName, length: literalElements.length }));
                    continue;
                }
                // 数组引用 / mut / copy — 复刻 executeCall 数组分支 (parseArrayArgument 先提取变量名)
                const arrArgMode = mode === 1 ? 'ref' : mode === 2 ? 'mut' : 'copy';
                const argStr = meta.argExprs[i].trim();
                let arrArgName = argStr;
                if (mode === 2) arrArgName = argStr.match(/^mut\s+([a-zA-Z_][a-zA-Z0-9_.]*)$/)![1];
                else if (mode === 3) arrArgName = argStr.match(/^copy\s*\(\s*([a-zA-Z_][a-zA-Z0-9_.]*)\s*\)$/)![1];
                const arrVar = ScopeManager.getVariable(arrArgName, currentLinePointer, true, arrArgName.startsWith('global.'));
                if (!arrVar || arrVar.type !== DataType.ARRAY) {
                    reportError(ExceptionType.TYPE_ERROR, t('arr_arg_not_array', {name: arrArgName}));
                    LOCAL_VARS = LOCAL_VARS.filter(v => v.frameId !== frameId);
                    rebuildSlotIndex();
                    frame.pc++;
                    return null;
                }
                // 元素类型校验: 实参数组元素类型须与形参声明一致
                if (param.arrayElementType !== undefined && arrVar.arrayElementType !== undefined &&
                    !Interpreter.canArrayElementFit(arrVar.arrayElementType, param.arrayElementType)) {
                    reportError(ExceptionType.TYPE_ERROR, t('array_elem_type_mismatch', { expected: param.arrayElementType, actual: arrVar.arrayElementType }));
                    LOCAL_VARS = LOCAL_VARS.filter(v => v.frameId !== frameId);
                    rebuildSlotIndex();
                    frame.pc++;
                    return null;
                }
                const paramVar: Variable = {
                    name: paramName,
                    value: "请使用arrayElements属性访问数组元素",
                    type: DataType.ARRAY,
                    isGlobal: false,
                    isConst: false,
                    startLine: funcInfo.startLine + 1,
                    endLine: funcInfo.endLine,
                    frameId: frameId,
                    arrayLength: arrVar.arrayLength,
                    arrayElementType: arrVar.arrayElementType,
                    arrayElements: arrArgMode === 'copy'
                        ? arrVar.arrayElements!.map((e: ArrayElement) => ({ value: e.value, type: e.type }))
                        : arrVar.arrayElements,
                    isReadonlyArray: arrArgMode === 'copy' ? false : !param.isMutable
                };
                LOCAL_VARS.push(paramVar);
                (SLOT_INDEX[String(frameId)] || (SLOT_INDEX[String(frameId)] = {}))[i] = paramVar;
                if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_array_param_bound', { paramName, mode: arrArgMode, length: arrVar.arrayLength, readonly: paramVar.isReadonlyArray }));
                continue;
            }
            const argValue = args[i] !== undefined ? args[i] : null;
            ScopeManager.addVariable(paramName, argValue, param.type, funcInfo.startLine + 1, funcInfo.endLine, false, false, frameId, i);
            if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_param_bound_slot', { paramName, slot: i }));
        }
        if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_param_loop_end'));
        // 返回值变量绑定 (复刻 executeCall): 函数体首行跳过标签行, 槽位 = 参数个数 (bodyStartLine 编译期预解析)
        const functionBodyStartLine = meta.bodyStartLine;
        if (funcInfo.returnType !== DataType.UNDEFINED && funcInfo.returnVarName !== undefined) {
            ScopeManager.addVariable(funcInfo.returnVarName, undefined, funcInfo.returnType, functionBodyStartLine, funcInfo.endLine, false, false, frameId, funcInfo.params.length, funcInfo.returnArrayElementType);
        }
        if (DEBUG_LEVEL >= 3) debugLog(3, () => t('dbg_current_local_var_details'), LOCAL_VARS);
        if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_func_param_done', { funcName: fnK }));

        // 额外的调试信息, 检查参数是否真的被添加 (复刻 executeCall debug 3; 循环门控 DEBUG_LEVEL>=3 免热路径开销)
        if (DEBUG_LEVEL >= 3) {
            debugLog(3, () => t('dbg_check_params_added'));
            for (let i = 0; i < argc; i++) {
                const paramName = funcInfo.params[i].name;
                let found = false;
                for (let j = 0; j < LOCAL_VARS.length; j++) {
                    if (LOCAL_VARS[j].name === paramName) {
                        debugLog(3, () => t('dbg_param_index', { paramName, index: j }));
                        found = true;
                        break;
                    }
                }
                if (!found) {
                    debugLog(3, () => t('dbg_param_not_found', { paramName }));
                }
            }

            // 进一步调试: 检查每个参数在 LOCAL_VARS 中的详细信息 (复刻 executeCall debug 3)
            debugLog(3, () => t('dbg_check_params_detail'));
            for (let i = 0; i < argc; i++) {
                const paramName = funcInfo.params[i].name;
                const paramType = funcInfo.params[i].type;
                let paramFound = false;
                for (let j = 0; j < LOCAL_VARS.length; j++) {
                    if (LOCAL_VARS[j].name === paramName) {
                        debugLog(3, () => t('dbg_param_detail', { paramName, index: j, value: LOCAL_VARS[j].value, type: LOCAL_VARS[j].type, scopeStart: LOCAL_VARS[j].startLine + 1, scopeEnd: LOCAL_VARS[j].endLine === -1 ? t('dbg_last_line') : LOCAL_VARS[j].endLine + 1 }));
                        // 验证类型是否匹配
                        if (LOCAL_VARS[j].type !== paramType) {
                            debugLog(3, () => t('dbg_warn_param_type', { paramName, expected: paramType, actual: LOCAL_VARS[j].type }));
                        }
                        paramFound = true;
                        break;
                    }
                }
                if (!paramFound) {
                    debugLog(3, () => t('dbg_param_not_found', { paramName }));
                }
            }
        }

        // 设置 currentLinePointer 为函数体开始行 (复刻 executeCall: 主循环会自动加一执行函数体内部的代码)
        currentLinePointer = funcInfo.startLine;
        if (DEBUG_LEVEL >= 2) {
            debugLog(2, () => t('dbg_func_body_start', { line: functionBodyStartLine + 1 }));
            // 添加作用域调试信息
            debugLog(2, () => t('dbg_func_scope_details', { funcName: fnK }));
            debugLog(2, () => t('dbg_return_var_scope', { name: funcInfo.returnType !== DataType.UNDEFINED ? funcInfo.returnVarName : undefined, scopeStart: functionBodyStartLine + 1, scopeEnd: funcInfo.endLine === -1 ? t('dbg_last_line') : funcInfo.endLine + 1 }));
            debugLog(2, () => t('dbg_param_scope', { scopeStart: functionBodyStartLine + 1, scopeEnd: funcInfo.endLine === -1 ? t('dbg_last_line') : funcInfo.endLine + 1 }));
        }
        // 压 function 帧 (复刻 executeCall, callFrom = 调用源行号供返回/报错恢复)
        CONTROL_FLOW_STACK.push({
            type: 'function',
            funcName: fnK,
            startLine: funcInfo.startLine,
            endLine: funcInfo.endLine,
            callFrom: oldLinePointer,
            returnVarName: meta.resultVar,
            frameId: frameId,
            frameVarStart: callVarStart
        });
        if (DEBUG_LEVEL >= 2) debugLog(2, () => t('dbg_control_flow_stack'), CONTROL_FLOW_STACK);
        // 切换到 callee 的 VM 块
        const fb = NSVMExecutor.funcBlocks.get(fnK);
        if (fb) {
            NSVMExecutor.frames.push({
                block: fb, pc: 0, retAddr: oldPc + 1,
                caller: frame, callFrom: oldLinePointer
            });
            return NSVMExecutor.frames[NSVMExecutor.frames.length - 1];
        }
        frame.pc++;
        return null;
    }
}

// 如果在Node.js环境中运行, 则调用main函数
if (typeof process !== 'undefined' && process.argv) {
    main();
}

// ========== 浏览器接口 ==========
// 核心逻辑为纯 TS, 不依赖 Node API (fs 已条件加载, main 已在 Node 守卫内)。
// 浏览器中加载本文件后, 可通过 window.NSI (或 globalThis.NSI) 调用解释器。

// 浏览器入口: 加载并执行一段 NoethingScript 代码
function nsiRun(code: string): void {
    Interpreter.loadProgram(code);
    Interpreter.run();
}

// 浏览器入口: 切换输出语言 ('zh' | 'en')
function nsiSetLanguage(lang: 'zh' | 'en'): void {
    if (lang === 'en' || lang === 'zh') {
        LANG = lang;
    }
}

// 浏览器入口: 绑定自定义运行时输入处理器 (同步函数, 返回一行字符串; 传入 null 恢复默认 prompt)
function nsiSetInput(handler: (() => string) | null): void {
    INPUT_HANDLER = handler;
}

// 浏览器入口: 交互执行 — 脚本自持主流程, 遇到 input() 且无可用输入时挂起并通知宿主,
// 宿主 (如按键事件) 通过 NSI.resumeInput(value) 提供输入后从挂起点继续执行。
// 返回 'suspended' (等待下一次输入) 或 'finished' (程序自然结束)。
// 注意: 交互模式下一行内应只出现一次 input() (恢复时会重执行挂起行)。
function nsiRunInteractive(code: string, onInput?: () => void): string {
    Interpreter.loadProgram(code);
    INPUT_INTERACTIVE_MODE = true;
    INPUT_ON_REQUEST = onInput || null;
    INPUT_PRELOAD = [];
    INPUT_SUSPENDED = false;
    Interpreter.run();
    return INPUT_SUSPENDED ? 'suspended' : 'finished';
}

// 浏览器入口: 为挂起的 input() 提供一行输入并继续执行 (返回 'suspended' 或 'finished')
function nsiResumeInput(value: string): string {
    if (!INPUT_SUSPENDED) return 'finished';
    INPUT_PRELOAD.push(String(value));
    Interpreter.run();
    return INPUT_SUSPENDED ? 'suspended' : 'finished';
}

// 浏览器全局暴露: 仅在浏览器环境 (存在 window) 时挂载, 不影响 Node 运行
if (typeof window !== 'undefined') {
    (window as any).NSI = {
        version: NSIVersion,
        run: nsiRun,
        runInteractive: nsiRunInteractive,
        resumeInput: nsiResumeInput,
        setLanguage: nsiSetLanguage,
        getLanguage: (): 'zh' | 'en' => LANG,
        setInput: nsiSetInput,
        Interpreter: Interpreter,
        ExpressionEvaluator: ExpressionEvaluator,
        ScopeManager: ScopeManager,
        LANG_PACKS: LANG_PACKS
    };
}
