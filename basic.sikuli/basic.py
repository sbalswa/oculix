from org.sikuli.script import Screen

print("hello from oculix")

scr = Screen()
bounds = scr.getBounds()
print("oculix: primary screen = %dx%d at (%d,%d)" % (bounds.width, bounds.height, bounds.x, bounds.y))
print("oculix: screen count = %d" % Screen.getNumberScreens())
