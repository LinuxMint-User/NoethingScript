# 自制脚本语言用户手册

## 概述
本语言是一种基于行运行的脚本语言，要求显式声明变量作用域和数据类型，支持常见的流程控制和函数定义。

## 一分钟上手

一个完整的可运行程序：

```ns
print "Hello, NoethingScript!"

global x:int = 10
print x * 2

:addOne (a:int) -> res:int
    res = a + 1
    return res
:end

call addOne(x) -> y
print y
```

逐行解析：

| 代码 | 说明 |
|---|---|
| `print "Hello, NoethingScript!"` | 输出一行文本，`print` 后跟表达式 |
| `global x:int = 10` | 声明全局整型变量 `x` 并初始化为字面量 `10`（声明初始化只允许字面量表达式，见"变量声明"） |
| `print x * 2` | 表达式直接参与运算并输出：`20` |
| `:addOne (a:int) -> res:int` | 定义函数 `addOne`：一个 `int` 形参 `a`，返回值存入返回变量 `res` |
| `res = a + 1` / `return res` | 函数体：计算后赋值给返回变量，`return` 返回之 |
| `:end` | 函数定义结束 |
| `call addOne(x) -> y` | 调用函数，实参 `x` 传给形参 `a`，返回值存入结果变量 `y` |
| `print y` | 输出调用结果：`11` |

运行方式（命令行或浏览器）见文末"运行方式"章节。运行时会输出一行 `[WARN]` 提示返回变量 `res` 声明时未赋值，这是正常提示（函数返回变量初始为 `undefined`，见"函数规则"第 13 条），不影响执行：`res` 虽未赋初值，但函数体内先经 `res = a + 1` 赋值再 `return res`，因此不会触发 `undefined` 错误。

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
```ns
global varname:type = value     // 全局变量
local varname:type = value      // 局部变量
global const varname:type = value  // 全局常量
local const varname:type = value   // 局部常量
```

### 初始化值
声明时的初始化值支持两种形式：

1. **字面量**：数字（含进制）、字符串、布尔、数组字面量
2. **纯字面量表达式**：仅允许字面量参与运算（算术、比较、逻辑、字符串拼接）

**不允许**在声明初始化中使用变量或函数调用（包括单变量引用）：

```ns
global y:int = 3 + 4                 // 字面量表达式
global s:string = "a" + "b"          // 字符串拼接
global flag:bool = 1 < 2 && true     // 逻辑运算
global array a[3]:int = [1 + 2, 3, 4]  // 数组元素字面量表达式
global bad:int = x + 4               // 错误: 不允许变量参与运算
global bad2:int = src                // 错误: 单变量引用也不允许
```

不支持 **复合赋值运算符**（`+=`、`-=`、`*=`、`/=`、`%=`），请使用 `x = x + 1` 形式。

### 注意事项
1. 未赋初值的变量值为 `undefined`，使用值为 `undefined` 的变量会报错
2. 全局变量存储空间内不允许同名变量
3. 局部变量存储空间内允许同名变量（通过作用域行号区分）
4. 局部变量允许与全局变量同名，块级作用域内需通过`global.`关键字访问全局变量
5. 在表达式中出现 `null` 或 `undefined` 立即报错；引用未定义的变量抛出 `ReferenceError`
6. 函数内部和流程块内部不可声明全局变量

## 数组类型

### 数组声明与初始化
数组必须显式声明长度，支持两种初始化方式：

```ns
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
| `number`   | 0.0              | 发出警告：建议明确声明为 `int` 或 `float` 类型                       |
| `int`      | 0                |                                                                      |
| `float`    | 0.0              |                                                                      |
| `string`   | ""（空字符串，字符串字面量须用英文双引号括起） |                                                      |
| `bool`     | false            |                                                                      |

`arrfill` 仅用于数组**声明时**的统一填充初始化（`global array buffer[32]:int = arrfill`），不能用于数组整体赋值等其他场景（会按未定义变量报错）。

#### 示例：
```ns
global array days[7]:string = ["Sun", "Mon", "Tue", "Wed", "Thur", "Fri", "Sat"]

global array months[12]:int = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]

global array buffer[32]:int = arrfill

global const arrLength0:int = 8
local array arr0[arrLength0]:int = arrfill
```

### 数组读写操作
```ns
// 读取数组元素（直接作为表达式使用，可用于 print、赋值、运算等）
print arrName[index]
varName = arrName[index]

