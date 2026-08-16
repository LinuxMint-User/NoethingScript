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

运行方式（命令行或浏览器）见文末"运行方式"章节。`res` 虽未赋初值（函数返回变量初始为 `undefined`，见"函数规则"第 13 条），但函数体内先经 `res = a + 1` 赋值再 `return res`，因此不会触发 `undefined` 错误。若以 `--debug 1` 及以上运行，声明但未初始化的变量会显示 `[WARN]`（默认静默，见"调试控制"）。

## 变量声明

### 作用域
- `global`: 全局作用域，整个文档可见
- `local`: 局部作用域，仅在其声明位置到对应结束标签之间可见

### 数据类型
| 类型       | 说明                                                                 |
|------------|----------------------------------------------------------------------|
| `number`   | 数字类型（与 `int`/`float` 同源，值须为数字）                          |
| `int`      | 整数类型                                                             |
| `float`    | 浮点数类型                                                           |
| `string`   | 字符或字符串类型                                                     |
| `bool`     | 逻辑值，只能赋值为 `true` 或 `false`                                  |
| `array`    | 数组类型，必须显式声明长度                                           |

数字类型（`number`/`int`/`float`）**只接受数字值**：字符串（含 `"3.9"` 这类数字字符串）与布尔值一律报类型错误，不做隐式转换；非有限值 `NaN`/`Infinity`（如 `Math.sqrt(-1)`）同样拒收；需要转换请用内置 `int(x)`/`float(x)`/`str(x)`（见"内置函数"）。`bool` 同理只能赋 `true`/`false`。`string` 类型同样**只接受字符串值**——数字/布尔赋值报错，需 `str(x)` 显式转换；`"true"` 字符串与 `true` 布尔是两种不同的类型，`bool` 不提供任何转换（`str(true)`/`int(true)`/`float(true)` 均报错）。

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
local array arr0[arrLength0]:int = arrfill   // 局部数组只能在函数体内声明
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
4. 解释器在运行时求值并返回长度

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
`switch` 条件仅允许 `int` 或 `string` 类型（数字必须为整数，浮点 `1.5` 报错）；该检查**直接报告而不抛异常**，即使写在 try-catch 内也不可捕获（见"异常处理"）。

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

脚本内（首行 `debug level`）与命令行 `--debug N`（见"运行方式"章节）均可指定调试级别，命令行指定的级别优先级更高：命令行显式指定后覆盖脚本内的 debug 指令。

调试级别还控制部分警告的显示：声明但未初始化的变量在级别 0 时静默，级别 ≥1 时输出 `[WARN]`（先声明后赋值等场景默认不打扰，需要时可开启调试查看）。

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
catch 中的异常变量 `ErrorName` 绑定为 string 类型的局部变量（值为错误消息），作用域从 catch 行到 `endtry`。**运行期抛出的异常**可被捕获，包括 `ReferenceError`、`RangeError`、`AssertionError` 及多数 `TypeError` 等；未被捕获的异常由解释器输出错误信息。注意：**少数检查直接报告而不抛异常，此类错误不可捕获**——const/param 只读赋值、switch 条件类型检查（详见"switch分支"），以及编译期（解析期/NSVM 编译期）报出的错误，均不受 try-catch 影响。

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

数组形参必须声明元素类型（`arr[]:int`，`mut` 前置），数组返回值同样声明元素类型（`-> st[]:int`），详见"数组作为函数参数"与"数组作为函数返回值"。

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
数组形参必须声明元素类型，格式为 `形参名[]:元素类型`（`[]` 表示不定长数组，形参不限制长度）；`mut` 关键字前置（仅数组参数可用）。支持四种实参写法，形参与实参的 `mut` 与元素类型必须匹配：

