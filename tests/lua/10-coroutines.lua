-- coroutines
local co = coroutine.create(function(a, b)
  print("start", a, b)
  local c = coroutine.yield(a + b)
  print("got", c)
  local d, e = coroutine.yield(c * 2)
  print("got2", d, e)
  return "fin"
end)
print(coroutine.status(co))
print(coroutine.resume(co, 1, 2))
print(coroutine.status(co))
print(coroutine.resume(co, 10))
print(coroutine.resume(co, "x", "y"))
print(coroutine.status(co))
print(coroutine.resume(co))

-- wrap as generator
local gen = coroutine.wrap(function(n)
  for i = 1, n do coroutine.yield(i * i) end
end)
io.write(gen(4))
io.write(" ", gen(), " ", gen(), " ", gen(), "\n")

-- generic for over a coroutine iterator
local function range(n)
  return coroutine.wrap(function()
    for i = 1, n do coroutine.yield(i) end
  end)
end
for i in range(3) do io.write("r", i, " ") end
io.write("\n")

-- status from inside
local inner
inner = coroutine.create(function()
  print("inner sees self as", coroutine.status(inner))
  coroutine.yield()
end)
coroutine.resume(inner)

-- nested coroutines
local co2 = coroutine.create(function()
  local sub = coroutine.create(function()
    coroutine.yield("subyield")
    return "subdone"
  end)
  print("outer status while sub suspended", coroutine.status(sub))
  print(coroutine.resume(sub))
  print(coroutine.resume(sub))
  coroutine.yield("outeryield")
  return "outerdone"
end)
print(coroutine.resume(co2))
print(coroutine.resume(co2))

-- errors inside coroutines
local bad = coroutine.create(function() error("kaboom", 0) end)
print(coroutine.resume(bad))
print(coroutine.status(bad))
local wbad = coroutine.wrap(function() error("wrapped", 0) end)
print(pcall(wbad))

-- yield across nested function calls
local deep = coroutine.wrap(function()
  local function a() coroutine.yield("from a") end
  local function b() a() end
  b()
  return "deep done"
end)
print(deep())
print(deep())

-- values both directions
local sum = coroutine.wrap(function(acc)
  while true do
    local v = coroutine.yield(acc)
    acc = acc + v
  end
end)
print(sum(0), sum(5), sum(10), sum(1))

print(coroutine.running() == nil)
