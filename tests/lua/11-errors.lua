-- errors, pcall, xpcall (portable messages only: error(msg, 0) for exact compares)
print(pcall(function() return 1, 2 end))
print(pcall(function() error("plain", 0) end))
print(pcall(error))
print(pcall(error, nil))

-- error with non-string values (identity preserved)
local etab = { code = 42 }
local ok, caught = pcall(function() error(etab) end)
print(ok, caught == etab, caught.code)
print(pcall(function() error(123) end))

-- assert
print(pcall(assert, false))
print(pcall(assert, nil, "custom"))
print(assert(1, 2, 3))
local aok, aerr = pcall(assert, false, { t = 1 })
print(aok, type(aerr), aerr.t)

-- runtime errors are catchable; compare only the trailing message
local function tail(msg) return tostring(msg):match("([^:]*)$") end
local ok2, e2 = pcall(function() return nil + 1 end)
print(ok2, tail(e2))
local ok3, e3 = pcall(function() local x = nil; return x.field end)
print(ok3, tail(e3))
local ok4, e4 = pcall(function() local f = nil; f() end)
print(ok4, tail(e4))
local ok5, e5 = pcall(function() return {} < {} end)
print(ok5, tail(e5))
local ok6, e6 = pcall(function() return "a" .. true end)
print(ok6, tail(e6))
local ok7, e7 = pcall(function() return #5 end)
print(ok7, tail(e7))

-- xpcall
print(xpcall(function() return "fine" end, function(m) return "handled:" .. m end))
print(xpcall(function() error("oops", 0) end, function(m) return "handled:" .. m end))

-- nested pcall
print(pcall(function()
  local ok, err = pcall(error, "inner", 0)
  error("outer:" .. tostring(err), 0)
end))

-- error objects through coroutines
local co = coroutine.create(function() error({ tag = "obj" }) end)
local rok, rerr = coroutine.resume(co)
print(rok, type(rerr), rerr.tag)

-- pcall returns all values
print(pcall(function() return 1, nil, "three" end))
