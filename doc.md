# 自制脚本语言用户手册

## 概述
本语言是一种基于行运行的脚本语言，要求显式声明变量作用域和数据类型，支持常见的流程控制和函数定义。

## 变量声明

### 作用域
- `global`: 全局作用域，整个文档可见
- `local`: 局部作用域，仅在其声明位置到对应结束标签之间可见

### 数据类型
| 类型       | 说明                                                                 |
|------------|----------------------------------------------------------------------|
| `number`   | 自动判断数字类型                                                     |
| `int`      | 整数类型                                                             |
| `float`    | 浮点数类型                                                           |
| `string`   | 字符或字符串类型                                                     |
| `bool`     | 逻辑值，只能赋值为 `true` 或 `false`                                  |
| `array`    | 数组类型，必须显式声明长度                                           |

### 声明格式
```vbnet
global varname:type = value     // 全局变量
local varname:type = value      // 局部变量
global const varname:type = value  // 全局常量
local const varname:type = value   // 局部常量
```

### 注意事项
1. 未赋初值的变量值为 `undefined`，使用值为 `undefined` 的变量会抛出错误
2. 全局变量存储空间内不允许同名变量
3. 局部变量存储空间内允许同名变量（通过作用域行号区分）
4. 局部变量允许与全局变量同名，块级作用域内需通过`global.`关键字访问全局变量
5. 在表达式中出现 `null` 或 `undefined` 立即抛出错误；引用未定义的变量抛出 `ReferenceError`
6. 函数内部和流程块内部不可声明全局变量

## 数组类型

### 数组声明与初始化
数组必须显式声明长度，支持两种初始化方式：

```vbnet
// 手动初始化
global array arrName[arrLength]:type = [value1, value2, ..., valueN]

// 统一填充初始化
global array arrName[arrLength]:type = arrfill
```

#### 规则说明：
1. `arrLength` 必须为 `int` 类型，可以是数字字面量、全局常量或表达式（如 `ROWS * COLS`）
2. 手动初始化时，初始化值数量必须等于数组长度，否则报错
3. 手动初始化时，每个值的类型必须与数组声明类型一致，否则报错
4. 禁止声明 `void` 或 `undefined` 类型的数组
5. 禁止重复声明同名数组（无论大小是否相同）

#### `arrfill` 关键字行为：
| 数组类型   | 默认填充值       | 说明                                                                 |
|------------|------------------|----------------------------------------------------------------------|
| `number`   | 0.0              | 抛出警告：建议明确声明为 `int` 或 `float` 类型                       |
| `int`      | 0                |                                                                      |
| `float`    | 0.0              |                                                                      |
| `string`   | ""（空字符串）   | 必须使用英文双引号括起                                               |
| `bool`     | false            |                                                                      |

`arrfill` 仅用于数组**声明时**的统一填充初始化（`global array buffer[32]:int = arrfill`），不能用于数组整体赋值等其他场景（会按未定义变量报错）。

#### 示例：
```vbnet
global array days[7]:string = ["Sun", "Mon", "Tue", "Wed", "Thur", "Fri", "Sat"]

global array months[12]:int = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

global array buffer[32]:int = arrfill

global const arrLength0:int = 8
local array arr0[arrLength0]:int = arrfill
```

### 数组读写操作
```vbnet
// 读取数组元素（直接作为表达式使用，可用于 print、赋值、运算等）
print arrName[index]
varName = arrName[index]

// 写入数组元素
arrName[index] = val
```

### 数组整体赋值
```vbnet
arrA = arrB
```
将 `arrB` 的引用整体赋值给 `arrA`（引用赋值），二者共享同一份数组数据，修改任一数组的元素会同步反映到另一个；`arrA` 的长度与元素类型随之变为与 `arrB` 一致。常量数组、只读引用数组（只读形参/字面量实参）禁止作为整体赋值目标。

若需要副本赋值（深拷贝，互不影响）：
```vbnet
arrA = copy(arrB)
```
`arrA` 获得 `arrB` 的独立副本，此后修改 `arrA` 不影响 `arrB`。

