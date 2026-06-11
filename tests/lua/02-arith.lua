-- arithmetic, coercion, comparison, concat
print(1 + 2 * 3 - 4 / 8, 7 % 3, -5 % 3, 5 % -3, -5.5 % 3, 2^10, 2^-1)
print(7 / 2, -7 / 2, 0 / 0 ~= 0 / 0, 1 / 0, -1 / 0)
print("10" + 5, "3" * "4", "0x10" + 0, "  2  " + 1, 10 .. 20, 1.5 .. "x")
print(-"3", -(-3))
print(2 < 3, 3 <= 3, "a" < "b", "10" < "9", "abc" < "abd", "ab" < "abc")
print(1 == 1.0, nil == nil, nil == false, true ~= false)
print("a" .. "b" .. "c", 1 .. 2 .. 3)
print(2^2^3, -2^2, (2 + 3)^2)
print(tostring(3), tostring(3.5), tostring(-0), tostring(2^53), tostring(1e15), tostring(1e16))
print(math.floor(3.7), math.ceil(3.2), math.floor(-3.7), math.ceil(-3.2))
print(1e15 + 0.5)
local big = 99999999999999
print(big, big + 1)
