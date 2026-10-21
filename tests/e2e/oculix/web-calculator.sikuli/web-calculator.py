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
CONTROL_LAYOUT = {
    "seven": (0, 60, 65, 52),
    "multiply": (217, 60, 65, 52),
    "four": (0, 120, 65, 52),
    "three": (145, 180, 65, 52),
    "equals": (145, 240, 137, 52),
}
CONTROL_SEARCH_MARGIN = 6
CALCULATOR_SIDE_MARGIN = 19
CALCULATOR_HEADER_HEIGHT = 104
CALCULATOR_BOTTOM_MARGIN = 19


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
    project_root = os.environ.get("MISE_PROJECT_ROOT")
    if not project_root:
        raise AssertionError("MISE_PROJECT_ROOT is required for visual assets")
    bundle = os.path.join(
        project_root,
        "tests",
        "e2e",
        "oculix",
        "web-calculator.sikuli",
    )
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


def find_anchored_control(clear, selected_capability, name):
    offset_x, offset_y, width, height = CONTROL_LAYOUT[name]
    search = Region(
        clear.getX() + offset_x - CONTROL_SEARCH_MARGIN,
        clear.getY() + offset_y - CONTROL_SEARCH_MARGIN,
        width + (2 * CONTROL_SEARCH_MARGIN),
        height + (2 * CONTROL_SEARCH_MARGIN),
    )
    return find_control(search, selected_capability, name)


def result_region(controls):
    clear = controls["clear"]
    multiply = controls["multiply"]
    left = clear.getX()
    top = clear.getY() - 84
    right = multiply.getX() + multiply.getW()
    return Region(left, top, right - left, 72)


def calculator_region(controls):
    clear = controls["clear"]
    multiply = controls["multiply"]
    equals = controls["equals"]
    left = clear.getX() - CALCULATOR_SIDE_MARGIN
    top = clear.getY() - CALCULATOR_HEADER_HEIGHT
    right = (
        multiply.getX()
        + multiply.getW()
        + CALCULATOR_SIDE_MARGIN
    )
    bottom = (
        equals.getY()
        + equals.getH()
        + CALCULATOR_BOTTOM_MARGIN
    )
    return Region(left, top, right - left, bottom - top)


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

    stage = "image matching: clear"
    clear = find_control(screen, selected_capability, "clear")
    controls = {"clear": clear}
    for name in ("seven", "multiply", "three", "four", "equals"):
        stage = "image matching: %s" % name
        controls[name] = find_anchored_control(
            clear,
            selected_capability,
            name,
        )

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

    diagnostics = os.environ["OCULIX_WEB_CALCULATOR_DIAGNOSTICS"]
    desktop = screen.capture().getFile(
        diagnostics,
        "desktop",
    )
    evidence = screen.capture(calculator_region(controls)).getFile(
        diagnostics,
        "result",
    )
    print("web-calculator: hosted desktop diagnostic = %s" % desktop)
    print("web-calculator: end-user result evidence = %s" % evidence)
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