只读保护会随整体赋值与返回值传播：从只读引用视图（只读形参/字面量实参）整体赋值得到的引用、以及函数返回只读视图得到的引用，均保持只读，防止透过新名字写穿原数组。

#### 规则说明：
1. 索引 `index` 必须为非负整数，从 0 开始
2. 读取操作：被赋值的变量类型必须与数组元素类型相同
3. 写入操作：赋值的数据类型必须与数组元素类型相同
4. 可以使用同类型已初始化变量赋值，使用未初始化变量会报错
5. 越界访问直接报错

### 数组长度属性
```vbnet
// 获取数组长度
len(arrName)
```

#### 规则说明：
1. `len()` 方法支持数组和字符串类型
2. 返回值为 `int` 类型
3. 可以在表达式中直接使用，或赋值给整型变量
4. 解释器在运行时直接替换为长度常量

### 多维数组实现
本语言仅原生支持一维数组，更高维数组需通过一维数组组合实现：
```vbnet
global const ROWS:int = 3
global const COLS:int = 4
global array matrix[ROWS * COLS]:int = arrfill

// 访问第2行第3列元素（索引从0开始）
matrix[1 * COLS + 2] = 10
```

## 流程控制

### 条件语句
```vbnet
// 基础if
if (condition)
    operate var, var, ...
endif

// if-else
if (condition)
    operate var, var, ...
else
    operate var, var, ...
endif

// else if实现（if-else的嵌套）
if (condition)
    operate var, var, ...
else
    if (condition)
        operate var, var, ...
    else
        operate var, var, ...
    endif
endif
```

### 循环语句
```vbnet
// for循环(C风格)
for (local i:int = 0; i < 10; i = i + 1)
    operate var, var, ...
endfor

// while循环
while (condition)
    operate var, var, ...
endwhl
```

#### for循环规则：
1. 循环变量（如 `i`）使用 `local` 声明，作用域从声明行到 `endfor`
2. 循环变量作用域内禁止声明同名变量
3. 循环变量在作用域内为只读状态，禁止修改其值（for 循环的更新表达式除外）
4. 数组遍历推荐模式：
```vbnet
global array data[5]:int = [10, 20, 30, 40, 50]
for (local i:int = 0; i < len(data); i = i + 1)
    print data[i]
endfor
```

### switch分支
```vbnet
switch (condition)  // 仅允许int或string类型
case val0
    operate var, var, ...
    break
case val1
    operate var, var, ...
    break
default
    operate var, var, ...
endswc
```

### 控制关键字
- `break`: 跳出当前循环或switch
- `continue`: 跳过当前循环迭代
- `return`: 从函数中返回

## 调试控制

### Debug级别控制
```vbnet
// 设置调试级别
debug level
```

通过设置不同的调试级别，可以控制解释器输出的调试信息详细程度。级别越高，输出的调试信息越详细。不使用debug关键字时，默认级别为0，不输出任何调试信息。

文档内（首行 `debug level`）与命令行均可指定调试级别：
```bash
node dist/noethingScript-Interpreter.js program.ns --debug 2
```
命令行指定的级别优先级更高，文档内低于命令行的级别会被忽略。

#### 示例：
```vbnet
debug 1

// 声明一些变量并进行操作
local x:int = 5
local y:int = x + 3
```

当运行以上代码时，解释器将根据设置的调试级别输出相应的调试信息。

### 断言
```vbnet
assert (condition)
"assertion failure message"  // 下一行必须是双引号括起的字符串, 作为断言失败时的错误消息
endasrt

// 示例
assert (x >= 0) 
"x below zero !"
endasrt
```
断言失败时抛出 `AssertionError`（可被 `try-catch` 捕获，未捕获则由解释器输出错误消息）。

### 异常处理
```vbnet
try
    operate var, var, ...
catch (Exception ErrorName)
    operate var, var, ...
endtry
```
catch 中的异常变量 `ErrorName` 绑定为 string 类型的局部变量（值为错误消息），作用域从 catch 行到 `endtry`。可被捕获的异常包括 `SyntaxError`、`TypeError`、`ReferenceError`、`RangeError`、`AssertionError` 等；未被捕获的异常由解释器输出错误信息。

## 函数