| 形参声明 | 实参写法 | 语义 |
|---|---|---|
| `arr[]:int` | `call f(arr)` | 只读引用：函数内读取形参数组正常，写入数组元素报错，不影响原数组 |
| `arr[]:int` | `call f(copy(arr))` | 副本：深拷贝独立数组，函数内可自由修改，不影响原数组 |
| `arr[]:int` | `call f([1, 2, 3])` | 字面量：以元素字面量创建只读临时数组作为实参，函数内读取正常，写入报错 |
| `mut arr[]:int` | `call f(mut arr)` | 可变引用：函数内修改数组元素会写穿原数组 |

- 元素类型匹配规则（三档，`int`/`float` 严格区分、`number` 兼容并警告）：
  - 形参声明 `int` → 实参元素必须为 `int`（`float` 数组不兼容）
  - 形参声明 `float` → 实参元素必须为 `float`（`int` 数组不兼容；严格区分浮点以避免精度混淆）
  - 形参声明 `number` → 兼容 `int`/`float` 元素，但输出 `[WARN]` 提示"建议明确声明为 int 或 float"（与 `arrfill` 对 `number` 数组的警告一致）
  - 声明 `string`/`bool` → 严格相等
  - 不匹配报"数组类型不匹配"

设计说明：

- **为什么数组层 `int`/`float` 严格区分**：数组实参在 `mut` 模式下引用共享（写穿原数组），绑定后写入校验按**实参的元素类型**进行。若允许 `int` 数组进 `float` 形参，函数内写浮点值会被实参的 `int` 类型拒绝——出现"形参声明 `float` 却写不进浮点数"的怪异行为，报错位置还偏移在函数体内。三档让类型契约在**调用点**守住：形参声明什么类型，实参就必须是什么类型，错误早暴露、行为可预测
- **数组层与标量层的区别**：标量变量/形参的 `float` 仍接受整数（`global x:float = 5` 合法）。原因是 JS 值模型下 `5` 与 `5.0` 是同一个值，标量层无法按书写形式严格区分；且 `int` → `float` 在 double 下无损（2⁵³ 以内整数精确表示），真正有损的 `float` → `int` 已被 `int` 的严格校验挡住。因此"严格"只落在有"写穿"风险的数组层，标量层保持宽松（见"数据类型"）
- **`number` 为什么兼容并警告**：`number` 是"任意数字"语义，本身不承诺 `int`/`float` 之一；接收明确类型的实参时给出 `[WARN]`，提示作者显式声明，与 `arrfill` 对 `number` 数组的警告同一出发点
- 数组字面量实参的数字元素：整数推断 `int`，小数推断 `float`（与语言 int/float 显式区分一致）
- 匹配规则：形参 `mut` 而实参未用 `mut`（且非 `copy`）→ 报错；形参未声明 `mut` 而实参用 `mut` → 报错；`copy()` 与 `mut` 形参兼容（副本独立可写）
- 字面量实参为只读临时数组，不能用于 `mut` 形参
- `copy(arr)` 可作为数组实参（副本）使用，也可用于整体赋值 `arrA = copy(arrB)`（见"数组整体赋值"）

