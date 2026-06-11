-- stdlib edges
print(type(nil), type(true), type(3), type("s"), type({}), type(print), type(coroutine.create(function() end)))
print(tonumber("10"), tonumber("  10  "), tonumber("0x1F"), tonumber("10e2"), tonumber("10e"), tonumber("abc"))
print(tonumber("ff", 16), tonumber("FF", 16), tonumber("z", 36), tonumber("101", 2), tonumber("8", 8))
print(tonumber("3.5"), tonumber("-3.5"), tonumber(".5"), tonumber("5."))
print(tonumber(42), tonumber(nil))
print(tostring(nil), tostring(true), tostring(12), tostring(1.25))

print(select("#"), select("#", nil), select("#", 1, 2, 3))

local t = { 10, 20, 30 }
print(next(t) ~= nil, next({}) == nil)

-- sorted pairs printing for determinism
local mixed = { z = 26, a = 1, m = 13 }
local keys = {}
for k in pairs(mixed) do keys[#keys + 1] = k end
table.sort(keys)
for _, k in ipairs(keys) do io.write(k, "=", mixed[k], " ") end
io.write("\n")

print(math.abs(-5), math.abs(5), math.max(3, 1, 4, 1, 5), math.min(3, 1, 4))
print(math.huge, -math.huge, math.huge > 1e308)
print(string.format("%.6f", math.pi))
print(math.floor(-0.5), math.ceil(-0.5))
print(math.fmod(7, 3), math.fmod(-7, 3), math.fmod(7, -3))
print(math.modf(3.7))
print(math.modf(-3.7))
print(math.sqrt(16), math.exp(0), math.log(1))
print(string.format("%.4f", math.log(8, 2)))
print(string.format("%.4f %.4f", math.deg(math.pi), math.rad(180)))
print(math.pow ~= nil)

math.randomseed(42)
local r1 = math.random()
local r2 = math.random(10)
local r3 = math.random(5, 8)
print(r1 >= 0 and r1 < 1, r2 >= 1 and r2 <= 10, r3 >= 5 and r3 <= 8, r2 == math.floor(r2))

print(os.time({ year = 2000, month = 1, day = 1, hour = 0, min = 0, sec = 0 }) ==
      os.time({ year = 2000, month = 1, day = 1, hour = 0, min = 0, sec = 0 }))
print(os.date("!%Y-%m-%d %H:%M:%S", 0))
print(os.date("!%Y-%m-%d", 86400))
local dt = os.date("!*t", 86399)
print(dt.year, dt.month, dt.day, dt.hour, dt.min, dt.sec, dt.wday, dt.yday, dt.isdst)
print(os.difftime(10, 4))
print(type(os.clock()), type(os.time()))
print(os.getenv("__V8LUA_UNDEFINED_VAR__"))

io.write("io", ".", "write", " ", 1, " ", 2.5, "\n")
print(collectgarbage("count") >= 0)
print(_VERSION)
