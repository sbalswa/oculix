from java.lang import System
from io.github.julienmerconsulting.legerix import Legerix
from org.sikuli.basics import Settings
from org.sikuli.script import App, Key, Screen
from org.sikuli.support import Commons

import os
import time


EXPECTED_RESULT = "238"
WINDOW_TITLE = "Calculator"


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


def configure_ocr_natives():
    native_path = Legerix.loadNatives().toString()
    Commons.jnaPathAdd(native_path)
    print("calculator: OCR native path = %s" % native_path)


screen = Screen()

try:
    configure_ocr_natives()
    Settings.OcrTextRead = True
    Settings.OcrTextSearch = True

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
    seven = window.existsText("7", 10)
    if seven is None:
        raise AssertionError("OCR could not locate the calculator's 7 button.")

    seven.click()
    window.type("*34")
    window.type(Key.ENTER)

    result = window.existsText(EXPECTED_RESULT, 10)
    if result is None:
        text = window.text()
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