// 写入数组元素
arrName[index] = val
```

#### 规则说明：
1. 索引 `index` 必须为非负整数，从 0 开始
2. 读取操作：被赋值的变量类型必须与数组元素类型相同
3. 写入操作：赋值的数据类型必须与数组元素类型相同
4. 可以使用同类型已初始化变量赋值，使用未初始化变量会报错
5. 越界访问直接报错

### 数组整体赋值
```ns
arrA = arrB
```
将 `arrB` 的引用整体赋值给 `arrA`（引用赋值），二者共享同一份数组数据，修改任一数组的元素会同步反映到另一个；`arrA` 的长度与元素类型随之变为与 `arrB` 一致。常量数组、只读引用数组（只读形参/字面量实参）禁止作为整体赋值目标。

若需要副本赋值（深拷贝，互不影响，`copy` 的完整语义见"内置函数"表）：
```ns
arrA = copy(arrB)
```
此后修改 `arrA` 不影响 `arrB`。

只读保护会随整体赋值与返回值传播：从只读引用视图（只读形参/字面量实参）整体赋值得到的引用、以及函数返回只读视图得到的引用，均保持只读，防止透过新名字写穿原数组。

### 数组长度属性
```ns
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
```ns
global const ROWS:int = 3
global const COLS:int = 4
global array matrix[ROWS * COLS]:int = arrfill

// 访问第2行第3列元素（索引从0开始）
matrix[1 * COLS + 2] = 10
```

## 流程控制

### 条件语句
```ns
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
```ns
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
```ns
global array data[5]:int = [10, 20, 30, 40, 50]
for (local i:int = 0; i < len(data); i = i + 1)
    print data[i]
endfor
```

### switch分支
```ns
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
```ns
// 设置调试级别
debug level
```

通过设置不同的调试级别，可以控制解释器输出的调试信息详细程度。级别越高，输出的调试信息越详细。不使用debug关键字时，默认级别为0，不输出任何调试信息。

脚本内（首行 `debug level`）与命令行 `--debug N`（见"运行方式"章节）均可指定调试级别，命令行指定的级别优先级更高。

#### 示例：
```ns
debug 1

// 声明一些变量并进行操作
local x:int = 5
local y:int = x + 3
```

当运行以上代码时，解释器将根据设置的调试级别输出相应的调试信息。

## 断言
```ns
assert (condition)
"assertion failure message"  // 下一行必须是双引号括起的字符串, 作为断言失败时的错误消息
endasrt

// 示例
assert (x >= 0) 
"x below zero !"
endasrt
```
断言失败时抛出 `AssertionError`（可被 `try-catch` 捕获，未捕获则由解释器输出错误消息）。

## 异常处理
```ns
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
```ns
:functionName (arg0:type, arg1:type, ...) -> rtVarName:type
    // 函数体
    return result  // 非void类型必须至少有一个return
:end
```

无返回值的函数：
```ns
:functionName (arg0:type, arg1:type, ...) -> :void
    // 函数体
:end
```

### 函数调用
有返回值的函数调用：
```ns
call functionName(arg0, arg1, ...) -> rtVar
```

无返回值的函数调用：
```ns
call functionName(arg0, arg1, ...)
```

### 函数规则
1. 必须声明返回值类型
2. 形参默认为local类型，不能使用global关键字
3. 形参数量不匹配：
   - 多于声明数量：取前面部分并发出警告
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
```ns
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
4. 出现 `null` 或 `undefined` 立即报错
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
```ns
print str(42)       // "42"
print int("3.9")    // 3
print float("2.5")  // 2.5
print Math.pow(2, 8) // 256
print Math.floor(3.7) // 3
```

## 注释

### 单行注释
```ns
// 这是单行注释
```

### 多行注释
```ns
///
注释内容（任意行，无需 /// 前缀，可包含代码）
///
```
只有整行恰为 `///`（允许首尾空白、不含其他任何内容）的独立行才会作为开始/结束标志，区间内所有行（无论内容）均被忽略。因此注释内容中带内容的 `/// xxx` 行不会被误判为结束标志；若文件结束时仍未闭合则视为注释到文件末尾。

## 跳转指令
```ns
jump (condition) :tagname
```

### 清除量指令
```ns
purge varName
```
默认清除局部变量，只能在函数体内调用。
清除全局变量需使用`purge global.varName`。


### 清除所有量指令
```ns
purge all
```
默认清除所有局部变量，全局变量不支持`all`关键字

### 排除清除指令
```ns
purge all except varName
```
默认清除所有局部变量，全局变量不支持`except`关键字