### 函数声明
有返回值的函数：
```vbnet
:functionName (arg0:type, arg1:type, ...) -> rtVarName:type
    // 函数体
    return result  // 非void类型必须至少有一个return
:end
```

无返回值的函数：
```vbnet
:functionName (arg0:type, arg1:type, ...) -> :void
    // 函数体
:end
```

### 函数调用
有返回值的函数调用：
```vbnet
call functionName(arg0, arg1, ...) -> rtVar
```

无返回值的函数调用：
```vbnet
call functionName(arg0, arg1, ...)
```

### 函数规则
1. 必须声明返回值类型
2. 形参默认为local类型，不能使用global关键字
3. 形参数量不匹配：
   - 多于声明数量：取前面部分并抛出警告
   - 少于声明数量：直接报错
4. 类型不匹配直接报错
5. 非void函数必须有return语句
6. void函数不能有return语句
7. 有返回值的函数声明的时候是强制要求定义返回值变量及其类型的，返回值变量作用域从定义所在行一直到函数体最后一行（即:end标签所在行）
8. return语句只返回变量，return语句不支持运算操作等需提前处理完毕；且 return 只能返回函数声明返回值时定义的返回变量，返回其他变量（包括形参、局部变量、全局变量）会报错
9. return语句仅捕获返回变量的值并储存到隐型变量中待用
10. 解释器运行至return语句后立刻返回原调用位置
11. 函数调用说明：
    - call了指定函数后储存call所在行方便return语句返回
    - call了之后带着实参跳转至函数声明所在的第一行，然后将实参的值赋值给形参
    - 然后一直运行至函数体内的return语句后，返回调用所在行
12. 特别的，为了兼容无返回值函数，在调用无返回值函数时解释器运行到:end标签所在行则立即返回原调用所在行
13. 函数返回值变量会被初始化为 `undefined`（在函数体对其赋值前使用会报错，用于暴露"未操作返回值变量"的问题）

#### 数组作为函数参数
形参类型声明为 `array` 时，支持四种实参写法，`mut` 关键字前置（仅数组参数可用，形参与实参必须匹配，有 `mut` 必须都有，否则报错）：

| 形参声明 | 实参写法 | 语义 |
|---|---|---|
| `arr:array` | `call f(arr)` | 只读引用：函数内读取形参数组正常，写入数组元素报错，不影响原数组 |
| `arr:array` | `call f(copy(arr))` | 副本：深拷贝独立数组，函数内可自由修改，不影响原数组 |
| `arr:array` | `call f([1, 2, 3])` | 字面量：以元素字面量创建只读临时数组作为实参，函数内读取正常，写入报错 |
| `mut arr:array` | `call f(mut arr)` | 可变引用：函数内修改数组元素会写穿原数组 |

- 匹配规则：形参 `mut` 而实参未用 `mut`（且非 `copy`）→ 报错；形参未声明 `mut` 而实参用 `mut` → 报错；`copy()` 与 `mut` 形参兼容（副本独立可写）
- 字面量实参为只读临时数组，不能用于 `mut` 形参
- `copy(arr)` 可作为数组实参（副本）使用，也可用于整体赋值 `arrA = copy(arrB)`（见"数组整体赋值"）

#### 数组作为函数返回值
返回值类型声明为 `array` 时，在函数体内用 `return 数组变量` 直接返回（函数体内也可先通过整体赋值 `res = tmp` 将数组引用交给返回变量再 `return res`）：
```vbnet
:makeArr () -> res:array
local array tmp[3]:int = [5, 6, 7]
res = tmp
return res
:end
call makeArr() -> r1
print r1[0]   // 5
```
返回的是数组的引用，结果变量 `r1` 可直接按数组访问（`len(r1)`、`r1[i]` 读写）。

## 作用域规则

### 作用范围
- 全局变量：整个文档
- 局部变量：从声明行开始到对应结束标签

### 结束标签
| 结构        | 结束标签 |
|-------------|----------|
| 函数        | `:end`   |
| if语句      | `endif`  |
| for循环     | `endfor` |
| while循环   | `endwhl` |
| switch语句  | `endswc` |
| try-catch   | `endtry` |
| 断言        | `endasrt`|

