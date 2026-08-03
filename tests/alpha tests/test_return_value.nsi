// 测试函数返回值变量初始化

// 声明returnValue变量
local returnValue:int = 0

// 调用函数并使用返回值，检查变量是否正确初始化
print "调用testFunc1前，returnValue的值:" 
print returnValue

call testFunc1() -> returnValue

print "调用testFunc1后，returnValue的值:" 
print returnValue

// 重新声明returnValue变量以匹配不同的返回类型
local returnValue:float = 0.0
print "调用testFunc2前，returnValue的值:" 
print returnValue

call testFunc2() -> returnValue

print "调用testFunc2后，returnValue的值:" 
print returnValue

// 重新声明returnValue变量以匹配不同的返回类型
local returnValue:string = ""
print "调用testFunc3前，returnValue的值:" 
print returnValue

call testFunc3() -> returnValue

print "调用testFunc3后，returnValue的值:" 
print returnValue

// 重新声明returnValue变量以匹配不同的返回类型
local returnValue:bool = false
print "调用testFunc4前，returnValue的值:" 
print returnValue

call testFunc4() -> returnValue

print "调用testFunc4后，returnValue的值:" 
print returnValue

:testFunc1() -> :returnValue:int
    returnValue = 42
    return returnValue
:end

:testFunc2() -> :returnValue:float
    returnValue = 3.14
    return returnValue
:end

:testFunc3() -> :returnValue:string
    returnValue = "hello"
    return returnValue
:end

:testFunc4() -> :returnValue:bool
    returnValue = true
    return returnValue
:end