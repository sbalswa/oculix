from java.lang import RuntimeException
from org.sikuli.basics import Settings
from org.sikuli.script import Pattern, Region, Screen

import os
import time


EXPECTED_CAPABILITY = "ubuntu-chromium"
EXPECTED_RESULT = "238"
CONTROL_IMAGES = {
    "clear": "clear.png",
    "seven": "seven.png",
    "multiply": "multiply.png",
    "three": "three.png",
    "four": "four.png",
    "equals": "equals.png",
}


def capability():
    selected_os = os.environ.get("E2E_OS")
    selected_browser = os.environ.get("E2E_BROWSER")
    selected_capability = os.environ.get("OCULIX_WEB_CALCULATOR_CAPABILITY")
    expected = "%s-%s" % (selected_os, selected_browser)

    if selected_capability != expected:
        raise AssertionError(
            "Capability inputs disagree: %r != %r"
            % (selected_capability, expected)
        )
    if selected_capability != EXPECTED_CAPABILITY:
        raise AssertionError(
            "Unsupported Oculix web-calculator capability: %r"
            % selected_capability
        )
    return selected_capability


def asset_path(selected_capability, image):
    bundle = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(bundle, "assets", selected_capability, image)


def find_control(screen, selected_capability, name):
    image = asset_path(selected_capability, CONTROL_IMAGES[name])
    match = screen.exists(Pattern(image).similar(0.82), 10)
    if match is None:
        raise AssertionError(
            "Image matching could not locate the web calculator's %s control "
            "using %s." % (name, image)
        )
    return match


def result_region(controls):
    clear = controls["clear"]
    multiply = controls["multiply"]
    left = clear.getX()
    top = clear.getY() - 84
    right = multiply.getX() + multiply.getW()
    return Region(left, top, right - left, 72)


def wait_for_result(region):
    text = ""
    for _ in range(20):
        text = region.text()
        if EXPECTED_RESULT in text:
            return text
        time.sleep(0.5)
    return text


def capture_failure(screen, stage):
    diagnostics = os.environ.get(
        "OCULIX_WEB_CALCULATOR_DIAGNOSTICS",
        os.path.join(os.getcwd(), "oculix-web-calculator-diagnostics"),
    )
    if not os.path.isdir(diagnostics):
        os.makedirs(diagnostics)

    screenshot = screen.capture().getFile(
        diagnostics,
        "oculix-web-calculator-error",
    )
    details = os.path.join(diagnostics, "oculix-stage.txt")
    with open(details, "w") as output:
        output.write("Failure stage: %s\n" % stage)
    print("web-calculator: failure stage = %s" % stage)
    print("web-calculator: failure screenshot = %s" % screenshot)


screen = Screen()
stage = "capability validation"

try:
    selected_capability = capability()
    Settings.OcrTextRead = True
    Settings.OcrTextSearch = True

    controls = {}
    for name in ("clear", "seven", "multiply", "three", "four", "equals"):
        stage = "image matching: %s" % name
        controls[name] = find_control(screen, selected_capability, name)

    for name in ("clear", "seven", "multiply", "three", "four", "equals"):
        stage = "visible interaction: %s" % name
        controls[name].click()
        time.sleep(0.1)

    stage = "OCR result verification"
    text = wait_for_result(result_region(controls))
    if EXPECTED_RESULT not in text:
        raise AssertionError(
            "Expected web calculator result %s; OCR read: %r"
            % (EXPECTED_RESULT, text)
        )

    print(
        "web-calculator: %s verified clear, 7 * 34 = %s"
        % (selected_capability, EXPECTED_RESULT)
    )
except (Exception, RuntimeException):
    try:
        capture_failure(screen, stage)
    except (Exception, RuntimeException):
        print(
            "web-calculator: could not capture diagnostics for stage %s"
            % stage
        )
    raise
