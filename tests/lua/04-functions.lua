-- functions: closures, varargs, multiple returns, tail calls
local function add(a, b) return a + b end
print(add(2, 3), add("4", "5"))

local function multi() return 1, 2, 3 end
print(multi())
print((multi()))
local a, b, c, d = multi()
print(a, b, c, d)
print(multi(), multi())
local t = { multi(), multi() }
print(#t)

local function varargs(...)
  local n = select("#", ...)
  return n, ...
end
print(varargs("x", "y", "z"))
print(varargs())
print(select(2, "a", "b", "c"))
print(select(-1, "a", "b", "c"))

local function forward(...) return varargs(...) end
print(forward(7, nil, 9))

-- closures share upvalues
local function make()
  local n = 0
  local function inc() n = n + 1 return n end
  local function get() return n end
  return inc, get
end
local inc, get = make()
inc(); inc()
print("shared", get())

-- per-iteration loop captures
local fns = {}
for i = 1, 3 do fns[i] = function() return i end end
print(fns[1](), fns[2](), fns[3]())

-- recursion + tail calls
local function loop(k) if k == 0 then return "done" end return loop(k - 1) end
print(loop(1000000))

local function fib(k) if k < 2 then return k end return fib(k - 1) + fib(k - 2) end
print("fib", fib(20))

-- method definitions and calls
local obj = { v = 10 }
function obj:getv() return self.v end
function obj.raw(x) return x * 2 end
print(obj:getv(), obj.raw(21))