#### 数组作为函数返回值
数组返回值必须声明元素类型，格式为 `-> 返回变量名[]:元素类型`。在函数体内用 `return 数组变量` 直接返回（函数体内也可先通过整体赋值 `res = tmp` 将数组引用交给返回变量再 `return res`）：
```ns
:makeArr () -> res[]:int
local array tmp[3]:int = [5, 6, 7]
res = tmp
return res
:end
call makeArr() -> r1
print r1[0]   // 5
```
返回的是数组的引用，结果变量 `r1` 可直接按数组访问（`len(r1)`、`r1[i]` 读写）。返回数组的元素类型须与声明一致（声明 `int` 时返回的数组元素必须为整数）。

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
5. `==`/`!=` 两侧类型必须相同，跨类型比较（数字 vs 字符串 vs 布尔等）一律报类型错误，可被 try-catch 捕获；数字类型之间按数值比较不受此限制——`int`/`float`/`number` 实现层同为数字，`5 == 5.0`、`0 == 0.0` 恒为 `true`
6. 运算符两侧数据类型必须相同：`+` 仅允许 `数字 + 数字`（加法）或 `字符串 + 字符串`（拼接），混合类型（如 `"a" + 5`、`5 + true`）一律报类型错误，需 `str()`/`int()`/`float()` 显式转换；`-` `*` `/` `%` `**` 及大小比较运算符（`<` `>` `<=` `>=`）要求两侧均为数字；`==`/`!=` 按第 5 条两侧类型必须相同
7. 一元运算符类型限制：`+`/`-` 仅接受数字操作数，`!` 仅接受布尔操作数，其余类型报错（无隐式转换）
8. 短路求值：`&&` 左侧为 `false`、`||` 左侧为 `true` 时，右侧表达式不求值（如 `false && 1/0` 不会触发除零异常）；两侧操作数必须为布尔，非布尔报类型错误。内置函数分两类：**计算型**（`Math.*`/`String.*`/`Bit.*`/`len`/`str`/`int`/`float` 等）定位为"函数模样的运算符"，与运算符同级、无副作用，可自由出现在短路右侧——短路跳过它们不会跳过任何有意图的操作（用户函数只能通过 `call` 语句调用，天然不会出现在表达式中）；**I/O 型**（`input()`）与外界交互是它的目的——阻塞等待输入/挂起脚本，不是"函数模样的运算符"，有副作用，故禁止出现在 `&&`/`||` 右侧（短路跳过它会"该问的输入没问"），需输入请先 `if` 判断再显式调用

### 内置函数
可在表达式中直接调用的内置函数。内置函数分两类：**计算型**（`len`/`str`/`int`/`float`/`copy` 及 `Math.*`/`String.*`/`Bit.*`）——无副作用、与运算符同级，是"函数模样的运算符"，可自由出现在表达式中任何位置（含 `&&`/`||` 短路右侧）；**I/O 型**（`input()`）——与外界交互是它的目的，与 `print` 关键字同属语言的 I/O 通道（`print` 是关键字/语句、`input()` 是函数/表达式，形态不同、定位相同），不是"函数模样的运算符"、有副作用，故禁止出现在 `&&`/`||` 短路右侧（见"条件表达式 → 短路求值"）：

| 函数 | 参数 | 返回 | 说明 |
|---|---|---|---|
| `len(x)` | 字符串或数组 | int | 字符串长度或数组长度（详见"数组长度属性"） |
| `str(x)` | 任意非 `bool` | string | 转换为字符串（`bool` 不提供转换） |
| `int(x)` | 任意非 `bool` | int | 转换为整数（`parseInt` 语义；`bool` 不提供转换） |
| `float(x)` | 任意非 `bool` | float | 转换为浮点数（`bool` 不提供转换） |
| `copy(arr)` | 数组 | array | 数组深拷贝副本，用于实参副本或整体赋值（见"数组作为函数参数"/"数组整体赋值"） |
| `input()` | 无 | string | I/O 通道（输入侧，与 `print` 输出侧同定位）：读取一行用户输入（不含换行符）。命令行读取 stdin；浏览器默认 `prompt` 弹窗，可用 `NSI.setInput()` 绑定自定义输入源（如页面输入框）。浏览器交互模式（`NSI.runInteractive`）下无输入时挂起等待 `NSI.resumeInput(value)` 喂入（见"浏览器中使用"）。注意声明初始化不允许函数调用，需先声明后赋值 |

**参数类型严格校验（2.7.2 收紧）**：所有内置函数参数类型显式，借用宿主 JS 的能力但不继承其隐式强转的陋习——`Math.*`/`Bit.*` 参数只收 `number`，`String.*` 的源串/目标串/替换串参数只收 `string`、数字参数（`take` 的 `start`/`count`、`findFirst` 的 `from`）只收 `number`、`replace` 的 `all` 只收 `bool`。`Math.abs("5")`、`String.take(12345, 1, 2)`、`Bit.and("1", 2)` 等一律抛类型错误（`TypeError`，可被 `try-catch` 捕获），需要转换请先显式 `int(x)`/`float(x)`/`str(x)`。与赋值、运算符的类型显式规则保持一致。

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

