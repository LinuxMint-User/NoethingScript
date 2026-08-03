// 测试函数返回值变量初始化

// 声明returnValue变量
global returnValue:int = 0

// 调用函数并使用返回值，检查变量是否正确初始化
print "调用testFunc1前，returnValue的值:" 
print returnValue

call testFunc1() -> returnValue

print "调用testFunc1后，returnValue的值:" 
print returnValue

:testFunc1() -> :result:int
    result = 42
    return result
:end

