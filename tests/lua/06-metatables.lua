-- metatables and metamethods
local base = { greet = function() return "hi" end, shared = 1 }
local child = setmetatable({}, { __index = base })
print(child.greet(), child.shared, rawget(child, "shared"))

-- __index chain
local g1 = setmetatable({}, { __index = base })
local g2 = setmetatable({}, { __index = g1 })
print(g2.shared)

-- __index function
local dyn = setmetatable({}, { __index = function(t, k) return "dyn:" .. k end })
print(dyn.foo, dyn.bar)

-- __newindex
local store = {}
local proxy = setmetatable({}, {
  __newindex = function(t, k, v) store[k] = v end,
  __index = store,
})
proxy.a = 10
print(proxy.a, rawget(proxy, "a"))

-- arithmetic metamethods on a vector type
local V = {}
V.__index = V
V.__add = function(a, b) return setmetatable({ x = a.x + b.x }, V) end
V.__mul = function(a, b)
  if type(a) == "number" then return setmetatable({ x = a * b.x }, V) end
  return setmetatable({ x = a.x * b }, V)
end
V.__unm = function(a) return setmetatable({ x = -a.x }, V) end
V.__eq = function(a, b) return a.x == b.x end
V.__lt = function(a, b) return a.x < b.x end
V.__le = function(a, b) return a.x <= b.x end
V.__concat = function(a, b)
  local ax = type(a) == "table" and a.x or a
  local bx = type(b) == "table" and b.x or b
  return ax .. "|" .. bx
end
V.__tostring = function(a) return "V(" .. a.x .. ")" end
V.__call = function(self, k) return self.x * k end
local v1 = setmetatable({ x = 3 }, V)
local v2 = setmetatable({ x = 4 }, V)
print((v1 + v2).x, (2 * v1).x, (-v1).x)
print(v1 == v2, v1 == setmetatable({ x = 3 }, V), v1 < v2, v1 <= v2, v2 <= v1)
print(v1 .. v2, v1 .. "end", "start" .. v2)
print(tostring(v1), v1(10))

-- __metatable protection
local locked = setmetatable({}, { __metatable = "LOCKED" })
print(getmetatable(locked))
print(pcall(setmetatable, locked, {}))

-- getmetatable / type checks
print(getmetatable("abc") ~= nil, getmetatable(5))
print(rawequal(v1, v1), rawequal(v1, setmetatable({ x = 3 }, V)))