#### String 字符串对象
`String.` 前缀调用字符串操作函数（8 个）。与 `Math.*` 同源（解释器内置预置对象，所有脚本可用），但**命名按语言自身风格定，不沿用 JS 名字**——借用 JS 能力，不借命名：

| 函数 | 说明 |
|---|---|
| `String.take(s, start, count)` | 取子串：从 `start` 起取 `count` 个字符。边界全显式（无隐式兜底）：`start`/`count` 非负、`start < len(s)`、`count <= len(s) - start`，越界抛 `RangeError`（可被 `try-catch` 捕获）；`count = 0` 返回空串。取到末尾请显式写 `String.take(s, start, len(s) - start)` |
| `String.findFirst(s, target, from)` | `target` 首次出现的下标（`int`）；找不到返回 `false`。`from` 可省略（默认从 0 开始找） |
| `String.findLast(s, target)` | `target` 末次出现的下标（`int`）；找不到返回 `false` |
| `String.has(s, target)` | 是否包含 `target`，返回 `bool` |
| `String.replace(s, old, new, all)` | 替换。`all` 可省略：默认只替换第一处；`all = true` 替换所有出现 |
| `String.toUpper(s)` | 转大写 |
| `String.toLower(s)` | 转小写 |
| `String.trim(s)` | 去除首尾空白 |

字符串长度用内置 `len(s)`（与数组长度同一函数），不再单设 `String.length`。

返回规范（与语言整体一致）：**操作成功返回结果或 `true`，失败返回 `false`**——`findFirst`/`findLast` 找不到返回 `false`，`has` 不包含返回 `false`。NS 变量类型显式，"下标或 `false`"的混合返回无法直接绑定单一类型变量，判断存在性的标准写法是先 `has` 后取值：

```ns
if (String.has(s, target))
    pos = String.findFirst(s, target)   // 已确认存在, 返回 int
endif
```

#### Bit 位运算对象
`Bit.` 前缀调用位运算函数（6 个），直接映射 JS 位运算符，32 位有符号语义（与 `Math.*` 同源）。设计上不动 NS 运算符语法（`& | ^ << >>` 涉及词法/表达式解析/NSVM 编译三处，成本高且有违"显式可预测"），以函数形式提供：

| 函数 | 说明 |
|---|---|
| `Bit.and(a, b)` | 按位与 |
| `Bit.or(a, b)` | 按位或 |
| `Bit.xor(a, b)` | 按位异或 |
| `Bit.not(x)` | 按位取反（`~`，结果可能为负） |
| `Bit.shl(x, n)` | 左移 `n` 位（高位溢出变负） |
| `Bit.shr(x, n)` | 算术右移 `n` 位（高位补符号位） |

#### 示例
```ns
print str(42)       // "42"
print int("3.9")    // 3
print float("2.5")  // 2.5
print Math.pow(2, 8) // 256
print Math.floor(3.7) // 3
print len("Hello")       // 5
print String.take("Hello World", 0, 5)     // Hello
print String.findFirst("Hello World", "World") // 6
print String.has("Hello", "ell")  // true
print String.replace("a-b-a", "a", "x", true) // x-b-x
print Bit.and(0xF0, 0x3C) // 48
print Bit.shl(1, 8) // 256
```

## 注释

### 单行注释
```ns
// 这是单行注释
```
`//` 注释必须**独占整行**（允许首尾空白），**不支持行内注释**——代码行尾追加 `// xxx` 会被当作未匹配的符号报语法错误。这是设计使然：语言按行解析，行尾注释会引入解析歧义，故统一整行注释。若需在代码行旁做说明，请另起一行注释。

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

