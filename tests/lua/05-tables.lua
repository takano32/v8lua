-- tables: constructors, length, table library
local t = { 10, 20, 30, x = "ex", [10] = "ten" }
print(t[1], t[2], t[3], t.x, t[10], #t)

local function three() return 7, 8, 9 end
local exp = { 1, three() }
print(#exp, exp[2], exp[4])
local cut = { three(), 1 }
print(#cut, cut[1], cut[2])
local par = { (three()) }
print(#par)

t = {}
table.insert(t, "a")
table.insert(t, "b")
table.insert(t, 1, "front")
print(table.concat(t, ","), #t)
print(table.remove(t, 1), table.concat(t, ","))
print(table.remove(t), table.concat(t, ","))

local nums = { 5, 2, 8, 1, 9, 3 }
table.sort(nums)
print(table.concat(nums, " "))
table.sort(nums, function(a, b) return a > b end)
print(table.concat(nums, " "))

local words = { "banana", "apple", "cherry" }
table.sort(words)
print(table.concat(words, " "))

print(table.concat({}, "-"))
print(table.concat({ 1, 2, 3 }, "", 2, 3))
print(table.maxn({ [1.5] = true, [7] = true, x = true }))
print(unpack({ "p", "q", "r" }))
print(unpack({ 1, 2, 3, 4 }, 2, 3))

-- nested and keyed access
local m = { a = { b = { c = 42 } } }
print(m.a.b.c, m["a"]["b"]["c"])
m.a.b.c = 43
print(m.a.b.c)

-- pairs over array part, deterministic
local arr = { "i", "ii", "iii" }
for i, v in ipairs(arr) do io.write(i, "=", v, " ") end
io.write("\n")
local stop = { "a", nil, "c" }
local cnt = 0
for i, v in ipairs(stop) do cnt = cnt + 1 end
print("ipairs stops at", cnt)
