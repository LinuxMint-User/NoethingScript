debug 3

global returnValue:int = 0

global const constant:int = 0

print "调用前全局 returnValue: " + returnValue

call testFunc1() -> returnValue

print "调用后全局 returnValue: " + returnValue

:testFunc1() -> :result:int 
    print "函数内访问 result 初始值: " + result 
    result = 42 
    print "赋值后 result: " + result 
    return result 
:end