## 运行前参数 (cmdargs)

语言无 `argv`，外部进语言的只有字符串。三条 I/O 通道：`print`（输出，关键字）、`input()`（运行中输入，函数）、`cmdargs` 块（启动参数，声明式接收）。`cast.类型`（`cast.int`/`cast.float`）是 cmdargs 的 param 专属的"字符串 → 类型化变量"接收类型；`input()` 返回字符串，需要类型化请用 `int()`/`float()` 显式转换（声明初始化不允许函数调用，先声明后赋值）。

### cmdargs 块

```ns
cmdargs
param cmd:string = "help"
param verbose:bool = false as "v"
endcmdargs
```

- **位置**：脚本头部（`debug` 指令之后、主内容之前），与 `modules` 块同级（见"模块系统"）；全文件**至多一个**
- **只对入口文件生效**：参数只传给被解释器直接执行的文件；被 `use` 的模块写了 `cmdargs` **不报错、不生效**，参数保持默认值（模块作者两手准备：作入口时收命令行参数，被 use 时靠 API 传参）
- **绑定时机**：入口文件**执行前**完成解析与绑定，**先于 autoinit 与正文执行**——autoinit 内可直接使用 param；autoinit 与正文同级别、共享同一空间

### param 声明

语法：`param 名:类型 = 默认值`，可再跟 `as "短名"` 提供短参数别名（命令行用 `-短名 值`，与 `--全名 值` 并存）：

| 类型 | 说明 |
|---|---|
| `string` | 字符串 |
| `bool` | 布尔，命令行作开关使用 |
| `cast.int` | 接收字符串按 `int()` 语义转换后再存 |
| `cast.float` | 接收字符串按 `float()` 语义转换后再存 |

- 命名规则与普通变量完全一致
- 默认值**必须有**且只能是字面量
- param 变量**只读**，程序内修改报错（与 `const` 一致）；需改写先读出赋给普通变量

### 命令行匹配

命令行两层结构：`--` 是独立记号（前后空格隔开），从这里开始后面全部归脚本：

```bash
node dist/noethingScript-Interpreter.js --debug 1 script.ns -- arg1 arg2 ...
```

脚本参数区按 cmdargs 定义切分（两步流程）：

1. **先处理带横杠的有名参数**：`--名字 值` 全名、`-短名 值` 短名；`bool` 是开关——传入即翻转默认值，后面紧邻的东西不归它管；`string`/`cast` 必须消费后面紧邻的一个值，缺值报错
2. **再处理匿名参数**（不带横杠）：从剩余未赋值的 param 中按原声明顺序重排，把裸参数按重排顺序填充（`bool` 不接收匿名值）；少的用默认值，多的丢弃并给出警告

错误规则：未知有名参数（基本是拼写错误）报错；脚本参数区内不允许孤立的 `--`（`--` 必须紧跟字母组成 `--名字`）；`cast` 转换失败报错并标注变量名；头部 param 声明语法错误（格式/未知类型/缺默认值/短名与全名相同/重复声明/默认值非字面量）为运行前错误，报错后整体终止、程序不执行。

例：`param debug:bool = false` 时传 `--debug 1` → `debug` 变 `true`、`1` 是独立匿名参数（两个）；`param debug:cast.int = 0` 时同样传 `--debug 1` → `debug` 就是 `1`（一个）。

浏览器中通过 `NSI.setCmdargs(args)` 设置脚本参数区（对应命令行 `--` 之后的部分），不调用则参数区为空、param 全部用默认值。

## 模块系统

NS 支持多文件模块化：把可复用的函数与数据封装进模块文件，主程序用 `use` 声明激活并跨文件调用。完整设计见 [module-system/design.md](module-system/design.md)。

### use 语句

`use` 必须位于文件头部的 `modules ... endmodules` 块内：

