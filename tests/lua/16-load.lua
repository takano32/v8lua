-- load / loadstring / dynamic code
local f = loadstring("return 1 + 2")
print(f())

local g = loadstring("return ...")
print(g("a", "b"))

local bad, err = loadstring("this is not lua")
print(bad == nil, err ~= nil)

-- load with a reader function
local pieces = { "return ", "10 ", "+ 32" }
local i = 0
local h = load(function()
  i = i + 1
  return pieces[i]
end)
print(h())

-- generated code touching globals
gen_target = 0
local setter = loadstring("gen_target = gen_target + 5")
setter(); setter()
print(gen_target)
gen_target = nil

-- chunks are vararg
local va = loadstring("local a, b = ... return b, a")
print(va(1, 2))

-- loadstring result shares _G
local reader = loadstring("return _VERSION")
print(reader())

-- string round trip via %q
local original = 'tricky "quotes" and \\ backslash'
local round = loadstring("return " .. string.format("%q", original))()
print(round == original)

print(pcall(loadstring("error('gen', 0)")))
