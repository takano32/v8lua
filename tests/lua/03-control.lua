-- control flow
local n = 0
for i = 1, 10 do n = n + i end
print("sum", n)
for i = 3, 1, -1 do io.write(i, " ") end
io.write("\n")
for i = 1, 2, 0.5 do io.write(i, " ") end
io.write("\n")
for i = 1, 0 do print("never") end

local i = 0
while i < 5 do i = i + 1 end
print("while", i)

i = 0
repeat
  local done = i > 2
  i = i + 1
until done
print("repeat", i)

i = 0
while true do
  i = i + 1
  if i >= 3 then break end
end
print("break", i)

for a = 1, 3 do
  for b = 1, 3 do
    if b == 2 then break end
    io.write(a, ":", b, " ")
  end
end
io.write("\n")

if 0 then print("zero is true") end
if "" then print("empty string is true") end
if not nil then print("not nil") end

local x = 5
if x < 0 then print("neg")
elseif x == 0 then print("zero")
elseif x < 10 then print("small")
else print("big") end