```ns
modules
use tools from main
use stack from main as st
endmodules
```

语法：`use [inner] 模块名 [from 来源] [as 别名]`

- `模块名` 与普通变量命名一致；**对象名** = 模块名（或 `as` 后的别名），之后用对象名调用
- `from 来源` 指定来源目录，仅允许 `main`/`extra`/`custom`（三分类目录），默认 `main`
- `use inner` 引用**当前包**内模块（按当前文件路径上两级目录定位包根），不能带 `from`
- 头部区结构：`debug`（必须物理首行）/ `modules` 块 / `cmdargs` 块 / `autoinit` 块**同级、互不嵌套**，各自全文件至多一次，惯例顺序 `debug → modules → cmdargs → autoinit`（非强制）；块内只允许对应内容（modules 块内只允许 `use` + 空行 + 注释）；主内容区出现 `use` 报错

### 模块文件组织

模块目录唯一（命令行 `--modules DIR` 配置，默认 `modules/`），组织形式为三分类目录：

```
modules/{来源}/{包}/{模块}/{模块}.ns
```

例：`use tools from main` 定位 `modules/main/tools/tools/tools.ns`。每包可有 `manifest` 元数据文件；模块文件头部同样可有 `modules` 块（嵌套 `use` 依赖，递归加载、跨文件幂等——模块实例全局唯一、循环依赖检测）。

### 模块函数调用

模块函数与普通用户函数统一走 `call` 语句（点分调用），同一管道 → 函数体天然吃 NSVM 指令化：

```ns
call stack.newStack(mut st)
call stack.pop(mut st) -> v
```

模块符号挂在模块命名空间对象上（不进全局函数表，与主程序全局零冲突）；模块函数内查找链为**局部变量 → 模块私有全局 → 未声明报错**，不访问主程序任何全局；与主程序交互的唯一通道是"调用 + 返回值"，数组形参/返回值/`mut` 写穿等边界语义与普通函数完全一致。

### autoinit 与顶层动作

- `autoinit ... endautoinit` 块（头部区、至多一个）在**模块被 use 时执行**（入口脚本则与正文都执行）；模块内 global 声明与函数定义加载期全文件统一建立，autoinit 可自由引用
- 模块内顶层可执行语句**在被 use 时不执行**（只执行 autoinit 区间）；文件作为程序入口直接执行时顶层语句正常执行
- 模块上下文中的输出与未捕获错误强制带来源标识 `[模块 来源/包/模块]`，跨来源/跨包同名不混淆
- 模块函数内错误与普通函数一致：主程序 `try-catch` 可捕获；**加载期错误**（use 失败/模块语法错误/依赖循环）由模块管理器与加载器负责，不可 `try-catch`，报错后整体终止

### 浏览器中使用

浏览器需注入模块加载能力（嵌入式刚需）：`NSI.setModuleLoader(name => 源码字符串)`（同步原语，`name` 为模块定位名，不存在返回 `null`）、`NSI.setModuleDir(dir)`（配置模块目录，默认 `modules`）、`NSI.setCurrentFilePath(path)`（设置当前文件定位标识，供 `use inner` 定位包根）。

