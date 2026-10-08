from java.lang import System
from org.sikuli.basics import Settings
from org.sikuli.script import App, Key, Pattern, Region, Screen

import os
import time


EXPECTED_RESULT = "238"
WINDOW_TITLE = "Calculator"
BUTTON_IMAGES = {
    "linux": "calculator-7-linux.png",
    "macos": "calculator-7-macos.png",
    "windows": "calculator-7-windows.png",
}
RESULT_REGION = {
    "linux": (0.00, 0.10, 1.00, 0.38),
    "macos": (0.04, 0.15, 0.92, 0.17),
    "windows": (0.08, 0.18, 0.84, 0.18),
}


def platform_name():
    os_name = System.getProperty("os.name").lower()
    if os_name.startswith("mac"):
        return "macos"
    if os_name.startswith("windows"):
        return "windows"
    if os_name.startswith("linux"):
        return "linux"
    raise AssertionError("Unsupported calculator platform: %s" % os_name)


def wait_for_calculator():
    for _ in range(20):
        app = App.focus(WINDOW_TITLE)
        if app.isValid():
            try:
                window = app.window()
                if window is not None and window.getW() > 0 and window.getH() > 0:
                    return window
            except Exception:
                pass
        time.sleep(0.5)
    raise AssertionError("Calculator window did not become available.")


def capture_failure(screen):
    diagnostics = os.path.join(os.getcwd(), "calculator-diagnostics")
    if not os.path.isdir(diagnostics):
        os.makedirs(diagnostics)
    path = screen.capture().getFile(diagnostics, "calculator-error")
    print("calculator: failure screenshot = %s" % path)


def calculator_result_region(window, platform):
    left_ratio, top_ratio, width_ratio, height_ratio = RESULT_REGION[platform]
    return Region(
        window.getX() + int(window.getW() * left_ratio),
        window.getY() + int(window.getH() * top_ratio),
        int(window.getW() * width_ratio),
        int(window.getH() * height_ratio),
    )


def wait_for_result(region):
    text = ""
    for _ in range(20):
        text = region.text()
        if EXPECTED_RESULT in text:
            return text
        time.sleep(0.5)
    return text


screen = Screen()

try:
    Settings.OcrTextRead = True
    Settings.OcrTextSearch = True

    platform = platform_name()
    window = wait_for_calculator()
    print(
        "calculator: %s window = %dx%d at (%d,%d)"
        % (
            System.getProperty("os.name"),
            window.getW(),
            window.getH(),
            window.getX(),
            window.getY(),
        )
    )

    window.type(Key.ESC)
    seven = window.exists(Pattern(BUTTON_IMAGES[platform]).similar(0.80), 10)
    if seven is None:
        raise AssertionError(
            "Image matching could not locate the calculator's 7 button."
        )

    seven.click()
    window.type("*34")
    window.type(Key.ENTER)

    result_region = calculator_result_region(window, platform)
    text = wait_for_result(result_region)
    if EXPECTED_RESULT not in text:
        raise AssertionError(
            "Expected calculator result %s; OCR read: %r"
            % (EXPECTED_RESULT, text)
        )

    print("calculator: verified 7 * 34 = %s" % EXPECTED_RESULT)
except:
    try:
        capture_failure(screen)
    except:
        print("calculator: could not capture failure screenshot")
    raise
