-- a small real program: sieve, memoized fib, OOP, coroutine pipeline
-- sieve of eratosthenes
local N = 1000
local sieve = {}
for i = 2, N do sieve[i] = true end
for i = 2, N do
  if sieve[i] then
    for j = i * i, N, i do sieve[j] = nil end
  end
end
local count, sum = 0, 0
for i = 2, N do
  if sieve[i] then count = count + 1 sum = sum + i end
end
print("primes", count, sum)

-- memoized fibonacci
local memo = { [0] = 0, [1] = 1 }
local function fib(n)
  if memo[n] then return memo[n] end
  local v = fib(n - 1) + fib(n - 2)
  memo[n] = v
  return v
end
print("fib50", fib(50))

-- OOP class via metatables
local Account = {}
Account.__index = Account
function Account.new(balance)
  return setmetatable({ balance = balance or 0 }, Account)
end
function Account:deposit(v) self.balance = self.balance + v end
function Account:withdraw(v)
  if v > self.balance then error("insufficient funds", 0) end
  self.balance = self.balance - v
end
local Savings = setmetatable({}, { __index = Account })
Savings.__index = Savings
function Savings.new(balance, rate)
  local a = Account.new(balance)
  a.rate = rate
  return setmetatable(a, Savings)
end
function Savings:addInterest() self.balance = self.balance * (1 + self.rate) end

local acc = Account.new(100)
acc:deposit(50)
acc:withdraw(30)
print("balance", acc.balance)
print(pcall(acc.withdraw, acc, 1000))
local sav = Savings.new(200, 0.1)
sav:deposit(100)
sav:addInterest()
print("savings", sav.balance)

-- coroutine pipeline: producer -> filter -> consumer
local function producer(n)
  return coroutine.wrap(function()
    for i = 1, n do coroutine.yield(i) end
  end)
end
local function filter(src)
  return coroutine.wrap(function()
    for v in src do
      if v % 3 == 0 then coroutine.yield(v * v) end
    end
  end)
end
local total = 0
for v in filter(producer(20)) do total = total + v end
print("pipeline", total)

-- string building checksum
local parts = {}
for i = 1, 100 do parts[#parts + 1] = tostring(i * 7 % 13) end
local s = table.concat(parts, "")
local check = 0
for i = 1, #s do check = check + s:byte(i) * i end
print("checksum", #s, check)
