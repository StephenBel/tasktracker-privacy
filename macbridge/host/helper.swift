// mb-input: injects mouse and keyboard events on macOS.
//
// Reads one JSON command per line on stdin (coordinates are global display
// points, origin at the top-left corner of the primary display):
//   {"t":"click","x":10,"y":20,"b":0,"n":1}    b: 0 left, 1 right; n: click count
//   {"t":"down"|"drag"|"up","x":10,"y":20}     left-button drag
//   {"t":"scroll","x":10,"y":20,"dx":0,"dy":-40}  pixels
//   {"t":"text","s":"Привет"}
//   {"t":"key","k":"Enter","m":["cmd","shift"]}
// Writes {"trusted":true|false} to stdout: whether macOS allows this process
// to post events (System Settings > Privacy & Security > Accessibility).
//
// Build: swiftc -O helper.swift -o bin/mb-input   (npm run build:helper)

import CoreGraphics
import Foundation

setvbuf(stdout, nil, _IOLBF, 0)

let source = CGEventSource(stateID: .hidSystemState)
let tap = CGEventTapLocation.cghidEventTap

func emit(_ object: [String: Any]) {
  if let data = try? JSONSerialization.data(withJSONObject: object),
    let line = String(data: data, encoding: .utf8)
  {
    print(line)
  }
}

var trusted = CGPreflightPostEventAccess()
if !trusted && CommandLine.arguments.contains("--prompt") {
  trusted = CGRequestPostEventAccess()
}
emit(["trusted": trusted])

// MARK: mouse

func mouse(_ type: CGEventType, _ point: CGPoint, _ button: CGMouseButton, clicks: Int64 = 1) {
  guard
    let event = CGEvent(
      mouseEventSource: source, mouseType: type, mouseCursorPosition: point, mouseButton: button)
  else { return }
  event.setIntegerValueField(.mouseEventClickState, value: clicks)
  event.post(tap: tap)
}

func click(_ point: CGPoint, right: Bool, count: Int64) {
  mouse(.mouseMoved, point, .left)
  usleep(4000)
  if right {
    mouse(.rightMouseDown, point, .right, clicks: count)
    usleep(8000)
    mouse(.rightMouseUp, point, .right, clicks: count)
  } else {
    mouse(.leftMouseDown, point, .left, clicks: count)
    usleep(8000)
    mouse(.leftMouseUp, point, .left, clicks: count)
  }
}

var lastScrollPoint = CGPoint(x: -1, y: -1)

func scroll(_ point: CGPoint, dx: Double, dy: Double) {
  // The scroll goes to whatever is under the cursor, so park the cursor there.
  if abs(point.x - lastScrollPoint.x) > 1 || abs(point.y - lastScrollPoint.y) > 1 {
    mouse(.mouseMoved, point, .left)
    lastScrollPoint = point
  }
  guard
    let event = CGEvent(
      scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2,
      wheel1: Int32(dy.rounded()), wheel2: Int32(dx.rounded()), wheel3: 0)
  else { return }
  event.post(tap: tap)
}

// MARK: keyboard

let namedKeys: [String: CGKeyCode] = [
  "Enter": 36, "Tab": 48, "Space": 49, "Backspace": 51, "Escape": 53, "Delete": 117,
  "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126,
  "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
]

// ANSI layout virtual key codes, used for shortcuts such as Cmd+C.
let charKeys: [Character: CGKeyCode] = [
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11,
  "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21,
  "6": 22, "5": 23, "=": 24, "9": 25, "7": 26, "-": 27, "8": 28, "0": 29, "]": 30, "o": 31,
  "u": 32, "[": 33, "i": 34, "p": 35, "l": 37, "j": 38, "'": 39, "k": 40, ";": 41, "\\": 42,
  ",": 43, "/": 44, "n": 45, "m": 46, ".": 47, "`": 50, " ": 49,
]

func flags(_ modifiers: [String]) -> CGEventFlags {
  var result: CGEventFlags = []
  for name in modifiers {
    switch name {
    case "cmd": result.insert(.maskCommand)
    case "alt": result.insert(.maskAlternate)
    case "ctrl": result.insert(.maskControl)
    case "shift": result.insert(.maskShift)
    default: break
    }
  }
  return result
}

func typeText(_ text: String) {
  for character in text {
    if character == "\n" || character == "\r" || character == "\r\n" {
      key("Enter", [])
      continue
    }
    if character == "\t" {
      key("Tab", [])
      continue
    }
    let units = Array(String(character).utf16)
    for down in [true, false] {
      guard let event = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down) else {
        continue
      }
      event.flags = []
      event.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      event.post(tap: tap)
    }
    usleep(1500)
  }
}

func key(_ name: String, _ modifiers: [String]) {
  var code = namedKeys[name]
  if code == nil, let character = name.lowercased().first {
    code = charKeys[character]
  }
  guard let keyCode = code else {
    // A character that has no key on the ANSI layout: type it as text.
    if modifiers.isEmpty || modifiers == ["shift"] { typeText(name) }
    return
  }
  var eventFlags = flags(modifiers)
  if (123...126).contains(keyCode) {
    eventFlags.insert(.maskNumericPad)
    eventFlags.insert(.maskSecondaryFn)
  }
  for down in [true, false] {
    guard let event = CGEvent(keyboardEventSource: source, virtualKey: keyCode, keyDown: down)
    else { continue }
    event.flags = eventFlags
    event.post(tap: tap)
    usleep(2000)
  }
}

// MARK: command loop

func number(_ value: Any?) -> Double {
  return (value as? NSNumber)?.doubleValue ?? 0
}

while let line = readLine(strippingNewline: true) {
  guard let data = line.data(using: .utf8),
    let command = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
    let type = command["t"] as? String
  else { continue }

  let point = CGPoint(x: number(command["x"]), y: number(command["y"]))
  switch type {
  case "click":
    click(
      point, right: number(command["b"]) == 1, count: Int64(max(1, min(3, number(command["n"])))))
  case "down":
    mouse(.mouseMoved, point, .left)
    usleep(4000)
    mouse(.leftMouseDown, point, .left)
  case "drag":
    mouse(.leftMouseDragged, point, .left)
  case "up":
    mouse(.leftMouseUp, point, .left)
  case "scroll":
    scroll(point, dx: number(command["dx"]), dy: number(command["dy"]))
  case "text":
    if let text = command["s"] as? String { typeText(text) }
  case "key":
    if let name = command["k"] as? String {
      key(name, command["m"] as? [String] ?? [])
    }
  default:
    break
  }
}
