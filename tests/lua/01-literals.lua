-- literals: numbers, strings, escapes, long strings
print(123, 3.14, .5, 5., 1e10, 1E-2, 0xFF, 0x10)
print(2^53, 2^31, -2^63)
print("a\65\66c", "tab\there", "nl[\n]", "q\"q", 'q\'q')
print("\97\098\99")
print("x\
y")
print([[long
string]])
print([==[with ]] inside]==])
print([[no first
newline]] == "no first\nnewline")
print(#"hello", #[[ab]])
print(0.1, 1/3, 1e100, 1e-5, 100, -42.25)
print(10 == 10.0, "10" == 10)
