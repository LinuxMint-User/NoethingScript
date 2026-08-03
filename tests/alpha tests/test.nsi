// 测试案例：计算斐波那契数列的前N项和

// 全局变量声明
global const N:int = 10
global sum:int = 0

// 函数声明：计算斐波那契数列的第n项
:fib (n:int) -> result:int
    if (n <= 1)
        return n
    else
        local a:int = 0
        local b:int = 1
        local temp:int = 0
        for (local i:int = 2; i <= n; i = i + 1)
            temp = a + b
            a = b
            b = temp
        endfor
        return b
    endif
:end

// 主程序
print "计算斐波那契数列的前" + str(N) + "项："
for (local i:int = 0; i < N; i = i + 1)
    local fibValue:int = 0
    call fib(i) -> fibValue
    print "fib(" + str(i) + ") = " + str(fibValue)
    sum = sum + fibValue
endfor

print "前" + str(N) + "项的和为: " + str(sum)

// 测试数组操作
array testArray[5]:int = {1, 2, 3, 4, 5}
print "数组内容："
for (local i:int = 0; i < len(testArray); i = i + 1)
    print "testArray[" + str(i) + "] = " + str(testArray[i])
endfor

// 测试条件语句
if (sum > 100)
    print "sum大于100"
else
    print "sum小于等于100"
endif