## 关键字列表
```ns
global, local, number, int, float, string, bool, array, 
true, false, const, if, else, endif, for, endfor, 
while, endwhl, switch, case, default, endswc, 
break, continue, return, assert, endasrt, try, 
catch, endtry, Exception, :functionName, :end, 
null, undefined, void, jump, :tagname, arrfill, 
purge, all, except, call, print, debug, mut, copy, 
modules, endmodules, use, from, as, inner, 
cmdargs, endcmdargs, param, autoinit, endautoinit, cast
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

#### 模块目录

```bash
node dist/noethingScript-Interpreter.js 脚本文件名.ns --modules mydir
```

配置模块目录（唯一，默认 `modules`），`use` 语句按此目录定位模块文件（见"模块系统"）。

#### 脚本参数区

```bash
node dist/noethingScript-Interpreter.js 脚本文件名.ns -- arg1 arg2 ...
```

`--` 是独立记号（前后空格隔开），从这里开始后面全部归脚本，由入口文件的 cmdargs 声明按规则接收（见"运行前参数 (cmdargs)"）；与 `--name`（横杠紧跟字母）天然不冲突。

#### 参数约定

- 可选参数与文件名**顺序任意**，文件名必须是第一个**非 `-` 开头**的参数
- 以 `-` 开头的参数仅支持 `--debug`/`--lang`/`--modules`/`--help`/`--version`；`--` 是脚本参数区分隔符
- **不支持短参数**（如 `-h`/`-v`）；未知参数（含短参数）会提示"未知参数"并退出，不会被当作文件名
- 脚本参数区内不存在"未知可选参数"概念：`--` 之后的一切（含 `-h` 这类横杠串）都按 cmdargs 规则交给脚本解析

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

    // 绑定自定义运行时输入: input() 会调用此同步函数而非默认的 prompt 弹窗
    window.NSI.setInput(() => {
        return document.getElementById('inputBox').value;
    });
    window.NSI.setInput(null); // 传入 null 恢复默认 prompt 弹窗
</script>
```

`window.NSI` 提供：`version`、`run(code)`、`runInteractive(code, onInput?)`、`resumeInput(value)`、`setLanguage(lang)`、`getLanguage()`、`setInput(handler)`、`setCmdargs(args)`（设置脚本参数区，对应命令行 `--` 之后的部分）、`setModuleLoader(loader)`/`setModuleDir(dir)`/`setCurrentFilePath(path)`（模块加载能力注入，见"模块系统"），以及底层类 `Interpreter`/`ExpressionEvaluator`/`ScopeManager` 与语言包 `LANG_PACKS`。在 Node 环境中加载同一文件不会挂载 `NSI`，命令行行为不受影响；连续多次 `run()` 之间状态互相隔离（每次重新加载程序）。

##### 交互执行（程序模式）

`run()` 是同步执行到底的。若脚本需要**自持主循环**（游戏等交互程序：脚本在 `input()` 处等待用户输入、拿到后继续跑），可用 `runInteractive` + `resumeInput` 实现挂起/恢复，让脚本自持完整流程、JS 只做交互胶水：

```html
<script>
    // 启动: 脚本跑到 input() 且无可用输入时挂起, 返回 'suspended'; 跑完返回 'finished'
    const status = window.NSI.runInteractive(NS_SCRIPT, () => {
        // 可选回调: 挂起时通知宿主 (如刷新"等待输入"提示)
    });

    // 用户按键时: 从挂起处继续执行 (每按键喂一次), 返回 'suspended'/'finished'
    function onKey(key) {
        if (window.NSI.resumeInput(key) === 'finished') {
            // 脚本运行结束 (如用户选择退出)
        }
    }

    // 重新开局: 直接再次 runInteractive 会重新加载程序并重置一切
    function restart() {
        window.NSI.runInteractive(NS_SCRIPT, () => {});
    }
</script>
```

约定：脚本一行内只出现一次 `input()`（恢复时会重执行挂起行）；`try` 块内挂起需自行避免（语义是"重做"，会被 catch 捕获）。完整示例见 `examples/2048_web.html`（网页版 2048，脚本与命令行版 `examples/2048.ns` 同构、自持主循环）。

## 常见问题 (FAQ)

**Q：声明变量时为什么不能用另一个变量赋值（`global y:int = x`）？**

A：声明初始化只允许字面量或字面量表达式，禁止引用变量（含单变量）。这是刻意设计：强制初始化值自包含，避免初始化顺序依赖和隐式耦合（详见"变量声明 → 初始化值"）。同理，`input()` 等函数调用也不能出现在声明初始化中，需先声明后赋值：
```ns
global name:string
name = input()
```

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