-- smoke test: a bit of everything
print("hello", 1 + 1, 2 * 3.5)
local function counter()
  local n = 0
  return function() n = n + 1 return n end
end
local c = counter()
c(); c()
print("counter", c())
print(("v8lua"):upper(), string.rep("ab", 3))
print(string.gsub("hello world", "o", "0"))
local t = { 3, 1, 2 }
table.sort(t)
print(t[1], t[2], t[3], #t)
print(type(nil), type(print), tostring(nil), tonumber("0x10"))
for i = 1, 3 do io.write(i, " ") end
io.write("\n")
local co = coroutine.wrap(function(a)
  local b = coroutine.yield(a + 1)
  return b * 2
end)
print(co(10), co(5))
print(pcall(function() error("boom", 0) end))
