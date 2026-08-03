debug 4

// 测试用例1: 应该报错 - const 关键字位置错误 
const global invalidVar:int = 0

// 测试用例2: 应该报错 - 常量重新赋值 
global const validConst:int = 10
validConst = 20
// 这里应该抛出 TYPE_ERROR

// 测试用例3: 应该报错 - 全局/局部变量同名 
global conflictVar:int = 1
// 需要在函数内声明局部变量
testFunction()

:testFunction() -> :void
local conflictVar:int = 2
// 这里应该抛出 REFERENCE_ERROR
endfunc

// 测试用例4: 正确的语法
global const correctConst:int = 5
local const correctLocalConst:string = "hello"

// 测试用例5: 无效变量名
global const 123invalid:int = 0

global const validVar:int = 1