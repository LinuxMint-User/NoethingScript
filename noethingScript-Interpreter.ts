
// 解释器版本
const NSIVersion: string = "2.4.0";
// console.log("NSI Version: " + NSIVersion);

// Debug级别变量
var DEBUG_LEVEL: number = 0; // 默认不输出debug信息

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
function debugLog(level: number, ...args: any[]): void {
    if (DEBUG_LEVEL >= level) {
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
}

// 函数信息接口定义
interface FunctionInfo {
    name: string;
    params: FunctionParameter[];
    returnType: DataType;
    startLine: number;
    endLine: number;
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
        func_no_array_return: '函数 {name} 未返回数组值'
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
        func_no_array_return: 'Function {name} did not return an array value'
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
        debugLog(1, () => `验证数据类型: 值 ${value === "" ? '""' : value}, 类型 ${type}`);
        // 未初始化变量 (无 = 值 的声明) 或 无返回值函数返回值变量: 值为 undefined
        if (value === undefined) {
            debugLog(1, () => `未初始化变量, 存储 undefined`);
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
                debugLog(1, () => `数据类型验证到达默认分支`)
                return { isValid: true, convertedValue: value };
        }
    }

    // 添加变量 (全局或局部)
    static addVariable(name: string, value: any, type: DataType, startLine: number, endLine: number, isGlobal: boolean = false, isConst: boolean = false, frameId?: number): boolean {
        debugLog(1, () => `尝试添加${isConst ? '常量' : '变量'}: ${name}, 值: ${value}, 类型: ${type}, 作用域: ${startLine + 1}-${endLine === -1 ? "末行" : endLine + 1}, 是否全局: ${isGlobal}`);
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
            frameId
        };

        if (isGlobal) {
            if (GLOBAL_VARS.hasOwnProperty(name)) {
                reportError(ExceptionType.REFERENCE_ERROR, t('name_already_defined', {name: name}));
                // currentLinePointer = programLines.length;
                // throw { type: ExceptionType.REFERENCE_ERROR, message: `引用错误: 名称 '${name}' 已被定义` } as Exception;
                return false;
            }
            GLOBAL_VARS[name] = variable;
            debugLog(1, () => `全局变量 ${name} 添加成功`);
        } else {
            // 检查是否存在名称、作用域和调用帧完全相同的局部变量 (不同调用帧允许同名, 以支持递归)
            for (const localVar of LOCAL_VARS) {
                if (localVar.name === name && localVar.frameId === variable.frameId && localVar.startLine === variable.startLine && localVar.endLine === variable.endLine) {
                    reportError(ExceptionType.REFERENCE_ERROR, t('name_defined_same_scope', {name: name}));
                    // currentLinePointer = programLines.length;
                    // throw { type: ExceptionType.REFERENCE_ERROR, message: `引用错误: 名称 '${name}' 在相同作用域内已被定义` } as Exception;
                    return false;
                }
            }
            LOCAL_VARS.push(variable);
            debugLog(1, () => `局部变量 ${name} 添加成功`);
        }

        // 如果未赋初值, 发出警告 (默认静默, 调试级别 >= 1 时显示, 避免先声明后赋值如 input() 场景刷屏)
        if (value === undefined && DEBUG_LEVEL >= 1) {
            reportWarn(t('var_declared_uninitialized', {name: name}), startLine + 1);
        }

        return true;
    }

    // 获取变量值 (考虑行号作用域) 
    static getVariable(vname: string, currentLine: number, isArray: boolean = false, isGlobal: boolean = false): any {
        let name: string = vname;
        debugLog(2, () => `查找${isGlobal ? '全局' : ''}${isArray ? '数组' : '变量'}: ${name} (行 ${currentLine + 1})`);
        debugLog(2, () => `${isGlobal ? '' : `当前局部变量 (含数组) 数量: ${LOCAL_VARS.length}, `}当前全局变量数量: ${Object.keys(GLOBAL_VARS).length}`);
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

                debugLog(3, () => `检查 ${varInfo.name}${isArray ? ' (数组) ' : ''}: 作用域${varInfo.startLine + 1}-${varInfo.endLine === -1 ? "末行" : varInfo.endLine + 1} 当前行${currentLine + 1} 在范围内: ${inScope}`);

                if (varInfo.name === name && inScope) {
                    debugLog(1, () => `获取${isArray ? '数组' : '变量'} ${name} (局部): 值=${varInfo.value}, 类型=${varInfo.type}, 行号=${currentLine + 1}`);
                    return isArray ? varInfo : varInfo.value;
                }
            }

            debugLog(2, () => `局部变量详情:`, LOCAL_VARS);
        }

        debugLog(2, () => `全局变量详情:`, GLOBAL_VARS);
        // 2. 再检查全局变量
        if (GLOBAL_VARS.hasOwnProperty(name)) {
            debugLog(1, () => `获取${isArray ? '数组' : '变量'} ${name} (全局): ${isArray ? `长度=${GLOBAL_VARS[name].arrayLength}` : `值=${GLOBAL_VARS[name].value}`}, 类型=${GLOBAL_VARS[name].type}, 行号=${currentLine + 1}`);
            return isArray ? GLOBAL_VARS[name] : GLOBAL_VARS[name].value;

        }

        debugLog(1, () => `警告: 变量 ${name} 未定义 (行 ${currentLine + 1})`);
        return undefined;
    }

    // 获取变量信息 (考虑行号作用域) 
    static getVariableInfo(vname: string, currentLine: number, isGlobal: boolean = false): Variable | null {
        let name: string = vname;
        debugLog(2, () => `查找${isGlobal ? '全局' : ''}变量信息: ${name} (行 ${currentLine + 1})`);

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
                        debugLog(1, () => `获取变量信息 ${name} (局部): 值=${varInfo.value}, 类型=${varInfo.type}, 作用域=${varInfo.startLine + 1}-${varInfo.endLine === -1 ? '末行' : varInfo.endLine + 1}, 行号=${currentLine + 1}`);
                        return varInfo;
                    }
                }
            }
        }

        // 2. 再检查全局变量
        if (GLOBAL_VARS.hasOwnProperty(name)) {
            debugLog(1, () => `获取变量信息 ${name} (全局): 值=${GLOBAL_VARS[name].value}, 类型=${GLOBAL_VARS[name].type}, 作用域=${GLOBAL_VARS[name].startLine + 1}-${GLOBAL_VARS[name].endLine === -1 ? '末行' : GLOBAL_VARS[name].endLine + 1}, 行号=${currentLine + 1}`);
            return GLOBAL_VARS[name];
        }

        debugLog(1, () => `警告: 变量 ${name} 未定义 (行 ${currentLine + 1})`);
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
        debugLog(2, () => `设置${isGlobal ? '全局' : '局部'}变量 ${name} (行 ${currentLine + 1})`);

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
        debugLog(2, () => `查找${isGlobal ? '全局' : ''}变量: ${name} (行 ${currentLine + 1})`);
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

                debugLog(3, () => `  检查 ${varInfo.name}: 作用域${varInfo.startLine + 1}-${varInfo.endLine === -1 ? "末行" : varInfo.endLine + 1} ` +
                    `当前行${currentLine + 1} 在范围内: ${inScope}`);

                if (varInfo.name === name && inScope) {
                    debugLog(2, () => `  找到变量: ${name} = ${varInfo.value === "" ? '""' : varInfo.value}`);
                    foundVar = varInfo;
                    return true; // 优先返回最近声明的变量
                }
            }
        }

        // 检查全局变量
        const globalExists = GLOBAL_VARS.hasOwnProperty(name);
        if (globalExists) {
            debugLog(2, () => `  找到全局变量: ${name} = ${GLOBAL_VARS[name].value === "" ? '""' : GLOBAL_VARS[name].value}`);
        }
        return globalExists;
    }

    // 注册函数
    static registerFunction(funcInfo: FunctionInfo): void {
        debugLog(2, () => `${funcInfo.endLine === -1 ? '未完整注册的函数' : '已完整注册的函数'}: ${funcInfo.name}`);
        debugLog(3, () => `注册函数作用域: ${funcInfo.name} (行 ${funcInfo.startLine + 1}-${funcInfo.endLine === -1 ? '末行' : funcInfo.endLine + 1})`);

        FUNCTIONS[funcInfo.name] = funcInfo; // 直接覆盖同名函数定义，不支持函数重载
        debugLog(2, () => `当前注册的函数:`, FUNCTIONS);
    }

    // 获取当前行所在的函数名
    static getCurrentFunction(currentLine: number): string | null {
        debugLog(3, () => `查找第 ${currentLine + 1} 行所在函数`);
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
        const funcDefLine = programLines[funcInfo.startLine].trim();
        const funcMatch = funcDefLine.match(/^:([a-zA-Z0-9_]+)\s*\((.*)\)\s*->\s*(:?[a-zA-Z0-9_]+)(?:\s*:([a-zA-Z0-9_]+))?$/);
        if (funcMatch) {
            const returnVarNameOrVoid = funcMatch[3];
            if (returnVarNameOrVoid !== ':void') {
                return returnVarNameOrVoid.startsWith(':') ? returnVarNameOrVoid.substring(1) : returnVarNameOrVoid;
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
            debugLog(1, () => `已清除全局变量 ${varName}`);
        }
        else {
            debugLog(1, () => `全局变量 ${varName} 不存在`);
        }
    }

    // 清理指定局部变量 (手动管理, 必须手动指定作用域范围) 
    static cleanupLocalVariable(cleanAll: Boolean = false, exceptMode?: Boolean, varName?: string, startLine?: number, endLine?: number, frameId?: number) {
        if (cleanAll) {
            LOCAL_VARS = [];
            debugLog(1, () => `已清除所有局部变量`);
            return;
        }
        if (!cleanAll && exceptMode === undefined) {
            reportError(ExceptionType.SYNTAX_ERROR, t('purge_mode_not_specified'));
            return;
        }
        if (!cleanAll && varName && startLine !== undefined && endLine !== undefined && !exceptMode) {
            debugLog(2, () => `清除指定局部变量 ${varName}, 作用域: ${startLine + 1}-${endLine === -1 ? '末行' : endLine + 1}`);
            LOCAL_VARS = LOCAL_VARS.filter(varInfo => !(varInfo.name === varName && varInfo.startLine === startLine && varInfo.endLine === endLine && varInfo.frameId === frameId));
            return;
        }
        if (!cleanAll && varName && startLine !== undefined && endLine !== undefined && exceptMode) {
            debugLog(2, () => `清除指定局部变量 ${varName} 之外的所有变量, 作用域: ${startLine + 1}-${endLine === -1 ? '末行' : endLine + 1}`);
            LOCAL_VARS = LOCAL_VARS.filter(varInfo => (varInfo.name === varName && varInfo.startLine === startLine && varInfo.endLine === endLine && varInfo.frameId === frameId));
            return;
        }
        if (!cleanAll && !varName && startLine !== undefined && endLine !== undefined) {
            if (exceptMode) {
                reportWarn(t('purge_scope_no_except'));
            }
            LOCAL_VARS = LOCAL_VARS.filter(varInfo => !(varInfo.startLine >= startLine && varInfo.endLine <= endLine));
            return;
        }
        else {
            reportError(ExceptionType.SYNTAX_ERROR, t('purge_target_not_specified'));
            return;
        }
    }

    // 检查函数返回类型是否为undefined (void函数) 
    static isVoidFunction(funcInfo: FunctionInfo): boolean {
        debugLog(3, () => `检查函数 ${funcInfo.name} 是否为 void 函数`);
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
        LINE_INFO = programLines.map(raw => {
            const content = raw.trim();
            return {
                content,
                isEmpty: content === '',
                isComment: content.indexOf('//') === 0,
                isEndTag: content === ':end'
            };
        });
        currentLinePointer = 0;
        TAGS = {};
        FUNCTIONS = {};
        GLOBAL_VARS = {};
        LOCAL_VARS = [];
        IN_MULTILINE_COMMENT = false;

        // 第一次扫描: 解析标签和函数定义
        Interpreter.scanTagsAndFunctions();
    }

    // 扫描标签和函数定义
    static scanTagsAndFunctions(): void {
        debugLog(1, () => `开始扫描标签和函数定义`);
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
                debugLog(1, () => `找到标签: ${tagName} (行 ${i + 1})`);
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
                        debugLog(2, () => `检测到函数结束标记, 更新函数信息`);
                        let funcInfo = currentFunction;
                        funcInfo.endLine = i;
                        ScopeManager.registerFunction(funcInfo);
                        debugLog(2, () => `更新后的函数注册信息`, FUNCTIONS);
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
                const funcMatch = line.match(/^:([a-zA-Z0-9_]+)\s*\((.*)\)\s*->\s*(:?[a-zA-Z0-9_]+)(?:\s*:([a-zA-Z0-9_]+))?$/);
                if (funcMatch) {
                    const funcName = funcMatch[1];

                    // 检查函数名是否符合C语言命名规则
                    if (!Interpreter.isValidIdentifier(funcName)) {
                        reportError(ExceptionType.REFERENCE_ERROR, t('func_name_invalid', {name: funcName}), i + 1);
                        return;
                    }
                    const paramsStr = funcMatch[2];
                    const returnVarNameOrVoid = funcMatch[3]; // 返回值变量名或:void
                    const returnTypeStr = funcMatch[4]; // 返回值类型 (如果有) 

                    // 处理返回值类型
                    let returnType: DataType;
                    let returnVarName: string | null = null;
                    // 检查是否是无返回值函数 (:void)
                    if (returnVarNameOrVoid === ':void') {
                        returnType = DataType.UNDEFINED; // 使用UNDEFINED表示void类型
                    } else {
                        // 有返回值函数, returnVarNameOrVoid是返回值变量名, returnTypeStr是返回值类型
                        if (!returnTypeStr) {
                            reportError(ExceptionType.SYNTAX_ERROR, t('func_return_type_required'), i + 1);
                            return;
                        }
                        returnType = Interpreter.getDataTypeFromString(returnTypeStr);
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
                            const paramType = Interpreter.getDataTypeFromString(paramTypeStr);
                            if (isMutable && paramType !== DataType.ARRAY) {
                                reportError(ExceptionType.SYNTAX_ERROR, t('func_param_mut_array_only', {param: paramMatch}), i + 1);
                                return;
                            }
                            params.push({
                                name: paramName,
                                type: paramType,
                                isMutable: isMutable
                            });
                        }
                    }

                    currentFunction = {
                        name: funcName,
                        params: params,
                        returnType: returnType,
                        startLine: i,
                        endLine: -1,
                        // hasReturnStatement: false
                    };
                    debugLog(3, () => `解析函数: ${funcName}, startLine: ${i}, params: ${JSON.stringify(params)}`);
                    inFunction = true;
                    ScopeManager.registerFunction(currentFunction);
                }
            }
        }

        if (inFunction) {
            reportError(ExceptionType.SYNTAX_ERROR, t('func_unclosed_at_eof'));
        }
        debugLog(1, () => `扫描标签和函数定义结束`);
    }

    // 辅助方法: 将字符串类型转换为DataType枚举
    private static getDataTypeFromString(typeStr: string): DataType {
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
    private static parseValue(valueStr: string, expectedType: DataType): any {
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

            // 检查第一行是否包含debug关键字
            if (programLines.length > 0) {
                const firstLine = programLines[0].trim();
                if (firstLine.startsWith('debug ')) {
                    const debugLevelStr = firstLine.substring(6).trim();
                    const debugLevel = parseInt(debugLevelStr);
                    if (!isNaN(debugLevel) && debugLevel >= DEBUG_LEVEL) {
                        DEBUG_LEVEL = debugLevel;
                        debugLog(1, () => `Debug级别设置为: ${DEBUG_LEVEL}`);
                    } else {
                        debugLog(1, () => `文档内指定调试级别 ${debugLevel} 低于外部指定调试级别 ${DEBUG_LEVEL}, 忽略文档内调试级别`);
                    }
                    // 跳过debug行
                    currentLinePointer = 1;
                }
            }
        } else {
            // 恢复执行 (NSI.resumeInput 从挂起处继续): 保留行指针/控制流栈/局部变量等执行现场
            INPUT_SUSPENDED = false;
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
                        Interpreter.executeCommand(line); // 先遇到函数结束标签可能处于无返回值函数中, 需要特殊处理
                    }

                    currentLinePointer++;
                    continue;
                }

                // 执行指令
                Interpreter.executeCommand(line);
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
                        debugLog(1, () => `异常被捕获: ${exception.message} (行 ${currentLinePointer + 1})`);
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
            debugLog(1, () => '程序因错误而停止');
        } else {
            debugLog(1, () => '程序执行完毕');
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

    // 判断一行命令是否以关键字开头 (需走完整 switch 分发)
    private static isKeywordCommand(command: string): boolean {
        const sp = command.indexOf(' ');
        const first = sp === -1 ? command : command.substring(0, sp);
        return Interpreter.KEYWORD_COMMANDS.indexOf(first.toLowerCase()) !== -1;
    }

    static executeCommand(command: string): void {
        debugLog(2, () => `执行指令 ${command}`);
        // 快速路径: 非关键字行 (纯赋值/表达式, 如 "i = i + 1") 直接交给 executeOperation,
        // 避免 split(/\s+/) 的数组分配与 switch 分发。行为与原 default 分支一致。
        if (!Interpreter.isKeywordCommand(command)) {
            Interpreter.executeOperation(command);
            return;
        }
        // 使用正则表达式 \s+ 按一个或多个空白字符分割命令字符串
        const parts = command.split(/\s+/);
        if (parts.length === 0) return;

        const cmd = parts[0].toLowerCase();

        // 检查是否是错误的const位置 (const在global/local之前) 
        if (cmd === 'const' && parts.length > 1) {
            const nextCmd = parts[1].toLowerCase();
            if (nextCmd === 'global' || nextCmd === 'local') {
                reportError(ExceptionType.SYNTAX_ERROR, t('var_decl_global_local_format'));
                return;
            }
        }

        switch (cmd) {
            case 'global':
                // 检查是否在global后面直接跟了const, 而不是在其他位置
                if (parts.length > 1 && parts[1].toLowerCase() === 'const') {
                    Interpreter.executeGlobal(parts.slice(1).join(' '));
                } else if (parts.length > 1 && parts[1].toLowerCase() !== 'const') {
                    // 检查parts[1]是否以const开头, 如果是则报语法错误
                    if (parts[1].toLowerCase().startsWith('const')) {
                        reportError(ExceptionType.SYNTAX_ERROR, t('var_decl_global_format'));
                        return;
                    }
                    Interpreter.executeGlobal(parts.slice(1).join(' '));
                } else {
                    reportError(ExceptionType.SYNTAX_ERROR, t('var_decl_global_format'));
                    return;
                }
                break;
            case 'local':
                // 检查是否在local后面直接跟了const, 而不是在其他位置
                if (parts.length > 1 && parts[1].toLowerCase() === 'const') {
                    Interpreter.executeLocal(parts.slice(1).join(' '));
                } else if (parts.length > 1 && parts[1].toLowerCase() !== 'const') {
                    // 检查parts[1]是否以const开头, 如果是则报语法错误
                    if (parts[1].toLowerCase().startsWith('const')) {
                        reportError(ExceptionType.SYNTAX_ERROR, t('var_decl_local_format'));
                        return;
                    }
                    Interpreter.executeLocal(parts.slice(1).join(' '));
                } else {
                    reportError(ExceptionType.SYNTAX_ERROR, t('var_decl_local_format'));
                    return;
                }
                break;
            case 'call':
                Interpreter.executeCall(parts.slice(1).join(' '));
                break;
            case 'return':
                Interpreter.executeReturn(parts.slice(1).join(' '));
                break;
            case 'jump':
                Interpreter.executeJump(parts.slice(1).join(' '));
                break;
            case 'print':
                Interpreter.executePrint(parts.slice(1).join(' '));
                break;
            case 'if':
                Interpreter.executeIf(parts.slice(1).join(' '));
                break;
            case 'else':
                Interpreter.executeElse();
                break;
            case 'endif':
                // 弹出if控制块
                if (CONTROL_FLOW_STACK.length > 0 && CONTROL_FLOW_STACK[CONTROL_FLOW_STACK.length - 1].type === 'if') {
                    CONTROL_FLOW_STACK.pop();
                }
                break; // 无需特殊处理
            case 'while':
                Interpreter.executeWhile(parts.slice(1).join(' '));
                break;
            case 'endwhl':
                Interpreter.executeEndWhile();
                break;
            case 'for':
                Interpreter.executeFor(parts.slice(1).join(' '));
                break;
            case 'endfor':
                Interpreter.executeEndFor();
                break;
            case 'break':
                Interpreter.executeBreak();
                break;
            case 'continue':
                Interpreter.executeContinue();
                break;
            case 'try':
                Interpreter.executeTry();
                break;
            case 'catch':
                Interpreter.executeCatch(parts.slice(1).join(' '));
                break;
            case 'endtry':
                Interpreter.executeEndTry();
                break;
            case 'assert':
                Interpreter.executeAssert(parts.slice(1).join(' '));
                break;
            case 'endasrt':
                break; // 无需特殊处理
            case 'switch':
                Interpreter.executeSwitch(parts.slice(1).join(' '));
                break;
            case 'case':
                Interpreter.executeCase(parts.slice(1).join(' '));
                break;
            case 'default':
                Interpreter.executeDefault();
                break;
            case 'endswc':
                Interpreter.executeEndSwitch();
                break;
            case 'purge':
                Interpreter.executePurge(parts.slice(1).join(' '));
                break;
            case ':end':
                Interpreter.executeFunctionEndTag();
                break;
            default:
                // 处理变量赋值和其他操作指令
                Interpreter.executeOperation(command);
                break;
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
            debugLog(1, () => `${exception.message}`);
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
        debugLog(1, () => `代码块类型`, block.type);
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
                debugLog(1, () => 'switch 分支 运行至 default');
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
            debugLog(1, () => exception.message);
            return;
        }
    }

    // 执行函数调用
    static executeCall(params: string): void {
        debugLog(1, () => `开始执行函数调用: ${params}`);
        // 匹配格式: 函数名(参数1, 参数2, ...) -> 结果变量 或 函数名(参数1, 参数2, ...)
        const matchWithResult = params.match(/^([a-zA-Z0-9_]+)\((.*)\)\s*->\s*([a-zA-Z0-9_]+)$/);
        const matchWithoutResult = params.match(/^([a-zA-Z0-9_]+)\((.*)\)$/);

        let funcName: string;
        let argsStr: string;
        let resultVar: string | undefined;

        if (matchWithResult) {
            funcName = matchWithResult[1];
            argsStr = matchWithResult[2];
            resultVar = matchWithResult[3];
        } else if (matchWithoutResult) {
            funcName = matchWithoutResult[1];
            argsStr = matchWithoutResult[2];
            resultVar = undefined;
        } else {
            reportError(ExceptionType.SYNTAX_ERROR, t('call_format'));
            return;
        }

        if (!FUNCTIONS[funcName]) {
            // 函数未定义: 抛引用错误 (可被try-catch捕获)
            throw {
                type: ExceptionType.REFERENCE_ERROR,
                message: t('func_undefined', {name: funcName}),
                lineNumber: currentLinePointer
            } as Exception;
        }

        const funcInfo = FUNCTIONS[funcName];
        debugLog(2, () => `函数信息:`, funcInfo);

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
            if ((es.startsWith('"') && es.endsWith('"')) || (es.startsWith("'") && es.endsWith("'"))) {
                return { value: es.slice(1, -1), type: DataType.STRING };
            }
            if (es === 'true') return { value: true, type: DataType.BOOL };
            if (es === 'false') return { value: false, type: DataType.BOOL };
            const num = Number(es);
            if (es !== '' && !isNaN(num) && isFinite(num)) return { value: num, type: DataType.NUMBER };
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
        debugLog(2, () => `函数 ${funcName} 开始传递参数`);
        debugLog(2, () => `函数信息:`, funcInfo);
        debugLog(2, () => `参数数量: ${funcInfo.params.length}, 实际参数:`, args);
        debugLog(2, () => `开始参数传递循环`);
        debugLog(2, () => `函数调用: ${funcName}, 参数:`, args, `当前行: ${currentLinePointer + 1}`);
        for (let i = 0; i < funcInfo.params.length; i++) {
            debugLog(3, () => `循环索引: ${i}`);
            const param = funcInfo.params[i];
            const paramName = param.name;
            debugLog(2, () => `设置参数: ${paramName} (类型: ${param.type})`);

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
                        return;
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
                    debugLog(2, () => `数组参数 ${paramName} 绑定完成 (模式: literal, 长度: ${literalElements.length}, 只读: true)`);
                    continue;
                }

                const arrVar = ScopeManager.getVariable(arrArg.name, currentLinePointer, true, arrArg.name.startsWith('global.'));
                if (!arrVar || arrVar.type !== DataType.ARRAY) {
                    reportError(ExceptionType.TYPE_ERROR, t('arr_arg_not_array', {name: arrArg.name}));
                    LOCAL_VARS = LOCAL_VARS.filter(v => v.frameId !== frameId);
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
                debugLog(2, () => `数组参数 ${paramName} 绑定完成 (模式: ${arrArg.mode}, 长度: ${arrVar.arrayLength}, 只读: ${paramVar.isReadonlyArray})`);
                continue;
            }

            const argValue = args[i] !== undefined ? args[i] : null;
            const result = ScopeManager.addVariable(paramName, argValue, param.type, funcInfo.startLine + 1, funcInfo.endLine, false, false, frameId);
            debugLog(2, () => `参数 ${paramName} 添加${result ? '成功' : '失败'}`);
        }
        debugLog(2, () => `参数传递循环结束`);

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
            // 解析函数定义行获取返回值变量名
            const funcDefLine = programLines[funcInfo.startLine].trim();
            const funcMatch = funcDefLine.match(/^:([a-zA-Z0-9_]+)\s*\((.*)\)\s*->\s*(:?[a-zA-Z0-9_]+)(?:\s*:([a-zA-Z0-9_]+))?$/);
            if (funcMatch) {
                const returnVarNameOrVoid = funcMatch[3];
                if (returnVarNameOrVoid !== ':void') {
                    // 处理带冒号前缀的返回值变量名
                    returnVarName = returnVarNameOrVoid.startsWith(':') ? returnVarNameOrVoid.substring(1) : returnVarNameOrVoid;

                    // 将返回值变量添加到函数的局部作用域中
                    // 初始化为 undefined (doc规则13: 函数返回值变量会被初始化为undefined)
                    // 作用域从函数体开始行到函数结束行
                    ScopeManager.addVariable(returnVarName, undefined, funcInfo.returnType, functionBodyStartLine, funcInfo.endLine, false, false, frameId);
                }
            }
        }
        debugLog(3, () => '当前局部变量详情:', LOCAL_VARS);
        debugLog(2, () => `函数 ${funcName} 参数传递完成`);

        // 额外的调试信息, 检查参数是否真的被添加
        debugLog(3, () => `检查参数是否正确添加:`);
        for (let i = 0; i < funcInfo.params.length; i++) {
            const paramName = funcInfo.params[i].name;
            let found = false;
            for (let j = 0; j < LOCAL_VARS.length; j++) {
                if (LOCAL_VARS[j].name === paramName) {
                    debugLog(3, () => `参数 ${paramName} 的索引: ${j}`);
                    found = true;
                    break;
                }
            }
            if (!found) {
                debugLog(3, () => `参数 ${paramName} 未找到`);
            }
        }

        // 进一步调试: 检查每个参数在LOCAL_VARS中的详细信息
        debugLog(3, () => `详细检查参数:`);
        for (let i = 0; i < funcInfo.params.length; i++) {
            const paramName = funcInfo.params[i].name;
            const paramType = funcInfo.params[i].type;
            let paramFound = false;
            for (let j = 0; j < LOCAL_VARS.length; j++) {
                if (LOCAL_VARS[j].name === paramName) {
                    debugLog(3, () => `参数 ${paramName} 详情: 索引=${j}, 值=${LOCAL_VARS[j].value}, 类型=${LOCAL_VARS[j].type}, 作用域=${LOCAL_VARS[j].startLine + 1}-${LOCAL_VARS[j].endLine === -1 ? "末行" : LOCAL_VARS[j].endLine + 1}`);
                    // 验证类型是否匹配
                    if (LOCAL_VARS[j].type !== paramType) {
                        debugLog(3, () => `警告: 参数 ${paramName} 类型不匹配, 期望=${paramType}, 实际=${LOCAL_VARS[j].type}`);
                    }
                    paramFound = true;
                    break;
                }
            }
            if (!paramFound) {
                debugLog(3, () => `参数 ${paramName} 未找到`);
            }
        }

        currentLinePointer = funcInfo.startLine; // 主循环会自动加一执行函数体内部的代码
        debugLog(2, () => `函数体开始行: ${functionBodyStartLine + 1}`);
        // 添加作用域调试信息
        debugLog(2, () => `函数 ${funcName} 变量作用域详情:`);
        debugLog(2, () => `  返回值变量: ${returnVarName}, 作用域: ${functionBodyStartLine + 1}-${funcInfo.endLine === -1 ? "末行" : funcInfo.endLine + 1}`);
        debugLog(2, () => `  参数作用域: ${functionBodyStartLine + 1}-${funcInfo.endLine === -1 ? "末行" : funcInfo.endLine + 1}`);
        CONTROL_FLOW_STACK.push({
            type: 'function',
            funcName: funcInfo.name,
            startLine: funcInfo.startLine,
            endLine: funcInfo.endLine,
            callFrom: oldLinePointer,
            returnVarName: resultVar,
            frameId: frameId
        });
        debugLog(2, () => `当前流程控制栈:`, CONTROL_FLOW_STACK);
    }

    // 执行数组声明
    static executeArrayDeclaration(params: string, isGlobal: boolean, isConst: boolean): void {
        debugLog(3, () => `执行${isGlobal ? '全局' : '局部'}${isConst ? '常量' : '变量'}数组声明: ${params}`);
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
            debugLog(2, () => `数组${arrayName}使用arrfill初始化`);
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
            debugLog(2, () => `数组填充完毕`);
        } else if (initValue.startsWith('[') && initValue.endsWith(']')) {
            debugLog(2, () => `数组${arrayName}使用手动初始化`);
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
        }
    }

    // 辅助方法: 分割数组元素, 正确处理字符串中的逗号
    static splitArrayElements(elementsStr: string): string[] {
        const elements: string[] = [];
        let currentElement = '';
        let inString = false;
        let stringDelimiter = '';

        for (let i = 0; i < elementsStr.length; i++) {
            const char = elementsStr[i];

            if (!inString && (char === '"' || char === "'")) {
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
        debugLog(2, () => `执行返回语句: ${params}`);
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
                const funcName = ScopeManager.getCurrentFunction(currentLinePointer);
                if (funcName === null) {
                    reportError(ExceptionType.SYNTAX_ERROR, t('return_outside_function'));
                    return;
                } else if (funcName !== block.funcName) {
                    reportError(ExceptionType.UNKNOWN_ERROR, t('return_stack_top_mismatch'));
                    return;
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
                const returnVarInfo = ScopeManager.getVariableInfo(returnValueStr, currentLinePointer);
                if (returnVarInfo === null) {
                    // 变量不存在 → 视为无返回值
                    if (!ScopeManager.isVoidFunction(funcInfo)) {
                        reportError(ExceptionType.TYPE_ERROR, t('func_return_value_missing', {name: block.funcName, type: funcInfo.returnType}));
                        return;
                    }
                    returnValue = undefined;
                    debugLog(2, () => (`无返回值, 设置为undefined`));
                    return;
                }
                // 数组返回: 捕获整个数组结构引用 (含 arrayElements), 标量返回捕获值
                if (returnVarInfo.type === DataType.ARRAY) {
                    returnValue = returnVarInfo;
                } else {
                    returnValue = returnVarInfo.value;
                }
                debugLog(2, () => `从变量获取返回值: ${returnValue}`);

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
                debugLog(2, () => `存储返回值到RETURN_VALUES[${block.funcName}][${returnValueStr}]: ${returnValue}`);
                debugLog(2, () => `当前返回值池内容: `, RETURN_VALUES);

                // 弹出函数帧（必须先弹出，防止后续遍历到残留的旧函数帧）
                CONTROL_FLOW_STACK.pop();
                // 仅清理当前调用帧的局部变量 (按帧ID隔离, 递归时不影响外层帧)
                LOCAL_VARS = LOCAL_VARS.filter(v => v.frameId !== block.frameId);
                debugLog(2, () => `函数调用清理后的局部变量表`, LOCAL_VARS);
                // 再处理返回值赋值（此时局部变量已清理，返回变量安全添加）
                handleReturnValueAssignment(block.funcName, funcInfo, block.returnVarName, currentLinePointer);
                debugLog(2, () => `清理后控制流栈:`, CONTROL_FLOW_STACK);
                currentLinePointer = block.callFrom;
                break; // 停止遍历, 防止处理残留函数帧
            } else {
                CONTROL_FLOW_STACK.pop();
                debugLog(2, () => `清理后的控制流: `, CONTROL_FLOW_STACK);
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

        debugLog(2, () => `计算条件表达式: ${conditionExpr} (行 ${currentLinePointer + 1})`);
        try {
            const condition = Interpreter.evaluateExpression(conditionExpr);
            debugLog(2, () => `条件表达式结果: ${condition} (类型: ${typeof condition})`);

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
                debugLog(1, () => `if 条件为假在第 ${currentLinePointer + 1} 行`);
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
                            debugLog(2, () => `当前控制流: `, CONTROL_FLOW_STACK);
                            if (line === 'endif') {
                                CONTROL_FLOW_STACK.pop();
                            }
                            debugLog(2, () => `更新后控制流: `, CONTROL_FLOW_STACK);
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
            debugLog(1, () => `错误详情: ${error}`);
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
            const brokenexists = CONTROL_FLOW_BROKEN_BLOCK_STACK.some(item =>
                item.type === 'while' && item.start === currentLinePointer
            );
            debugLog(2, () => `当前循环结束后控制跳过块栈: `, CONTROL_FLOW_BROKEN_BLOCK_STACK);

            const condition = Interpreter.evaluateExpression(conditionExpr) && !brokenexists;

            // 检查条件表达式的返回值是否为布尔类型
            if (typeof condition !== 'boolean') {
                reportError(ExceptionType.TYPE_ERROR, t('cond_must_be_bool', {actualType: typeof condition}));
                return;
            }

            debugLog(2, () => `当前控制流: `, CONTROL_FLOW_STACK);
            // 先将while循环信息压栈, 防止首次循环条件不满足
            // 检查CONTROL_FLOW_STACK中是否已存在相同while循环信息
            const exists = CONTROL_FLOW_STACK.some(item =>
                item.type === 'while' && item.start === currentLinePointer
            );
            if (!exists) {
                CONTROL_FLOW_STACK.push({
                    type: 'while',
                    start: currentLinePointer
                });
            }

            if (!condition) {
                debugLog(2, () => `while循环条件不满足, 跳过循环, 当前行 ${currentLinePointer + 1}, break 标记为 ${brokenexists}`)

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
                                debugLog(2, () => `当前循环结束后控制跳过块栈: `, CONTROL_FLOW_BROKEN_BLOCK_STACK);
                            }
                            break;
                        }
                    }
                    i++;
                }
            } else {
                // 记录循环开始位置, 用于continue
                // 检查CONTROL_FLOW_STACK中是否已存在相同while循环信息
                const exists = CONTROL_FLOW_STACK.some(item =>
                    item.type === 'while' && item.start === currentLinePointer
                );
                if (!exists) {
                    CONTROL_FLOW_STACK.push({
                        type: 'while',
                        start: currentLinePointer
                    });
                }
            }
        } catch (error) {
            // 自定义异常 (如ReferenceError) 重新抛出, 供try-catch捕获
            if (error && typeof error === 'object' && (error as Exception).type !== undefined) {
                throw error;
            }
            reportError(ExceptionType.SYNTAX_ERROR, t('cond_invalid', {expr: conditionExpr}));
        }
        debugLog(2, () => `当前循环结束后控制流: `, CONTROL_FLOW_STACK);
    }

    // 执行endwhl语句
    static executeEndWhile(): void {
        debugLog(2, () => `当前控制流: `, CONTROL_FLOW_STACK);
        // 返回到while条件
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
        debugLog(2, () => `for循环参数: ${params}`);
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
                    debugLog(2, () => `检测到内嵌for循环, 嵌套级别: ${nestedLevel}`);
                } else if (programLines[i].trim() === 'endfor') {
                    if (nestedLevel === 1) {
                        debugLog(2, () => `检测到匹配的endfor语句, 嵌套级别: ${nestedLevel}`);
                        endForLine = i;
                        break;
                    }
                    nestedLevel--;
                    debugLog(2, () => `检测到endfor语句, 嵌套级别: ${nestedLevel}`);
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
                debugLog(2, () => `循环变量已存在 (for重入), 跳过初始化`);
            } else {
                // 创建循环变量 (若与全局变量同名则自动遮蔽, 局部查找优先)
                ScopeManager.addVariable(varName, initialValue, type, currentLinePointer, endForLine, false);
            }

            const brokenexists = CONTROL_FLOW_BROKEN_BLOCK_STACK.some(item =>
                item.type === 'for' &&
                item.start === currentLinePointer &&
                item.updateExpr === updateExpr &&
                item.varName === varName
            );
            debugLog(2, () => `当前循环结束后控制跳过块栈: `, CONTROL_FLOW_BROKEN_BLOCK_STACK);

            // 评估条件
            const result = Interpreter.evaluateExpression(condition) && !brokenexists;

            // 检查条件表达式的返回值是否为布尔类型
            if (typeof result !== 'boolean') {
                reportError(ExceptionType.TYPE_ERROR, t('cond_must_be_bool', {actualType: typeof result}));
                return;
            }

            debugLog(2, () => `当前控制流: `, CONTROL_FLOW_STACK);
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
                debugLog(2, () => `for循环条件不满足, 跳过循环, 当前行 ${currentLinePointer + 1}, break 标记为 ${brokenexists}`);
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
                                debugLog(2, () => `当前循环结束后控制跳过块栈: `, CONTROL_FLOW_BROKEN_BLOCK_STACK);
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
        debugLog(2, () => `当前循环结束后控制流: `, CONTROL_FLOW_STACK);
    }

    // 执行endfor语句
    static executeEndFor(): void {
        debugLog(2, () => `当前控制流: `, CONTROL_FLOW_STACK);
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
                debugLog(2, () => `跳转目标: ${targetEndTag}`);
                debugLog(2, () => `当前循环结束后控制跳过块栈: `, CONTROL_FLOW_BROKEN_BLOCK_STACK);

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
                debugLog(2, () => `清理后的控制流: `, CONTROL_FLOW_STACK);
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
                debugLog(2, () => `跳转目标: ${targetEndTag}`);

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
                debugLog(2, () => `清理后的控制流: `, CONTROL_FLOW_STACK);
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
            }
            debugLog(1, () => `捕获异常: ${exception.message} (行 ${exception.lineNumber + 1})`);

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
        debugLog(1, () => `执行assert语句: ${params}`);
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
                debugLog(1, () => `断言条件为真: ${conditionExpr}`);
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
        debugLog(1, () => `执行switch语句: ${params}`);
        try {
            const condition = Interpreter.evaluateExpression(params);
            debugLog(1, () => `switch语句的条件表达式值: ${condition}`);

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
        debugLog(1, () => `处理 case 语句`);
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
            debugLog(2, () => `跳过已匹配的switch语句: ${params}, 嵌套级别: ${nestedLevel}`);
            while (i < programLines.length && nestedLevel > 0) {
                const line = programLines[i].trim();
                if (line.toLowerCase().startsWith('switch ')) {
                    nestedLevel++;
                    debugLog(2, () => `嵌套switch语句: ${line}, 嵌套级别: ${nestedLevel}`);
                } else if (line === 'endswc') {
                    nestedLevel--;
                    debugLog(2, () => `退出嵌套switch语句: ${line}, 嵌套级别: ${nestedLevel}`);
                    if (nestedLevel === 0) {
                        currentLinePointer = i - 1; // 减1是因为主循环会加1并执行 endSwitch 清理流程栈
                        debugLog(2, () => `嵌套层级为0, 当前行指向: ${currentLinePointer}`);
                        break;
                    }
                } else if (line === 'break') {
                    debugLog(2, () => `处理break语句: ${line}, 嵌套级别: ${nestedLevel}`);
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
            debugLog(2, () => `case语句的条件表达式值: ${caseValue}`);

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
        debugLog(1, () => `参数: ${params}`);
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
            debugLog(2, () => `不满足jump条件`);
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
        debugLog(1, () => `执行操作指令: ${command}`);

        // 使用表达式解析器来处理赋值操作
        try {
            const result = ExpressionEvaluator.evaluate(command.trim(), currentLinePointer);
            debugLog(1, () => `获得解析结果`);
            // 检查是否是数组元素赋值
            if (result && typeof result === 'object' && result.type === 'array_assignment') {
                debugLog(1, () => `侦测到数组赋值 目标:${result.target.arrayName} 索引:${result.target.index}`);
                const { target, value } = result;
                // 处理 global. 前缀 (与整体赋值分支一致)
                let targetName: string = target.arrayName;
                let isGlobal: boolean = false;
                if (targetName.startsWith('global.')) {
                    targetName = targetName.slice('global.'.length);
                    isGlobal = true;
                }
                const arrayVar = ScopeManager.getVariable(targetName, currentLinePointer, true, isGlobal);
                // 检查变量是否存在且是数组类型
                if (!arrayVar) {
                    throw { type: ExceptionType.REFERENCE_ERROR, message: t('array_undefined', {name: targetName}), lineNumber: currentLinePointer } as Exception;
                }
                debugLog(1, () => `获得的数组名称: ${arrayVar.name}`);

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
                if (target.index >= arrayVar.arrayLength) {
                    throw { type: ExceptionType.RANGE_ERROR, message: t('arr_index_out_of_range', {index: target.index, length: arrayVar.arrayLength}), lineNumber: currentLinePointer } as Exception;
                }

                // 更新数组元素
                // 检查元素类型是否匹配
                const elementType = arrayVar.arrayElementType;
                const validation = ScopeManager.validateType(value, elementType);
                if (!validation.isValid) {
                    throw { type: ExceptionType.TYPE_ERROR, message: t('array_element_type_mismatch', {expected: elementType, actual: typeof value}), lineNumber: currentLinePointer } as Exception;
                }

                // 更新数组元素
                debugLog(2, () => `更新数组元素: ${arrayVar.arrayElements![target.index].value} 为 ${validation.convertedValue}`);
                arrayVar.arrayElements![target.index].value = validation.convertedValue;
                // ScopeManager.setVariable(target.arrayName, arrayVar, currentLinePointer);
                return;
            } else if (result && typeof result === 'object' && result.type === 'assignment') {
                debugLog(1, () => `处理普通变量赋值 (type: assignment) : ${command}`);
                // 处理普通变量赋值
                const { target, value } = result;
                let newTarget: string = target;
                let isGlobal: boolean = false;
                if (newTarget.startsWith('global.')) {
                    newTarget = newTarget.slice('global.'.length);
                    isGlobal = true;
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
                        debugLog(1, () => `数组整体赋值(引用): ${newTarget} -> ${rhsVar.name}`);
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
                debugLog(1, () => `处理普通变量赋值 (type: =) : ${command}`);
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
            debugLog(1, () => `计算表达式时出错 '${expr}' 在第 ${currentLinePointer + 1} 行: ${e}`);
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
        debugLog(1, () => `执行清除指令: ${params}`);
        // 判断是否包含except
        if (params.includes('except')) {
            const match = params.match(/^(.*?)\s+except\s+(.*)$/);
            if (!match) {
                reportError(ExceptionType.SYNTAX_ERROR, t('except_format_error'));
                return;
            }
            debugLog(1, () => `匹配到except关键字`);
            const beforeExcept = match[1].trim().split(/\s+/);
            const afterExcept = match[2].trim().split(/\s+/);
            if (beforeExcept.length !== 1 || beforeExcept[0] !== 'all') {
                reportError(ExceptionType.SYNTAX_ERROR, t('except_requires_all'));
                return;
            } else if (beforeExcept.length === 1 && beforeExcept[0] === 'all') {
                debugLog(1, () => `要排除的变量: ${afterExcept}`);
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
                debugLog(1, () => `已将排除的变量恢复, 当前局部变量有: ${LOCAL_VARS.map(varInfo => varInfo.name)}`);
                return;
            }
        }
        // 判断是否全部清除
        else if (params === 'all') {
            ScopeManager.cleanupLocalVariable(true);
            debugLog(1, () => `已清除所有局部变量, 若要清除全局变量请指定清除`);
            return;
        }
        // 清除全局变量
        else if (params.startsWith('global.')) {
            let globalVarName: string = params.slice('global.'.length);
            if (ScopeManager.hasVariable(globalVarName, currentLinePointer, true)) {
                ScopeManager.cleanupGlobalVariable(globalVarName);
            }
            else {
                debugLog(1, () => `全局变量 ${globalVarName} 不存在`);
            }
            debugLog(1, () => `已清除全局变量 ${globalVarName}`);
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
                    debugLog(2, () => `要被清除的第 ${i + 1} 个变量 ${cleanedVars[i]}`)
                    let varInfo = ScopeManager.getVariableInfo(cleanedVars[i], currentLinePointer);
                    if (varInfo && varInfo.startLine >= funcStartLine && varInfo.endLine <= funcEndLine) {
                        ScopeManager.cleanupLocalVariable(false, false, varInfo.name, varInfo.startLine, varInfo.endLine, varInfo.frameId);
                        debugLog(2, () => `已清除变量 ${varInfo.name}, 作用域: ${varInfo.startLine + 1}-${varInfo.endLine === -1 ? "末行" : varInfo.endLine + 1}`);
                    }
                }
                debugLog(1, () => `变量清除完成`);
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
                // 仅清理当前调用帧的局部变量 (按帧ID隔离, 递归时不影响外层帧)
                LOCAL_VARS = LOCAL_VARS.filter(v => v.frameId !== block.frameId);
                CONTROL_FLOW_STACK.pop();
                debugLog(2, () => `函数 ${funcInfo.name} 结束标记后的局部变量表:`, LOCAL_VARS);
                if (!ScopeManager.isVoidFunction(funcInfo)) {
                    reportError(ExceptionType.TYPE_ERROR, t('func_reached_end_no_return', {name: funcInfo.name, type: funcInfo.returnType}));
                    currentLinePointer = block.callFrom;
                    return;
                } else {
                    debugLog(1, () => `函数 ${funcInfo.name} 是无返回值函数, 返回调用位置`)
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
            // 变量/数组访问/函数调用等节点在求值时实时查作用域, 故树可安全跨执行共享。
            let tree = ExpressionEvaluator.treeCache.get(expression);
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

                if (ExpressionEvaluator.treeCache.size >= ExpressionEvaluator.MAX_TREE_CACHE) {
                    ExpressionEvaluator.treeCache.clear();
                }
                ExpressionEvaluator.treeCache.set(expression, tree);
            }

            return this.evalTree(tree);
        } catch (error) {
            // 统一将表达式求值中的原生 JS Error 转换为 NS 异常 (可被 try-catch 捕获)
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
            } else if (code === 34 || code === 39) { // " '
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
        debugLog(2, () => `解析表达式中: ${this.tokens}`);
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
                    return { kind: 'arrayAssignment', target: target, valueExpr: value };
                }
            }

            // 不是数组赋值, 恢复索引并继续正常解析
            debugLog(2, () => `不是数组赋值, 恢复索引并继续正常解析: ${this.tokens}`);
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
            return { kind: 'assignment', target: target, valueExpr: value };
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
        debugLog(2, () => `解析逻辑或运算中: ${this.tokens}`);
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
        debugLog(2, () => `解析逻辑与运算中: ${this.tokens}`);
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
        debugLog(2, () => `解析相等性运算中: ${this.tokens}`);
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
        debugLog(2, () => `解析关系运算中: ${this.tokens}`);
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
        debugLog(2, () => `解析加法和减法运算中: ${this.tokens}`);
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
        debugLog(2, () => `解析乘法、除法和取模运算中: ${this.tokens}`);
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
        debugLog(2, () => `解析幂运算中: ${this.tokens}`);
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
        debugLog(2, () => `解析一元运算符中: ${this.tokens}`);
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
        debugLog(2, () => `解析基本元素中: ${this.tokens}`);
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

        // 检查是否是字符串
        if ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"))) {
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
            debugLog(2, () => `检查 ${token} 是否为变量或函数调用`)
            this.currentTokenIndex++;
            // 全局变量标志
            let isGlobal: boolean = false;
            // 检查是否是函数调用
            if (this.currentTokenIndex < this.tokens.length && this.tokens[this.currentTokenIndex] === '(') {
                debugLog(2, () => `检测到函数调用: ${token}`);
                return this.buildFunctionCall(token);
            }

            if (token.startsWith('global.')) {
                debugLog(2, () => `检测到全局访问前缀`);
                isGlobal = true;
            }

            // 检查是否是数组元素访问
            if (this.currentTokenIndex < this.tokens.length && this.tokens[this.currentTokenIndex] === '[') {
                debugLog(2, () => `检测到数组元素访问: ${token}`);
                return this.buildArrayAccess(token, isGlobal);
            }

            // 变量节点: 类型/存在性/值检查推迟到求值期实时查作用域 (缓存树不含运行时值)
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

        return { kind: 'arrayAccess', name: arrayName, isGlobal: isGlobal, index: index };
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
        debugLog(2, () => `解析函数调用: ${funcName}`);
        // 跳过左括号
        this.currentTokenIndex++;

        const args: ExprNode[] = [];

        // 解析参数 (建树)
        while (this.currentTokenIndex < this.tokens.length && this.tokens[this.currentTokenIndex] !== ')') {
            debugLog(2, () => `解析参数`);
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
            case 'len':
                if (args.length !== 1) throw { type: ExceptionType.TYPE_ERROR, message: t('func_needs_1_arg', {func: 'len'}), lineNumber: this.currentLine } as Exception;
                debugLog(2, () => `执行 len 传入的 arg: ${args[0]}`);
                if (typeof args[0] === 'string') {
                    debugLog(2, () => `参数为 string 类型`);
                    return args[0].length;
                }
                // 检查是否是数组变量
                // 注意: 这里需要特殊处理, 因为数组变量在传递时可能已经被解构
                // 我们需要检查参数是否是数组变量对象
                debugLog(2, () => `参数为数组类型 ${args[0]}`);
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
                debugLog(1, () => `copy 深拷贝数组: ${copySrcArr.name} (长度 ${copiedArr.arrayLength})`);
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

    // 表达式树缓存: 树为纯结构 (不含运行时值), 首次执行时解析建树, 之后每次执行直接遍历求值。
    // 变量/数组/函数调用等节点在求值时实时查作用域, 故缓存树跨执行共享是安全的 (与 token 缓存同批安全原则)。
    private static treeCache: Map<string, ExprNode> = new Map();
    private static readonly MAX_TREE_CACHE = 1000;

    // ===== 求值 (运行期): 遍历表达式树求值, 变量/数组/函数调用实时查作用域 =====
    // 语义与原有"边解析边求值"严格一致: 求值顺序 (左→右→运算, 参数按序, 数组索引先于右值),
    // 类型检查/报错 (引用/类型/越界/除零等) 完全复刻, 唯一差异是解析不再重复执行。
    private static evalTree(node: ExprNode): any {
        switch (node.kind) {
            case 'literal':
                return node.value;
            case 'variable': {
                const name = node.name as string;
                const isGlobal = !!node.isGlobal;
                // 复刻 parsePrimary 变量分支: 数组整体返回数组对象, 未定义抛引用错误, 值为 undefined 抛类型错误
                const varType = ScopeManager.getVariableType(name, this.currentLine, isGlobal);
                if (varType === 'array') {
                    const array = ScopeManager.getVariable(name, this.currentLine, true, isGlobal);
                    debugLog(2, () => `返回${isGlobal ? '全局' : ''}数组: ${array.name} 在第${this.currentLine + 1}行`);
                    return array;
                }
                const varInfo = ScopeManager.getVariableInfo(name, this.currentLine, isGlobal);
                if (varInfo === null) {
                    throw {
                        type: ExceptionType.REFERENCE_ERROR,
                        message: isGlobal ? t('var_undefined_expr_global', { name: name }) : t('var_undefined_expr_local', { name: name }),
                        lineNumber: this.currentLine
                    } as Exception;
                }
                if (varInfo.value === undefined) {
                    throw {
                        type: ExceptionType.TYPE_ERROR,
                        message: t('var_value_undefined', { name: name }),
                        lineNumber: this.currentLine
                    } as Exception;
                }
                debugLog(2, () => `直接返回${isGlobal ? '全局' : ''}变量值: ${name} = ${varInfo.value} 在第${this.currentLine + 1}行`);
                return varInfo.value;
            }
            case 'binary': {
                const left = this.evalTree(node.left as ExprNode);
                const right = this.evalTree(node.right as ExprNode);
                return this.evaluateOperation(node.op as string, left, right);
            }
            case 'unary': {
                const operand = this.evalTree(node.operand as ExprNode);
                return this.evaluateUnaryOperation(node.op as string, operand);
            }
            case 'call': {
                // 参数从左到右按序求值, 与原有边解析边求值的参数求值顺序一致
                const args = (node.args as ExprNode[]).map(a => this.evalTree(a));
                debugLog(2, () => `执行函数调用: name: ${node.funcName} args:${args}`)
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
                const arrayVar = ScopeManager.getVariable(newArrayName, this.currentLine, true, !!node.isGlobal);
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
                // 返回结构与原有边解析边求值一致, executeOperation 原样消费
                return { type: 'assignment', target: node.target as string, value: value };
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
                return { type: 'array_assignment', target: { arrayName: target.arrayName, index: index }, value: value };
            }
            default:
                throw {
                    type: ExceptionType.SYNTAX_ERROR,
                    message: t('unknown_operator', {op: node.kind, pos: this.currentTokenIndex}),
                    lineNumber: this.currentLine
                } as Exception;
        }
    }

    // 计算二元运算
    private static evaluateOperation(operator: string, left: any, right: any): any {
        debugLog(1, () => `计算操作: ${operator}, 左操作数: ${JSON.stringify(left)} (左类型: ${typeof left}), 右操作数: ${JSON.stringify(right)} (右类型: ${typeof right})`);

        // 提取操作数的值和类型
        const leftValue = left;
        const leftType = typeof left;
        const rightValue = right;
        const rightType = typeof right;

        // 检查类型一致性
        if (['-', '*', '/', '%', '**', '<', '>', '<=', '>='].indexOf(operator) !== -1) {
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
                debugLog(2, () => `${operator} operated`);
                return leftValue + rightValue;
            case '-':
                debugLog(2, () => `${operator} operated`);
                return leftValue - rightValue;
            case '*':
                debugLog(2, () => `${operator} operated`);
                return leftValue * rightValue;
            case '/':
                if (rightValue === 0) throw { type: ExceptionType.RANGE_ERROR, message: t('division_by_zero'), lineNumber: this.currentLine } as Exception;
                debugLog(2, () => `${operator} operated`);
                return leftValue / rightValue;
            case '%':
                debugLog(2, () => `${operator} operated`);
                return leftValue % rightValue;
            case '**':
                debugLog(2, () => `${operator} operated`);
                return Math.pow(leftValue, rightValue);
            case '==':
                debugLog(2, () => `${operator} operated`);
                return Boolean(leftValue == rightValue);
            case '!=':
                debugLog(2, () => `${operator} operated`);
                return Boolean(leftValue != rightValue);
            case '<':
                debugLog(2, () => `${operator} operated`);
                return Boolean(leftValue < rightValue);
            case '>':
                debugLog(2, () => `${operator} operated`);
                return Boolean(leftValue > rightValue);
            case '<=':
                debugLog(2, () => `${operator} operated`);
                return Boolean(leftValue <= rightValue);
            case '>=':
                debugLog(2, () => `${operator} operated`);
                return Boolean(leftValue >= rightValue);
            case '&&':
                debugLog(2, () => `${operator} operated`);
                return Boolean(leftValue && rightValue);
            case '||':
                debugLog(2, () => `${operator} operated`);
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

        // 调试等级设置
        if (debugValue !== undefined) {
            if (Number.isInteger(Number(debugValue)) && Number(debugValue) >= 0) {
                DEBUG_LEVEL = Number(debugValue);
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
                // 获取函数定义中的返回值变量名
                const funcDefLine = programLines[funcInfo.startLine].trim();
                const funcMatch = funcDefLine.match(/^:([a-zA-Z0-9_]+)\s*\((.*)\)\s*->\s*(:?[a-zA-Z0-9_]+)(?:\s*:([a-zA-Z0-9_]+))?$/);
                let returnVarName: string | undefined;
                if (funcMatch) {
                    const returnVarNameOrVoid = funcMatch[3];
                    if (returnVarNameOrVoid !== ':void') {
                        returnVarName = returnVarNameOrVoid.startsWith(':') ? returnVarNameOrVoid.substring(1) : returnVarNameOrVoid;
                    }
                }
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
                    debugLog(2, () => `数组返回值绑定到新变量 ${resultVar}`);
                } else {
                    const existing = ScopeManager.getVariableInfo(resultVar, oldLinePointer);
                    if (existing && existing.type === DataType.ARRAY) {
                        existing.arrayLength = arrStruct.arrayLength;
                        existing.arrayElementType = arrStruct.arrayElementType;
                        existing.arrayElements = arrStruct.arrayElements;
                        existing.isReadonlyArray = arrStruct.isReadonlyArray;
                        debugLog(2, () => `数组返回值绑定到已有数组变量 ${resultVar}`);
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
            debugLog(2, () => `结果变量 ${resultVar} 未声明, 添加到局部作用域`);
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
            ScopeManager.addVariable(resultVar, initValue, funcInfo.returnType, oldLinePointer, -1, false);
        }

        // 从返回值池中获取返回值
        if (RETURN_VALUES.hasOwnProperty(funcName)) {
            const funcReturnValues = RETURN_VALUES[funcName];

            // 获取函数定义中的返回值变量名
            const funcDefLine = programLines[funcInfo.startLine].trim();
            const funcMatch = funcDefLine.match(/^:([a-zA-Z0-9_]+)\s*\((.*)\)\s*->\s*(:?[a-zA-Z0-9_]+)(?:\s*:([a-zA-Z0-9_]+))?$/);
            let returnVarName: string | undefined;
            if (funcMatch) {
                const returnVarNameOrVoid = funcMatch[3];
                if (returnVarNameOrVoid !== ':void') {
                    // 处理带冒号前缀的返回值变量名
                    returnVarName = returnVarNameOrVoid.startsWith(':') ? returnVarNameOrVoid.substring(1) : returnVarNameOrVoid;
                }
            }

            // 检查是否有返回值
            if (returnVarName && funcReturnValues.hasOwnProperty(returnVarName)) {
                const returnValue = funcReturnValues[returnVarName];

                debugLog(2, () => `获取到函数返回值: ${funcName}[${returnVarName}] = ${returnValue}`);

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

                debugLog(2, () => `函数无返回值, 设置默认值: ${resultVar} = ${defaultValue}`);
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

            debugLog(2, () => `函数无返回值, 设置默认值: ${resultVar} = ${defaultValue}`);
            ScopeManager.setVariable(resultVar, defaultValue, oldLinePointer);
        }
    } else if (resultVar !== undefined) {
        // 函数没有返回类型但有结果变量, 设置为void
        // 确保结果变量在当前作用域中已声明
        if (!ScopeManager.hasVariable(resultVar, oldLinePointer)) {
            debugLog(2, () => `结果变量 ${resultVar} 未声明, 添加到局部作用域`);
            // 添加变量到局部作用域, 类型为UNDEFINED, 初始值为undefined
            // 变量作用域从当前行开始, 到程序结束
            ScopeManager.addVariable(resultVar, undefined, DataType.UNDEFINED, oldLinePointer, -1, false);
        }
        ScopeManager.setVariable(resultVar, undefined, oldLinePointer);
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
