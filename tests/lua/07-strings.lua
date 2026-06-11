-- string basics
local s = "Hello, World"
print(s:len(), #s, s:upper(), s:lower())
print(s:sub(1, 5), s:sub(8), s:sub(-5), s:sub(2, -2), s:sub(0, 3), s:sub(5, 2))
print(s:sub(-100, 100))
print(("abc"):rep(3), ("ab"):rep(2, "-"), ("x"):rep(0))
print(("hello"):reverse())
print(("A"):byte(), ("abc"):byte(2), ("abc"):byte(1, 3), ("abc"):byte(-1))
print(string.char(72, 105))
print(("%d"):len())
print(string.len("with\0embedded") )
print(("MiXeD123"):upper(), ("MiXeD123"):lower())
local n = 42
print(string.sub(tostring(n), 1, 1))
print(("abc"):sub(2, 2):upper())