## 关键字列表
```ns
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
| `LoopInitError`       | for循环初始化失败 |
| `LoopUpdateError`     | for循环更新表达式执行失败 |
| `UnknownError`        | 未知错误     |

表中为可在脚本中捕获的异常类型（见"异常处理"）。`TryBlock`/`CatchBlock` 是解释器内部实现标识，用户代码不可见，不在此列。

### 错误报告格式

控制台输出统一为 `[ERROR N] [行 X] 类型: 消息`（英文输出时 `[Line X]`），错误编号与异常类型对应：

| 编号 | 异常类型 | 说明 |
|------|----------|------|
| 1 | `SyntaxError` | 语法错误 |
| 2 | `TypeError` | 类型错误 |
| 3 | `ReferenceError` | 引用错误 |
| 4 | `RangeError` | 范围错误 |
| 5 | `AssertionError` | 断言错误 |
| 6 | `UnknownError` | 未知错误 |
| 7 | `LoopInitError` | for循环初始化失败 |
| 8 | `LoopUpdateError` | for循环更新表达式执行失败 |

此外还有两类与脚本无关的输出：非致命问题以 `[WARN] [行 X] 警告: 消息` 输出；解释器自身缺陷（原生 JS 异常）以 `[内部错误] [行 X] 解释器内部发生错误: 消息` 输出并终止；脚本运行前的环境/文件错误以 `[错误] 消息` 输出。

## 运行方式

解释器可在命令行（Node.js）与浏览器两种环境中运行，二者共享同一份核心逻辑。

### 命令行运行

```bash
node dist/noethingScript-Interpreter.js 脚本文件名.ns
```

#### 调试级别

```bash
node dist/noethingScript-Interpreter.js 脚本文件名.ns --debug 2
```

命令行指定的级别优先级更高，脚本内（首行 `debug level`）低于命令行的级别会被忽略。

#### 输出语言控制

解释器默认使用中文输出错误/警告/调试信息，可通过 `--lang` 参数切换为英文：

```bash
node dist/noethingScript-Interpreter.js 脚本文件名.ns --lang en
node dist/noethingScript-Interpreter.js 脚本文件名.ns --lang en --debug 2
```

`--lang` 仅接受 `en` 或 `zh`（其他值忽略并保持默认中文），与 `--debug` 顺序可任意。运行时会用另一种语言提示当前语言及其切换方式（如默认中文时第一行显示英文 Tip）。

#### 帮助与版本信息

```bash
node dist/noethingScript-Interpreter.js --help      # 显示用法说明 (跟随 --lang 语言) 后退出
node dist/noethingScript-Interpreter.js --version   # 显示版本号后退出
```

`--help`/`--version` 为独立参数，不需要提供文件名，且优先于其他检查。

#### 参数约定

- 可选参数与文件名**顺序任意**，文件名必须是第一个**非 `-` 开头**的参数
- 以 `-` 开头的参数仅支持 `--debug`/`--lang`/`--help`/`--version`
- **不支持短参数**（如 `-h`/`-v`）；未知参数（含短参数）会提示"未知参数"并退出，不会被当作文件名

### 浏览器中使用

解释器核心为纯 TypeScript，不依赖 Node.js API，可直接在浏览器中加载编译产物，通过全局 `window.NSI` 调用：

```html
<script src="dist/noethingScript-Interpreter.js"></script>
<script>
    // 执行一段 NoethingScript 代码 (print 等输出走 console, 与 Node 一致)
    window.NSI.run("global x:int = 42\nprint x * 2");

    // 切换输出语言 ('zh' | 'en', 默认 zh)
    window.NSI.setLanguage('en');
    window.NSI.getLanguage();
</script>
```

`window.NSI` 提供：`version`、`run(code)`、`setLanguage(lang)`、`getLanguage()`，以及底层类 `Interpreter`/`ExpressionEvaluator`/`ScopeManager` 与语言包 `LANG_PACKS`。在 Node 环境中加载同一文件不会挂载 `NSI`，命令行行为不受影响；连续多次 `run()` 之间状态互相隔离（每次重新加载程序）。

## 常见问题 (FAQ)

**Q：声明变量时为什么不能用另一个变量赋值（`global y:int = x`）？**

A：声明初始化只允许字面量或字面量表达式，禁止引用变量（含单变量）。这是刻意设计：强制初始化值自包含，避免初始化顺序依赖和隐式耦合（详见"变量声明 → 初始化值"）。

**Q：为什么 `return` 不支持直接写运算（`return a + 1`）？**

A：`return` 只返回声明返回值时定义的返回变量，运算需先赋值给该变量。设计目标是强制"先计算、后返回"，让函数出口只有一条明确的返回路径，降低调试复杂度（详见"函数规则"第 8 条）。

**Q：为什么 `if`/`while` 的条件必须用括号，且不能用 `0`/`1` 代替布尔值？**

A：条件表达式必须是括号括起的 `bool` 值，`0`/`1` 会被拒绝。这能提前暴露"把数字当布尔"这类常见错误，而不是静默按真/假解释（详见"表达式运算 → 条件表达式"）。

**Q：为什么 for 循环变量不能修改？**

A：循环变量在作用域内为只读（for 更新表达式除外），防止循环内意外改动步进导致死循环或跳步（详见"流程控制 → for循环规则"）。

**Q：为什么数组整体赋值报错？**

A：若目标数组是常量数组、只读引用数组（只读形参/字面量实参），禁止作为整体赋值目标（详见"数组整体赋值"）。

**Q：为什么 `print` 一个未初始化的变量会报错？**

A：未赋初值的变量值为 `undefined`，在表达式中使用 `undefined`/`null` 会立即报错（详见"变量声明 → 注意事项"）。

**Q：为什么字符串字面量必须用双引号？**

A：字符串字面量只接受英文双引号（`"..."`），单引号不是字符串边界（详见"数组类型 → `arrfill` 关键字行为"附注）。

**Q：为什么 `-h` 会提示"未知参数"而不是运行脚本？**

A：不支持短参数；以 `-` 开头的参数仅接受 `--debug`/`--lang`/`--help`/`--version`（详见"运行方式 → 参数约定"）。