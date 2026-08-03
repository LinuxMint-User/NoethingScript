debug 1
// 测试命名规则检查

// 正确的变量命名
local correctVar:int = 10
const global correctGlobal:string = "hello"

// 错误的变量命名 - 以数字开头
local 1invalidVar:int = 5

local :invalidVar:int = 6

// 错误的变量命名 - 包含特殊字符
const global invalid-var:string = "world"

// 正确的函数命名
:correctFunction() -> :void
    print "This is a correct function"
:end

// 错误的函数命名 - 以数字开头
:1invalidFunction() -> :void
    print "This function has invalid name"
:end

// 错误的函数命名 - 包含特殊字符
:invalid-function() -> :void
    print "This function also has invalid name"
:end

// 正确的数组命名
int arr[10]

// 错误的数组命名 - 以数字开头
int 1invalidArr[5]

// 主程序
print "Testing naming rules..."
call correctFunction()