## 表达式运算

### 数值字面量
数字支持四种进制字面量写法：

| 前缀    | 进制  | 示例          |
|---------|-------|---------------|
| 无前缀  | 十进制| `42`          |
| `0x`/`0X` | 十六进制 | `0xFF` (=255) |
| `0b`/`0B` | 二进制   | `0b1010` (=10) |
| `0o`/`0O` | 八进制   | `0o17` (=15)  |

### 条件表达式
1. 必须返回布尔值 `true`/`false`
2. 不能使用 `0`/`1` 替代布尔值
3. 必须用括号括起：`if (condition)`
4. 出现 `null` 或 `undefined` 立即抛出错误
5. 运算符两侧数据类型必须相同，否则返回 `false`（赋值表达式也必须相同，否则报错。条件表达式仅返回`false`，不报错）

### 内置函数
可在表达式中直接调用的内置函数：

| 函数 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `len(x)` | 字符串或数组 | int | 字符串长度或数组长度（详见"数组长度属性"） |
| `str(x)` | 任意 | string | 转换为字符串 |
| `int(x)` | 任意 | int | 转换为整数（`parseInt` 语义） |
| `float(x)` | 任意 | float | 转换为浮点数 |
| `copy(arr)` | 数组 | array | 数组深拷贝副本，用于实参副本或整体赋值（见"数组作为函数参数"/"数组整体赋值"） |

#### Math 数学对象
`Math.` 前缀调用数学函数（12 个）：

| 函数 | 说明 |
|---|---|
| `Math.abs(x)` | 绝对值 |
| `Math.floor(x)` / `Math.ceil(x)` / `Math.round(x)` | 向下/向上/四舍五入取整 |
| `Math.sqrt(x)` | 平方根 |
| `Math.pow(x, y)` | x 的 y 次幂 |
| `Math.max(a, b, ...)` / `Math.min(a, b, ...)` | 最大值/最小值 |
| `Math.sin(x)` / `Math.cos(x)` / `Math.tan(x)` | 三角函数 |
| `Math.random()` | [0,1) 随机数 |

#### 示例
```vbnet
print str(42)       // "42"
print int("3.9")    // 3
print float("2.5")  // 2.5
print Math.pow(2, 8) // 256
print Math.floor(3.7) // 3
```

## 注释

### 单行注释
```vbnet
// 这是单行注释
```

### 多行注释
```vbnet
/// 多行注释起始
注释内容（任意行，无需 /// 前缀，可包含代码）
/// 多行注释结束
```
采用就近原则闭合：遇到 `///` 行进入多行注释，区间内所有行（无论内容）均被忽略，直到遇到下一个 `///` 行结束。若文件结束时仍未闭合则视为注释到文件末尾。

## 跳转指令
```vbnet
jump (condition) :tagname
```

### 清除量指令
```vbnet
purge varName
```
默认清除局部变量，只能在函数体内调用。
清除全局变量需使用`purge global.varName`。


### 清除所有量指令
```vbnet
purge all
```
默认清除所有局部变量，全局变量不支持`all`关键字

### 排除清除指令
```vbnet
purge all except varName
```
默认清除所有局部变量，全局变量不支持`except`关键字

## 关键字列表
```
global, local, number, int, float, string, bool, array, 
true, false, const, if, else, endif, for, endfor, 
while, endwhl, switch, case, default, endswc, 
break, continue, return, assert, endasrt, try, 
catch, endtry, Exception, :functionName, :end, 
null, undefined, void, jump, :tagname, arrfill, 
purge, all, except, call, print, debug, mut, copy
```

## 异常类型
| 异常类型              | 说明         |
|-----------------------|--------------|
| `SyntaxError`         | 语法错误     |
| `TypeError`           | 类型错误     |
| `ReferenceError`      | 引用错误     |
| `RangeError`          | 范围错误     |
| `AssertionError`      | 断言错误     |
| `TryBlock`            | try代码块    |
| `CatchBlock`          | catch代码块  |
| `LoopInitError`       | for循环初始化失败 |
| `LoopUpdateError`     | for循环更新表达式执行失败 |
| `UnknownError`        | 未知错误     |