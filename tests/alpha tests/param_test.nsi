// 测试函数参数作用域

:testFunc (param1:int, param2:string) -> result:int
    print "param1 = " + str(param1)
    print "param2 = " + param2
    return param1 + 1
:end

call testFunc(5, "hello") -> result
print "result = " + str(result)