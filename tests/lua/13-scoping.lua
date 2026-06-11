-- scoping rules
local x = "outer"
do
  local x = "inner"
  print(x)
end
print(x)

-- shadowing in same block
local y = 1
local y = y + 1
print(y)

-- local function recursion vs plain local
local function fact(n)
  if n <= 1 then return 1 end
  return n * fact(n - 1)
end
print(fact(5))

-- repeat-until sees body locals
local tries = 0
repeat
  tries = tries + 1
  local stop = tries >= 3
until stop
print("tries", tries)

-- per-iteration captures in all loop forms
local fs = {}
for i = 1, 3 do fs[#fs + 1] = function() return i end end
local k = 0
while k < 2 do
  k = k + 1
  local kk = k * 10
  fs[#fs + 1] = function() return kk end
end
for _, f in ipairs(fs) do io.write(f(), " ") end
io.write("\n")

-- generic for fresh bindings
local gs = {}
for _, v in ipairs({ "a", "b" }) do gs[#gs + 1] = function() return v end end
print(gs[1](), gs[2]())

-- upvalue mutation visible across closures
local n = 0
local function bump() n = n + 1 end
local function read() return n end
bump(); bump()
print(read())

-- globals vs locals
g_test = "global"
local g_test = "local"
print(g_test, _G.g_test)
_G.g_test = nil

-- nested function upvalues (two levels)
local function outer()
  local a = 1
  return function()
    local b = 10
    return function() a = a + 1 return a + b end
  end
end
local f = outer()()
print(f(), f())
