// 测试函数参数作用域


global result:int = 0

//call testFunc(5, "hello") -> result
call testFunc(5, "hello")
print "result = " + str(result)

:testFunc (param1:int, param2:string) -> :void
    print "param1 = " + str(param1)
    print "param2 = " + param2
    //output = param1 + 1
    //return param1
:end