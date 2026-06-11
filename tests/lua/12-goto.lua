-- goto and labels (LuaJIT supports the 5.2 extension)
do
  local i = 1
  ::top::
  io.write(i, " ")
  i = i + 1
  if i <= 3 then goto top end
  io.write("\n")
end

-- goto continue pattern
for i = 1, 6 do
  if i % 2 == 0 then goto continue end
  io.write(i, " ")
  ::continue::
end
io.write("\n")

-- forward jump out of nested blocks
do
  for i = 1, 3 do
    if i == 2 then goto done end
    io.write("n", i, " ")
  end
  ::done::
  io.write("jumped\n")
end

-- goto skipping over code
do
  goto skip
  io.write("never\n")
  ::skip::
  io.write("skipped\n")
end
