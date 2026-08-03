debug 3
// 添加调试信息

global returnValue:int = 0

print "调用前全局 returnValue: " + returnValue

call testFunc1() -> returnValue

print "调用后全局 returnValue: " + returnValue

:testFunc1() -> :result:int 
    print "函数内访问 result: " + result
    // 应输出初始值0
    result = 42
    print "赋值后 result: " + result
    // 应输出42
    return result
:end