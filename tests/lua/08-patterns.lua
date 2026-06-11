-- Lua patterns
print(string.find("hello world", "o"))
print(string.find("hello world", "o", 6))
print(string.find("hello world", "xyz"))
print(string.find("hello", "l+"))
print(string.find("a.b", ".", 1, true))
print(string.find("abc [def]", "%b[]"))
print(string.find("hello", "^he"))
print(string.find("hello", "lo$"))
print(string.find("hello", "^hello$"))
print(string.find("aaa", "a-"))

print(("key=value"):match("(%w+)=(%w+)"))
print(("abc"):match("()b()"))
print(("   trim me   "):match("^%s*(.-)%s*$"))
print(("2026-06-11"):match("(%d+)-(%d+)-(%d+)"))
print(("abcabc"):match("(a%w)%1"))
print(("foo"):match("bar"))
print(("x123y"):match("%a%d+%a"))
print(("[tag]"):match("%[(%a+)%]"))

for w in ("one two three"):gmatch("%a+") do io.write(w, ".") end
io.write("\n")
for k, v in ("a=1,b=2"):gmatch("(%w+)=(%w+)") do io.write(k, ":", v, " ") end
io.write("\n")
local count = 0
for _ in ("abc"):gmatch("") do count = count + 1 end
print("empty gmatch", count)

print(("hello world"):gsub("o", "0"))
print(("hello"):gsub("l", "L", 1))
print(("abc"):gsub("", "-"))
print(("hello world"):gsub("(%w+)", "<%1>"))
print(("swap me"):gsub("(%w+) (%w+)", "%2 %1"))
print(("abc"):gsub("%w", "%0%0"))
print(("a-b-c"):gsub("%-", "+"))
print(("hello"):gsub("l+", { ll = "LL" }))
print(("x=1, y=2"):gsub("(%w+)=(%w+)", function(k, v) return k .. ":" .. (v + 10) end))
print(("keep"):gsub("e+", function() return nil end))
print(("^anchor"):gsub("^%^", "CARET "))

print(("the quick fox"):find("%f[%w]quick"))
print(("THE (quick) fox"):match("%((%a+)%)"))
print(("char %a class"):gsub("%%a", "ALPHA"))

print(("hello"):match(".-l"))
print(("hello"):match(".*l"))
print(("aaa bbb"):match("%s*(%S+)"))
print(("0x1F"):match("0x(%x+)"))
print(("up DOWN"):gsub("%u+", string.lower))
